// One hop of second-brain neighbors for retrieved passages. The graph stores
// edges, not text, so neighbor ids are resolved through the brain's own index.
//
// Only `pathcite` and `sequence` edges are used. `same_dir` says two files share
// a folder, which is not evidence of a useful relation.

import type { Logger } from "../log.ts";
import type { XerjClient } from "../node/client.ts";
import type { BrainSpec } from "../paths.ts";
import type { SearchHit } from "./service.ts";

export interface BrainGraphOptions {
  readonly client: XerjClient;
  readonly brains: ReadonlyArray<BrainSpec>;
  readonly logger: Logger;
}

export interface NeighborRef {
  readonly id: string;
  readonly type: string;
}

const ALLOWED_TYPES = new Set(["pathcite", "sequence"]);
/** Cross-file references only: the flow order between sections is not evidence. */
const PATHCITE_ONLY = new Set(["pathcite"]);
const TYPE_PRIORITY: Record<string, number> = { pathcite: 0, sequence: 1 };
const MAX_NEIGHBORS = 2;
const MAX_TEXT_CHARS = 600;
const SOURCE_FIELDS = ["path", "ax_path", "title", "start_line", "kind", "body"];

export class BrainGraph {
  constructor(private readonly options: BrainGraphOptions) {}

  /** Neighbor passages for brain hits, capped at two per query. */
  async related(
    hits: ReadonlyArray<SearchHit>,
    signal?: AbortSignal,
  ): Promise<SearchHit[]> {
    const groups = new Map<string, { spec: BrainSpec; seeds: string[] }>();

    for (const hit of hits) {
      const spec = this.specFor(hit.index);
      if (!spec || hit.id.length === 0) continue;

      const group = groups.get(spec.name) ?? { spec, seeds: [] };
      if (!group.seeds.includes(hit.id)) group.seeds.push(hit.id);
      groups.set(spec.name, group);
    }

    const related: SearchHit[] = [];
    for (const group of groups.values()) {
      if (related.length >= MAX_NEIGHBORS) break;
      const found = await this.expand(
        group.spec,
        group.seeds.slice(0, 2),
        MAX_NEIGHBORS - related.length,
        signal,
      );
      related.push(...found);
    }

    return related;
  }

  private specFor(index: string): BrainSpec | undefined {
    return this.options.brains.find((spec) => {
      // A project-wide brain shares its prefix with the hidden corpus, whose
      // documents are not graph nodes and cannot be expanded.
      if (index.startsWith(`${spec.prefix}-hidden-`)) return false;
      return index.startsWith(`${spec.prefix}-`);
    });
  }

