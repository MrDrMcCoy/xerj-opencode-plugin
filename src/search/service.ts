// Query construction, result parsing, and passage formatting.
//
// Verified against v1.0.0-rc.100:
// - `fields: ["_passage"]` returns the matching chunk without the whole
//   `_source`. It is refused for `hybrid` queries because fusion has no single
//   winning passage, so the two legs are run separately and fused here.
// - `_passage` carries byte offsets, not line numbers. When the record starts at
//   line 1 the offset maps onto the file, so the exact line is readable. A
//   section record that starts elsewhere falls back to its start line.

import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Logger } from "../log.ts";
import { XerjClient } from "../node/client.ts";
import type { BrainSpec } from "../paths.ts";
import type { BrainGraph } from "./brains.ts";
import { demoteGenerated, dropGenerated, dropUncovered } from "./rank.ts";

export interface SearchHit {
  readonly index: string;
  readonly id: string;
  readonly passage: number;
  readonly path: string | null;
  readonly line: number | null;
  readonly title: string | null;
  readonly kind: string | null;
  readonly score: number;
  readonly text: string;
}

export interface SearchResult {
  readonly hits: ReadonlyArray<SearchHit>;
  readonly bytes: number;
  readonly text: string;
  readonly strategy: "hybrid" | "lexical" | "semantic" | "definition";
  readonly narrowingBytes: number;
}

/**
 * Where the results go. Injection shares a small budget across a whole turn,
 * so it is stricter than an explicit tool call about generated files.
 */
export type SearchSurface = "context" | "tool";

export interface SearchOptions {
  readonly surface?: SearchSurface;
  readonly k?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

export interface ParsedHit extends SearchHit {
  readonly startLine: number | null;
  readonly startOffset: number;
}

const MAX_K = 50;
const MAPPING_TTL_MS = 60_000;
const RRF_K = 60;
const MAX_RESOLVED_FILE_BYTES = 512 * 1024;
const SOURCE_FIELDS = [
  "ax_path",
  "path",
  "title",
  "name",
  "kind",
  "language",
  "start_line",
  "end_line",
  "line",
  "section",
];
// Symbol records carry `code` but no `body`; file records carry the whole file
// in `body`. Only `body` produces a `_passage`, so the search leg stays on it
// and symbol precision comes from the definition tool.
const TEXT_FIELD_PRIORITY = ["body", "defs", "impl", "summary", "text", "content"];
const DEFINITION_SOURCE = [...SOURCE_FIELDS, "code"];

interface LegResult {
  readonly hits: ReadonlyArray<ParsedHit>;
  readonly narrowing: number;
}

export class SearchService {
  private mappingCache: {
    at: number;
    indices: Record<string, Record<string, string>>;
  } | null = null;
  private readonly files = new Map<string, string | null>();

  constructor(
    private readonly client: XerjClient,
    private readonly prefixes: ReadonlyArray<string>,
    private readonly logger: Logger,
    private readonly projectRoot: string,
    private readonly brains: BrainGraph | null = null,
    private readonly brainSpecs: ReadonlyArray<BrainSpec> = [],
    private readonly hiddenIndex: string | null = null,
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return emptyResult("lexical");

    const k = clamp(options.k ?? 8, 1, MAX_K);
    const budget = budgetChars(options.maxTokens);
    const indices = await this.indices();
    const names = Object.keys(indices);
    const pattern =
      names.length > 0
        ? names.join(",")
        : this.prefixes.map((prefix) => `${prefix}-*`).join(",");
    const fields = pickTextFields(indices);
    const semanticCapable = names.some((name) => indices[name]?.body === "semantic_text");

    const base = { size: k, _source: SOURCE_FIELDS, fields: ["_passage"] };

    // A single-field `match` is what makes the engine attach `_passage`;
    // `multi_match` returns hits without it, which silently drops the text.
    const lexicalField = fields.includes("body") ? "body" : (fields[0] ?? "body");
    const lexical = await this.leg(
      pattern,
      { ...base, query: { match: { [lexicalField]: trimmed } } },
      options.signal,
    );

    let semantic: LegResult | null = null;
    if (semanticCapable) {
      try {
        semantic = await this.leg(
          pattern,
          { ...base, query: { semantic: { field: "body", query: trimmed, k } } },
          options.signal,
        );
      } catch (error) {
        this.logger.debug("semantic leg failed; keeping lexical only", String(error));
      }
    }

    const strategy = semantic ? "hybrid" : "lexical";
    const fused = semantic ? fuse([lexical.hits, semantic.hits], k) : lexical.hits.slice(0, k);
    const ranked = demoteGenerated(this.locateBrainPaths(fused), trimmed);
    const located =
      options.surface === "context"
        ? dropUncovered(dropGenerated(ranked, trimmed), trimmed)
        : ranked;
    const resolved = await this.resolveLines(located, trimmed);
    const hits = dropShadowedWholeFiles(
      resolved,
      this.hiddenIndex,
      this.brainSpecs,
    );
    const related = this.brains ? await this.brains.related(hits, options.signal) : [];
    const narrowing = lexical.narrowing + (semantic?.narrowing ?? 0);

    if (related.length === 0) {
      return formatResult(hits, strategy, budget, narrowing);
    }

    // Related passages get their own slice: the direct hits already fill the
    // budget on their own, so appending without reserving would hide them.
    const reserve = Math.min(800, Math.floor(budget / 4));
    const direct = formatResult(hits, strategy, budget - reserve, narrowing);
    const extra = formatResult(related, strategy, reserve, 0, hits.length);
    const text = [direct.text, extra.text].filter((part) => part.length > 0).join("\n\n");

    return {
      ...direct,
      hits: dedupeHits([...hits, ...related]),
      text,
      bytes: Buffer.byteLength(text, "utf8"),
    };
  }

