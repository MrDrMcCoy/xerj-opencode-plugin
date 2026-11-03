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
const TYPE_PRIORITY: Record<string, number> = { pathcite: 0, sequence: 1 };
const MAX_NEIGHBORS = 2;
const MAX_TEXT_CHARS = 600;

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
    return this.options.brains.find((spec) => index.startsWith(`${spec.prefix}-`));
  }

  private async expand(
    spec: BrainSpec,
    seeds: ReadonlyArray<string>,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SearchHit[]> {
    const query = seeds.map((id) => encodeURIComponent(id)).join(",");
    const path =
      `/_graph/${encodeURIComponent(spec.name)}` +
      `/ego?node=${query}&hops=1&direction=both`;
    const ego = await this.options.client
      .get(path, "graph query failed", signal)
      .catch((error: unknown) => {
        this.options.logger.debug("brain expansion skipped", String(error));
        return null;
      });

    const neighbors = pickNeighbors(ego, seeds, limit);
    if (neighbors.length === 0) return [];

    const response = await this.options.client
      .search(
        `${spec.prefix}-docs`,
        {
          size: neighbors.length,
          _source: ["path", "ax_path", "title", "start_line", "kind", "body"],
          query: { ids: { values: neighbors.map((neighbor) => neighbor.id) } },
        },
        signal,
      )
      .catch((error: unknown) => {
        this.options.logger.debug("brain neighbor fetch skipped", String(error));
        return null;
      });

    return parseNeighbors(response, neighbors);
  }
}

/** Chooses allowed edge types, preferring explicit citations. */
export function pickNeighbors(
  ego: unknown,
  seeds: ReadonlyArray<string>,
  limit: number,
): NeighborRef[] {
  if (!isRecord(ego) || !Array.isArray(ego.edges)) return [];

  const seedSet = new Set(seeds);
  const candidates: Array<NeighborRef & { weight: number }> = [];
  const seen = new Set<string>();

  for (const edge of ego.edges) {
    if (!isRecord(edge)) continue;
    if (edge.invalid_at !== null && edge.invalid_at !== undefined) continue;

    const type = typeof edge.type === "string" ? edge.type : "";
    if (!ALLOWED_TYPES.has(type)) continue;

    const src = typeof edge.src === "string" ? edge.src : "";
    const dst = typeof edge.dst === "string" ? edge.dst : "";
    const other = seedSet.has(src) ? dst : seedSet.has(dst) ? src : "";
    if (other.length === 0 || seedSet.has(other) || seen.has(other)) continue;

    seen.add(other);
    candidates.push({
      id: other,
      type,
      weight: typeof edge.weight === "number" ? edge.weight : 0,
    });
  }

  return candidates
    .sort(
      (left, right) =>
        (TYPE_PRIORITY[left.type] ?? 9) - (TYPE_PRIORITY[right.type] ?? 9) ||
        right.weight - left.weight,
    )
    .slice(0, limit)
    .map(({ id, type }) => ({ id, type }));
}

function parseNeighbors(
  response: unknown,
  neighbors: ReadonlyArray<NeighborRef>,
): SearchHit[] {
  if (!isRecord(response)) return [];
  const hits = response.hits;
  if (!isRecord(hits) || !Array.isArray(hits.hits)) return [];

  const byId = new Map(neighbors.map((neighbor) => [neighbor.id, neighbor.type]));
  const parsed: SearchHit[] = [];

  for (const raw of hits.hits) {
    if (!isRecord(raw)) continue;
    const id = typeof raw._id === "string" ? raw._id : "";
    const via = byId.get(id);
    if (!via) continue;

    const source = isRecord(raw._source) ? raw._source : {};
    const text = stringValue(source.body) ?? stringValue(source.code) ?? "";
    if (text.trim().length === 0) continue;

    parsed.push({
      index: typeof raw._index === "string" ? raw._index : "",
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