  private async expand(
    spec: BrainSpec,
    seeds: ReadonlyArray<string>,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SearchHit[]> {
    // The ego endpoint accepts one node per request; a comma-joined list
    // answers with no edges. Query each seed and merge the edges.
    const edges: unknown[] = [];
    for (const seed of seeds) {
      const path =
        `/_graph/${encodeURIComponent(spec.name)}` +
        `/ego?node=${encodeURIComponent(seed)}&hops=1&direction=both`;
      const ego = await this.options.client
        .get(path, "graph query failed", signal)
        .catch((error: unknown) => {
          this.options.logger.debug("brain expansion skipped", String(error));
          return null;
        });
      if (!isRecord(ego) || !Array.isArray(ego.edges)) continue;
      edges.push(...ego.edges);
    }

    const allowed = spec.pathciteOnly === true ? PATHCITE_ONLY : ALLOWED_TYPES;
    const neighbors = pickNeighbors({ edges }, seeds, limit, allowed);
    if (neighbors.length === 0) return [];

    const response = await this.options.client
      .search(
        `${spec.prefix}-docs`,
        {
          size: neighbors.length,
          _source: SOURCE_FIELDS,
          query: { ids: { values: neighbors.map((neighbor) => neighbor.id) } },
        },
        signal,
      )
      .catch((error: unknown) => {
        this.options.logger.debug("brain neighbor fetch skipped", String(error));
        return null;
      });

    const direct = parseNeighbors(response, neighbors);

    // A `pathcite` points at the target file's whole-file record, which has no
    // `body`; only its section records carry text. Fetch the first section so
    // the neighbor is usable.
    const missing = bodylessPaths(response, neighbors, direct);
    const sections = await this.fetchSections(spec, missing, signal);
    return [...direct, ...sections].slice(0, limit);
  }

  private async fetchSections(
    spec: BrainSpec,
    missing: ReadonlyArray<{ path: string; type: string }>,
    signal?: AbortSignal,
  ): Promise<SearchHit[]> {
    const found: SearchHit[] = [];
    for (const entry of missing) {
      if (found.length >= MAX_NEIGHBORS) break;
      const response = await this.options.client
        .search(
          `${spec.prefix}-docs`,
          {
            size: 1,
            sort: [{ start_line: "asc" }],
            _source: SOURCE_FIELDS,
            query: {
              bool: {
                must: [
                  { term: { ax_path: entry.path } },
                  { exists: { field: "body" } },
                ],
              },
            },
          },
          signal,
        )
        .catch((error: unknown) => {
          this.options.logger.debug("brain section fetch skipped", String(error));
          return null;
        });

      const hit = firstHit(response, entry.type);
      if (hit) found.push(hit);
    }
    return found;
  }
}

/** Chooses allowed edge types, preferring explicit citations. */
export function pickNeighbors(
  ego: unknown,
  seeds: ReadonlyArray<string>,
  limit: number,
  allowed: ReadonlySet<string> = ALLOWED_TYPES,
): NeighborRef[] {
  if (!isRecord(ego) || !Array.isArray(ego.edges)) return [];
  return rankNeighbors(
    collectNeighbors(ego.edges, new Set(seeds), allowed),
    limit,
  );
}

/** One candidate per neighbor id, skipping the seeds themselves. */
function collectNeighbors(
  edges: ReadonlyArray<unknown>,
  seeds: ReadonlySet<string>,
  allowed: ReadonlySet<string>,
): Array<NeighborRef & { weight: number }> {
  const candidates: Array<NeighborRef & { weight: number }> = [];
  const seen = new Set<string>();

  for (const edge of edges) {
    const candidate = neighborOf(edge, seeds, allowed);
    if (candidate === null || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    candidates.push(candidate);
  }
  return candidates;
}

/** The far end of an allowed, still-valid edge that starts at a seed. */
function neighborOf(
  edge: unknown,
  seeds: ReadonlySet<string>,
  allowed: ReadonlySet<string>,
): (NeighborRef & { weight: number }) | null {
  if (!isRecord(edge)) return null;
  if (edge.invalid_at !== null && edge.invalid_at !== undefined) return null;

  const type = typeof edge.type === "string" ? edge.type : "";
  if (!allowed.has(type)) return null;

  const src = typeof edge.src === "string" ? edge.src : "";
  const dst = typeof edge.dst === "string" ? edge.dst : "";
  const other = seeds.has(src) ? dst : seeds.has(dst) ? src : "";
  if (other.length === 0 || seeds.has(other)) return null;

  return {
    id: other,
    type,
    weight: typeof edge.weight === "number" ? edge.weight : 0,
  };
}

/** Citations first, then the strongest edge, then the caller's limit. */
function rankNeighbors(
  candidates: ReadonlyArray<NeighborRef & { weight: number }>,
  limit: number,
): NeighborRef[] {
  return [...candidates]
    .sort(
      (left, right) =>
        (TYPE_PRIORITY[left.type] ?? 9) - (TYPE_PRIORITY[right.type] ?? 9) ||
        right.weight - left.weight,
    )
    .slice(0, limit)
    .map(({ id, type }) => ({ id, type }));
}

/** Neighbor docs that were fetched but carry no text, with their file path. */
function bodylessPaths(
  response: unknown,
  neighbors: ReadonlyArray<NeighborRef>,
  parsed: ReadonlyArray<SearchHit>,
): Array<{ path: string; type: string }> {
  const found = new Map<string, string>();
  for (const hit of hitsOf(response)) {
    if (!isRecord(hit)) continue;
    const id = stringValue(hit._id) ?? "";
    if (id.length === 0) continue;
    const source = isRecord(hit._source) ? hit._source : {};
    const path = stringValue(source.ax_path) ?? stringValue(source.path);
    if (path !== null && path.length > 0) found.set(id, path);
  }

  const done = new Set(parsed.map((hit) => hit.id));
  const result: Array<{ path: string; type: string }> = [];
  for (const neighbor of neighbors) {
    if (done.has(neighbor.id)) continue;
    const path = found.get(neighbor.id);
    if (path) result.push({ path, type: neighbor.type });
  }
  return result;
}

function firstHit(response: unknown, type: string): SearchHit | null {
  for (const raw of hitsOf(response)) {
    if (!isRecord(raw)) continue;
    const source = isRecord(raw._source) ? raw._source : {};
    const text = stringValue(source.body) ?? stringValue(source.code) ?? "";
    if (text.trim().length === 0) continue;

    return {
      index: stringValue(raw._index) ?? "",
      id: stringValue(raw._id) ?? "",
      passage: 0,
      path: stringValue(source.ax_path) ?? stringValue(source.path) ?? null,
      line: numberValue(source.start_line),
      title: stringValue(source.title),
      kind: `via ${type}`,
      score: 0,
      text: clip(text.trim()),
    };
  }
  return null;
}

function parseNeighbors(
  response: unknown,
  neighbors: ReadonlyArray<NeighborRef>,
): SearchHit[] {
  const byId = new Map(neighbors.map((neighbor) => [neighbor.id, neighbor.type]));
  const parsed: SearchHit[] = [];

  for (const raw of hitsOf(response)) {
    if (!isRecord(raw)) continue;
    const id = stringValue(raw._id) ?? "";
    const via = byId.get(id);
    if (!via) continue;

    const source = isRecord(raw._source) ? raw._source : {};
    const text = stringValue(source.body) ?? stringValue(source.code) ?? "";
    if (text.trim().length === 0) continue;

    parsed.push({
      index: stringValue(raw._index) ?? "",
      id,
      passage: 0,
      path: stringValue(source.ax_path) ?? stringValue(source.path) ?? null,
      line: numberValue(source.start_line),
      title: stringValue(source.title),
      kind: `via ${via}`,
      score: 0,
      text: clip(text.trim()),
    });
  }

  return parsed;
}

function hitsOf(response: unknown): unknown[] {
  if (!isRecord(response)) return [];
  const hits = response.hits;
  if (!isRecord(hits) || !Array.isArray(hits.hits)) return [];
  return hits.hits;
}

function clip(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;

  const cut = text.slice(0, MAX_TEXT_CHARS);
  const lastNewline = cut.lastIndexOf("\n");
  return lastNewline > MAX_TEXT_CHARS / 2
    ? `${cut.slice(0, lastNewline)}\n…`
    : `${cut}\n…`;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