  /** Brain documents are relative to the brain folder; cite from the project. */
  private locateBrainPaths(hits: ReadonlyArray<ParsedHit>): ParsedHit[] {
    return hits.map((hit) => {
      if (hit.path === null) return hit;
      const spec = this.brainSpecs.find((candidate) =>
        hit.index.startsWith(`${candidate.prefix}-`),
      );
      if (!spec) return hit;

      return {
        ...hit,
        path: projectDocumentPath(this.projectRoot, spec.directory, hit.path),
      };
    });
  }

  /** Drops the mapping cache; call when a corpus run may have created indices. */
  invalidate(): void {
    this.mappingCache = null;
  }

  async definition(symbol: string, options: SearchOptions = {}): Promise<SearchResult> {
    const trimmed = symbol.trim();
    if (trimmed.length === 0) return emptyResult("definition");

    const k = clamp(options.k ?? 5, 1, MAX_K);
    const budget = budgetChars(options.maxTokens);
    const indices = await this.indices();
    const codeIndices = Object.entries(indices)
      .filter(([, fields]) => "code" in fields || "symbols.name" in fields)
      .map(([name]) => name);

    if (codeIndices.length === 0) return emptyResult("definition");

    const result = await this.leg(
      codeIndices.join(","),
      {
        size: k,
        _source: DEFINITION_SOURCE,
        fields: ["_passage"],
        query: {
          bool: {
            should: [
              { term: { name: trimmed } },
              { match: { "symbols.name": trimmed } },
              { match: { code: trimmed } },
            ],
            minimum_should_match: 1,
          },
        },
      },
      options.signal,
    );

    const hits = await this.resolveLines(result.hits.slice(0, k), trimmed);
    return formatResult(hits, "definition", budget, result.narrowing);
  }

