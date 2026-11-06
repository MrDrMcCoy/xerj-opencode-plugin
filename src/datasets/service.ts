// Extra indexes a user brings to this node: their own datasets alongside the
// project, documentation, and memory corpora, plus import and export of
// Elasticsearch-compatible NDJSON dumps (the format `elasticdump` and
// `_bulk` produce and consume).

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Logger } from "../log.ts";
import { XerjClient, type IndexSummary } from "../node/client.ts";

/** Names the plugin owns; changing them breaks a corpus it maintains. */
const MANAGED_PREFIXES = ["xop-", ".xerj-", ".xerj_"];

const DEFAULT_PAGE = 500;
const MAX_EXPORT_DOCS = 500_000;
const DEFAULT_BULK_BATCH = 500;

export interface DatasetInfo {
  readonly index: string;
  readonly docs: number;
  readonly bytes: number;
  /** True when the plugin or the engine maintains this index. */
  readonly managed: boolean;
}

export interface ExportOptions {
  readonly index: string;
  readonly path: string;
  /** Documents per request; each becomes one `_search` call. */
  readonly pageSize?: number;
  /** Newline-delimited JSON, one `{"index":…}` line per document. */
  readonly signal?: AbortSignal;
}

export interface ExportSummary {
  readonly index: string;
  readonly path: string;
  readonly docs: number;
  readonly bytes: number;
  readonly truncated: boolean;
}

export interface ImportOptions {
  readonly path: string;
  /** Index to write into; defaults to the dump's own `_index`. */
  readonly index?: string;
  readonly batchSize?: number;
  /** Mapping to create the index with; omitted means "whatever the engine infers". */
  readonly mapping?: Record<string, unknown>;
  readonly signal?: AbortSignal;
}

export interface ImportSummary {
  readonly index: string;
  readonly docs: number;
  readonly batches: number;
  /** Lines that were not valid action/source pairs. */
  readonly skipped: number;
  readonly created: boolean;
}

/** A parsed dump line pair: the action and the document it applies to. */
export interface DumpEntry {
  readonly id: string | null;
  readonly source: Record<string, unknown>;
}

export class DatasetService {
  constructor(
    private readonly client: XerjClient,
    private readonly logger: Logger,
  ) {}

  /** Every index on the node, with the plugin's own marked as managed. */
  async list(): Promise<ReadonlyArray<DatasetInfo>> {
    const indices = await this.client.indices();

    return indices
      .map((entry) => ({
        index: entry.index,
        docs: entry.docs,
        bytes: entry.bytes,
        managed: isManaged(entry.index),
      }))
      .sort((left, right) => left.index.localeCompare(right.index));
  }

  /** One index's mapping, document count, and size. */
  async describe(index: string): Promise<{
    readonly info: DatasetInfo | null;
    readonly mapping: Record<string, unknown>;
  }> {
    const indices = await this.client.indices();
    const found = indices.find((entry) => entry.index === index);
    const mappings: Record<string, Record<string, string>> = await this.client
      .mappings(index)
      .catch(() => ({}));

    return {
      info:
        found === undefined
          ? null
          : {
              index: found.index,
              docs: found.docs,
              bytes: found.bytes,
              managed: isManaged(found.index),
            },
      mapping: (mappings[index] ?? {}) as Record<string, unknown>,
    };
  }

  /** Creates an index, optionally with a mapping. Refuses to replace one. */
  async create(
    index: string,
    mapping?: Record<string, unknown>,
  ): Promise<{ readonly created: boolean; readonly existed: boolean }> {
    requireName(index);
    const existing = (await this.client.indices()).some((entry) => entry.index === index);
    if (existing) return { created: false, existed: true };

    await this.client.put(
      `/${encodeURIComponent(index)}`,
      mapping === undefined ? {} : { mappings: mapping },
      "could not create the index",
    );
    return { created: true, existed: false };
  }

  /**
   * Deletes an index. A corpus the plugin maintains is refused unless the
   * caller confirms, because dropping one loses data the plugin rebuilds only
   * on a full reindex.
   */
  async remove(
    index: string,
    force = false,
  ): Promise<{ readonly deleted: boolean; readonly reason: string | null }> {
    requireName(index);
    if (isManaged(index) && !force) {
      return {
        deleted: false,
        reason: `${index} belongs to the plugin; pass force to delete it`,
      };
    }

    const before = (await this.client.indices()).find((entry) => entry.index === index);
    if (before === undefined) return { deleted: false, reason: `${index} does not exist` };

    await this.client.deleteIndex(index);
    return { deleted: true, reason: null };
  }

  /**
   * Writes one index as an Elasticsearch-compatible NDJSON dump: an action line
   * and a source line per document, exactly what `_bulk` reads back.
   */
  async exportIndex(options: ExportOptions): Promise<ExportSummary> {
    const pageSize = Math.max(1, options.pageSize ?? DEFAULT_PAGE);
    const path = resolve(options.path);
    await mkdir(dirname(path), { recursive: true }).catch(() => {});

    const stream = createWriteStream(path, { encoding: "utf8" });
    let docs = 0;
    let bytes = 0;
    let from = 0;
    let truncated = false;

    try {
      while (docs < MAX_EXPORT_DOCS) {
        const response = await this.client.search(options.index, {
          from,
          size: pageSize,
          query: { match_all: {} },
        }, options.signal);

        const hits = hitsOf(response);
        if (hits.length === 0) break;

        for (const hit of hits) {
          const action = JSON.stringify({
            index: { _index: options.index, _id: hit.id },
          });
          const source = JSON.stringify(hit.source);
          const line = `${action}\n${source}\n`;
          stream.write(line);
          docs += 1;
          bytes += Buffer.byteLength(line, "utf8");
        }

        from += hits.length;
        if (hits.length < pageSize) break;
        if (docs >= MAX_EXPORT_DOCS) {
          truncated = true;
          break;
        }
      }
    } finally {
      await new Promise<void>((resolveWrite, rejectWrite) => {
        stream.end(() => resolveWrite());
        stream.on("error", rejectWrite);
      });
    }

    this.logger.info("exported a dataset", { index: options.index, docs, path });
    return { index: options.index, path, docs, bytes, truncated };
  }

  /**
   * Reads an NDJSON dump and bulk-loads it. Both `{"index":…}` and
   * `{"create":…}` actions are accepted, as are dumps with loose `_type`
   * fields, because that is what Elasticsearch exports look like.
   */
  async importDump(options: ImportOptions): Promise<ImportSummary> {
    const path = resolve(options.path);
    const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BULK_BATCH);

    const seen = new Set<string>();
    let index = options.index ?? null;
    let docs = 0;
    let batches = 0;
    let skipped = 0;
    let created = false;
    let assigned = 0;
    let buffer: Array<{ id: string | null; source: Record<string, unknown> }> = [];

    const flush = async (): Promise<void> => {
      if (buffer.length === 0) return;
      if (index === null) throw new Error("the dump has no index and no target was given");

      const target = index;
      if (!seen.has(target)) {
        seen.add(target);
        const result = await this.create(target, options.mapping);
        created = created || result.created;
      }

      // A dump without ids gets a running number, which is stable for one
      // import and impossible to collide with a real id.
      const actions = buffer.map((entry) => ({
        id: entry.id ?? `doc-${assigned++}`,
        source: entry.source,
      }));
      await this.client.bulk(target, actions);
      docs += actions.length;
      batches += 1;
      buffer = [];
    };

    let action: Record<string, unknown> | null = null;
    for await (const line of readLines(path)) {
      if (options.signal?.aborted === true) break;
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        skipped += 1;
        action = null;
        continue;
      }
      if (!isRecord(parsed)) {
        skipped += 1;
        action = null;
        continue;
      }

      const header = actionOf(parsed);
      if (header !== null) {
        // An action line started a new document; the previous one had no body.
        if (action !== null) skipped += 1;
        action = header;
        continue;
      }

      // A document body follows its action line.
      if (action === null) {
        skipped += 1;
        continue;
      }

      const meta = (action.index ?? action.create) as Record<string, unknown> | undefined;
      if (index === null && typeof meta?._index === "string") index = meta._index;
      const id = typeof meta?._id === "string" ? meta._id : null;
      buffer.push({ id, source: parsed });
      if (buffer.length >= batchSize) await flush();
      action = null;
    }

    // A trailing action line with no body is a truncated dump.
    if (action !== null) skipped += 1;
    await flush();

    if (index === null) throw new Error(`no documents found in ${path}`);

    this.logger.info("imported a dataset", { index, docs, batches, skipped });
    return { index, docs, batches, skipped, created };
  }
}

/** True for indexes the plugin or the engine owns. */
export function isManaged(index: string): boolean {
  return MANAGED_PREFIXES.some((prefix) => index.startsWith(prefix));
}

/** One action line, or null when the line is a document body. */
export function actionOf(
  value: Record<string, unknown>,
): Record<string, unknown> | null {
  for (const key of ["index", "create"]) {
    const candidate = value[key];
    if (isRecord(candidate)) return { [key]: candidate };
  }
  return null;
}

interface HitLike {
  readonly id: string;
  readonly source: Record<string, unknown>;
}

/** `_id` and `_source` from a search response, tolerating an empty body. */
export function hitsOf(response: unknown): HitLike[] {
  if (!isRecord(response)) return [];
  const hits = response.hits;
  if (!isRecord(hits) || !Array.isArray(hits.hits)) return [];

  return hits.hits.flatMap((hit): HitLike[] => {
    if (!isRecord(hit)) return [];
    const id = typeof hit._id === "string" ? hit._id : null;
    const source = isRecord(hit._source) ? hit._source : null;
    if (id === null || source === null) return [];
    return [{ id, source }];
  });
}

/** Reads a file line by line without loading it whole. */
async function* readLines(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: "utf8" });
  let pending = "";

  for await (const chunk of stream) {
    pending += chunk;
    let index = pending.indexOf("\n");
    while (index >= 0) {
      yield pending.slice(0, index);
      pending = pending.slice(index + 1);
      index = pending.indexOf("\n");
    }
  }
  if (pending.length > 0) yield pending;
}

function requireName(index: string): void {
  const trimmed = index.trim();
  if (trimmed.length === 0) throw new Error("an index name is required");
  if (/[\\/*?"<>| ,#]/.test(trimmed)) {
    throw new Error(`invalid index name: ${index}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export type { IndexSummary };