  private async leg(
    pattern: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<LegResult> {
    const response = await this.client.search(pattern, body, signal);
    return {
      hits: parseHits(response),
      narrowing: narrowingBytes(response),
    };
  }

  /**
   * Exact line for a record that starts at line 1: the passage offset indexes
   * the file, so count newlines before it. Section records keep their start
   * line instead of inventing one.
   */
  private async resolveLines(
    hits: ReadonlyArray<ParsedHit>,
    query: string,
  ): Promise<SearchHit[]> {
    return Promise.all(hits.map((hit) => this.resolveLine(hit, query)));
  }

  private async resolveLine(hit: ParsedHit, query: string): Promise<SearchHit> {
    const { startLine, startOffset, text, path } = hit;
    const base: SearchHit = {
      index: hit.index,
      id: hit.id,
      passage: hit.passage,
      path: hit.path,
      line: startLine,
      title: hit.title,
      kind: hit.kind,
      score: hit.score,
      text: hit.text,
    };

    if (startLine === null) return base;

    const inPassage = newlinesBeforeMatch(text, query);
    if (inPassage === null) return base;

    if (startLine === 1 && startOffset > 0 && path) {
      const prefixNewlines = await this.newlinesBeforeOffset(path, startOffset);
      if (prefixNewlines !== null) {
        return { ...base, line: 1 + prefixNewlines + inPassage };
      }
    }

    if (startOffset === 0) {
      return { ...base, line: startLine + inPassage };
    }

    return base;
  }

  private async newlinesBeforeOffset(path: string, offset: number): Promise<number | null> {
    const content = await this.readProjectFile(path);
    if (content === null) return null;

    const bytes = Buffer.from(content, "utf8");
    const limit = Math.min(offset, bytes.length);
    let newlines = 0;
    for (let index = 0; index < limit; index++) {
      if (bytes[index] === 10) newlines += 1;
    }
    return newlines;
  }

  private async readProjectFile(path: string): Promise<string | null> {
    if (this.files.has(path)) return this.files.get(path) ?? null;

    const absolute = this.absolute(path);
    if (absolute === null) {
      this.files.set(path, null);
      return null;
    }

    const content = await readFile(absolute, "utf8").catch(() => null);
    if (content === null || Buffer.byteLength(content, "utf8") > MAX_RESOLVED_FILE_BYTES) {
      this.files.set(path, null);
      return null;
    }

    this.files.set(path, content);
    return content;
  }

  private absolute(path: string): string | null {
    const root = resolve(this.projectRoot);
    const absolute = isAbsolute(path) ? resolve(path) : resolve(join(root, path));
    if (absolute !== root && !absolute.startsWith(root + sep)) return null;
    return absolute;
  }

  /** Mapping cache keyed by the time it was read. */
  private async indices(): Promise<Record<string, Record<string, string>>> {
    if (this.mappingCache && Date.now() - this.mappingCache.at < MAPPING_TTL_MS) {
      return this.mappingCache.indices;
    }

    const merged: Record<string, Record<string, string>> = {};
    for (const prefix of this.prefixes) {
      try {
        Object.assign(merged, await this.client.mappings(`${prefix}-*`));
      } catch (error) {
        // A prefix with no indices answers 404; that is not a failure for the
        // other corpora, so keep going.
        this.logger.debug(`no mappings for ${prefix}`, String(error));
      }
    }

    if (Object.keys(merged).length > 0) {
      this.mappingCache = { at: Date.now(), indices: merged };
      return merged;
    }
    return this.mappingCache?.indices ?? {};
  }
}

/** Reciprocal rank fusion over the legs, deduped by document and passage. */
export function fuse(legs: ReadonlyArray<ReadonlyArray<ParsedHit>>, k: number): ParsedHit[] {
  const merged = new Map<string, ParsedHit>();
  const scores = new Map<string, number>();

  for (const leg of legs) {
    for (const [rank, hit] of leg.entries()) {
      const key = `${hit.index}:${hit.id}:${hit.passage}`;
      if (!merged.has(key)) merged.set(key, hit);
      scores.set(key, (scores.get(key) ?? 0) + 1 / (RRF_K + rank + 1));
    }
  }

  return [...merged.entries()]
    .map(([key, hit]) => ({ ...hit, score: scores.get(key) ?? 0 }))
    .sort((left, right) => right.score - left.score)
    .slice(0, k);
}

/** Prefixes a brain-relative path with the folder's project-relative path. */
export function projectDocumentPath(
  projectRoot: string,
  directory: string,
  path: string,
): string {
  const root = relative(projectRoot, directory).split(sep).join("/");
  if (root.length === 0 || path.startsWith(`${root}/`)) return path;
  return `${root}/${path}`;
}

/**
 * A hidden document is the whole file, so it shadows every section hit from a
 * brain over the same folder. Prefer the section hits: they are more precise
 * and carry graph expansion.
 */
export function dropShadowedWholeFiles(
  hits: ReadonlyArray<SearchHit>,
  hiddenIndex: string | null,
  brainSpecs: ReadonlyArray<BrainSpec>,
): SearchHit[] {
  if (hiddenIndex === null || brainSpecs.length === 0) return [...hits];

  const brainPrefixes = brainSpecs.map((spec) => `${spec.prefix}-`);
  const brainPaths = new Set(
    hits
      .filter(
        (hit) =>
          hit.path !== null &&
          brainPrefixes.some((prefix) => hit.index.startsWith(prefix)),
      )
      .map((hit) => hit.path),
  );

  return hits.filter(
    (hit) =>
      !(hit.index === hiddenIndex && hit.path !== null && brainPaths.has(hit.path)),
  );
}

function dedupeHits(hits: ReadonlyArray<SearchHit>): SearchHit[] {
  const seen = new Set<string>();
  const unique: SearchHit[] = [];

  for (const hit of hits) {
    const key = `${hit.index}:${hit.id}:${hit.passage}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(hit);
  }

  return unique;
}

function pickTextFields(indices: Record<string, Record<string, string>>): string[] {
  const available = new Set<string>();
  for (const fields of Object.values(indices)) {
    for (const [name, type] of Object.entries(fields)) {
      if (type === "text" || type === "semantic_text") available.add(name);
      if (type === "keyword" && name === "title") available.add(name);
    }
  }

  const ordered = TEXT_FIELD_PRIORITY.filter((name) => available.has(name));
  for (const name of available) {
    if (!ordered.includes(name)) ordered.push(name);
  }

  if (ordered.length === 0) return ["body"];
  return ordered;
}

interface RawHit {
  readonly _index?: string;
  readonly _id?: string;
  readonly _score?: number;
  readonly _source?: Record<string, unknown>;
  readonly fields?: Record<string, unknown>;
}

function parseHits(response: unknown): ParsedHit[] {
  if (!isRecord(response)) return [];
  const hits = response.hits;
  if (!isRecord(hits) || !Array.isArray(hits.hits)) return [];

  const parsed: ParsedHit[] = [];
  for (const raw of hits.hits as RawHit[]) {
    if (!isRecord(raw)) continue;
    const source = isRecord(raw._source) ? raw._source : {};
    const passage = readPassage(raw.fields);
    const text = (passage?.text ?? stringValue(source.body) ?? stringValue(source.code) ?? "").trim();
    if (text.length === 0) continue;

    parsed.push({
      index: stringValue(raw._index) ?? "",
      id: stringValue(raw._id) ?? "",
      passage: passage?.ordinal ?? 0,
      path: stringValue(source.ax_path) ?? stringValue(source.path) ?? null,
      line: null,
      title: stringValue(source.title) ?? stringValue(source.name) ?? null,
      kind: stringValue(source.kind) ?? null,
      score: numberValue(raw._score) ?? 0,
      text,
      startLine: numberValue(source.start_line) ?? numberValue(source.line) ?? null,
      startOffset: passage?.startOffset ?? 0,
    });
  }

  return parsed;
}

interface Passage {
  readonly text: string;
  readonly ordinal: number;
  readonly startOffset: number;
}

function readPassage(fields: unknown): Passage | null {
  if (!isRecord(fields)) return null;
  const passages = fields._passage;
  if (!Array.isArray(passages) || passages.length === 0) return null;

  const first = passages[0];
  if (!isRecord(first)) return null;
  const text = stringValue(first.text);
  if (text === null || text.trim().length === 0) return null;
  return {
    text,
    ordinal: numberValue(first.ordinal) ?? 0,
    startOffset: numberValue(first.start_offset) ?? 0,
  };
}

/** Newlines from the passage start to the earliest matching query term. */
export function newlinesBeforeMatch(text: string, query: string): number | null {
  const terms = (query.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []).slice(0, 12);
  if (terms.length === 0) return null;

  const lower = text.toLowerCase();
  let earliest = -1;
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at >= 0 && (earliest === -1 || at < earliest)) earliest = at;
  }

  if (earliest <= 0) return 0;
  let newlines = 0;
  for (let index = 0; index < earliest; index++) {
    if (text.charCodeAt(index) === 10) newlines += 1;
  }
  return newlines;
}

function formatResult(
  hits: ReadonlyArray<SearchHit>,
  strategy: SearchResult["strategy"],
  budget: number,
  narrowing: number,
  startIndex = 0,
): SearchResult {
  const blocks: string[] = [];
  let used = 0;
  // Share the budget across the hits instead of letting the first whole-section
  // match consume it; a 6 KB function should not hide the other three results.
  const perHit = Math.max(400, Math.floor(budget / Math.max(hits.length, 1)));

  for (const [index, hit] of hits.entries()) {
    const location = hit.path ?? hit.index;
    const line = hit.line === null ? "" : `:${hit.line}`;
    const kind = hit.kind === null ? "" : ` [${hit.kind}]`;
    const header = `[${startIndex + index + 1}] ${location}${line}${kind}`;
    const remaining = budget - used - header.length - 2;
    if (remaining < 80) break;

    const passage = truncate(hit.text, Math.min(remaining, perHit));
    const block = `${header}\n${passage}`;
    blocks.push(block);
    used += block.length + 2;
  }

  const text = blocks.join("\n\n");
  return {
    hits,
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    strategy,
    narrowingBytes: narrowing,
  };
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text.trimEnd();

  const cut = text.slice(0, limit);
  const lastNewline = cut.lastIndexOf("\n");
  const body = lastNewline > limit * 0.5 ? cut.slice(0, lastNewline) : cut;
  return `${body.trimEnd()}\n…`;
}

function narrowingBytes(response: unknown): number {
  if (!isRecord(response) || !isRecord(response._savings)) return 0;
  return numberValue(response._savings.bytes) ?? 0;
}

function budgetChars(maxTokens: number | undefined): number {
  const tokens = maxTokens ?? 800;
  return Math.max(400, tokens * 4);
}

function emptyResult(strategy: SearchResult["strategy"]): SearchResult {
  return { hits: [], text: "", bytes: 0, strategy, narrowingBytes: 0 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
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
