// The command corpus: plain-text line windows under the project's own prefix.
//
// No embedding. A log is literal text, an error string is an exact term, and
// embedding megabytes per command would cost more than the project pass. One
// document per window keeps `_passage` offsets useful and bounds each write.

import type { XerjClient } from "../node/client.ts";
import type { Logger } from "../log.ts";
import { redact } from "../redact.ts";
import { countLines, type CmdEntry, type CmdStore } from "./store.ts";

export interface CmdHit {
  readonly stem: string;
  readonly kind: "out" | "cmd";
  readonly line: number;
  readonly text: string;
  readonly command: string;
  readonly exitCode: number | null;
}

export interface CmdCorpusOptions {
  readonly client: XerjClient;
  /** `<project prefix>-cmd-docs`. */
  readonly indexName: string;
  readonly store: CmdStore;
  readonly logger: Logger;
  readonly windowLines: number;
  readonly windowBytes: number;
  readonly maxFileBytes: number;
  readonly signal?: AbortSignal;
}

const MAPPING = {
  mappings: {
    properties: {
      body: { type: "text" },
      stem: { type: "keyword" },
      kind: { type: "keyword" },
      start_line: { type: "integer" },
      end_line: { type: "integer" },
      lines: { type: "integer" },
      bytes: { type: "integer" },
      // -1 when the exit code is unknown; the engine has no nullable integer.
      exit_code: { type: "integer" },
      at: { type: "date" },
      command: { type: "text" },
      ax_path: { type: "keyword" },
      source: { type: "keyword" },
    },
  },
} as const;

export class CmdCorpus {
  private mapped = false;

  constructor(private readonly options: CmdCorpusOptions) {}

  async ensureMapping(): Promise<void> {
    if (this.mapped) return;
    try {
      await this.options.client.put(this.options.indexName, MAPPING, "could not create the command index");
    } catch (error) {
      this.options.logger.debug("command index mapping not created", String(error));
    }
    this.mapped = true;
  }

  /** Indexes what changed and forgets what the store dropped. */
  async run(): Promise<{ windows: number; files: number }> {
    await this.ensureMapping();
    let windows = 0;
    let files = 0;

    for (const entry of this.options.store.all()) {
      if (entry.bytes < 0) continue;
      if (entry.indexedBytes === entry.bytes && entry.windows.length > 0) continue;
      if (entry.binary) continue;
      if (entry.bytes > this.options.maxFileBytes) continue;
      if (entry.bytes === 0) continue;

      const text = await this.options.store.read(entry.stem, 1, Number.MAX_SAFE_INTEGER);
      if (text === null) continue;
      const body = text.lines.join("\n");
      const parts = splitWindows(body, this.options.windowLines, this.options.windowBytes);
      if (parts.length === 0) continue;

      const actions = [
        {
          id: documentId(entry.stem, "cmd", 0),
          source: {
            stem: entry.stem,
            kind: "cmd",
            body: redact(entry.command),
            command: redact(entry.command),
            start_line: 1,
            end_line: 1,
            lines: 1,
            bytes: Buffer.byteLength(entry.command, "utf8"),
            exit_code: entry.exitCode ?? -1,
            at: new Date(entry.at).toISOString(),
            ax_path: `cmd/${entry.stem}-cmd.txt`,
            source: entry.source,
          },
        },
        ...parts.map((part) => ({
          id: documentId(entry.stem, "out", part.start),
          source: {
            stem: entry.stem,
            kind: "out",
            body: redact(part.body),
            command: redact(entry.command),
            start_line: part.start,
            end_line: part.end,
            lines: entry.lines,
            bytes: entry.bytes,
            exit_code: entry.exitCode ?? -1,
            at: new Date(entry.at).toISOString(),
            ax_path: `cmd/${entry.stem}-out.txt`,
            source: entry.source,
          },
        })),
      ];

      try {
        await this.options.client.bulk(this.options.indexName, actions);
        await this.options.store.markIndexed(
          entry.stem,
          parts.map((part) => part.start),
          entry.bytes,
        );
        windows += parts.length;
        files += 1;
      } catch (error) {
        this.options.logger.warn("could not index command output", String(error));
        break;
      }
    }

    return { windows, files };
  }

  /** Deletes the documents of stems the store removed. */
  async prune(entries: ReadonlyArray<CmdEntry>): Promise<void> {
    if (entries.length === 0) return;
    const ids = entries.flatMap((entry) => [
      documentId(entry.stem, "cmd", 0),
      ...entry.windows.map((start) => documentId(entry.stem, "out", start)),
    ]);
    await this.options.client
      .bulkDelete(this.options.indexName, ids)
      .catch((error: unknown) => {
        this.options.logger.debug("could not prune command output", String(error));
      });
  }

  async search(
    query: string,
    options: { readonly stem?: string; readonly k: number; readonly signal?: AbortSignal },
  ): Promise<CmdHit[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    const response = await this.options.client.search(
      this.options.indexName,
      {
        size: Math.min(50, options.k * 3),
        _source: ["stem", "kind", "start_line", "exit_code", "command", "ax_path"],
        fields: ["_passage"],
        query: { match: { body: trimmed } },
      },
      options.signal,
    );

    return parseHits(response, trimmed, options.stem).slice(0, options.k);
  }

  /** Live index size, for the store's mixed cap. */
  async indexBytes(): Promise<number> {
    const indices = await this.options.client.indices().catch(() => []);
    return indices.find((entry) => entry.index === this.options.indexName)?.bytes ?? 0;
  }
}

export interface Window {
  readonly start: number;
  readonly end: number;
  readonly body: string;
}

/** Splits text on lines, then on size, keeping at least one line per window. */
export function splitWindows(
  text: string,
  maxLines: number,
  maxBytes: number,
): Window[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const windows: Window[] = [];

  let start = 1;
  let batch: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (batch.length > 0 && (batch.length >= maxLines || bytes + size > maxBytes)) {
      windows.push({ start, end: start + batch.length - 1, body: batch.join("\n") });
      start += batch.length;
      batch = [];
      bytes = 0;
    }
    batch.push(line);
    bytes += size;
  }
  if (batch.length > 0) {
    windows.push({ start, end: start + batch.length - 1, body: batch.join("\n") });
  }
  return windows;
}

export function documentId(stem: string, kind: "cmd" | "out", start: number): string {
  return `${stem}-${kind}-${start}`;
}

function parseHits(
  response: unknown,
  query: string,
  stem: string | undefined,
): CmdHit[] {
  const hits = (response as {
    hits?: { hits?: Array<Record<string, unknown>> };
  })?.hits?.hits;
  if (!Array.isArray(hits)) return [];

  const words = wordsOf(query);
  const found: CmdHit[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const source = (hit._source ?? {}) as Record<string, unknown>;
    const hitStem = typeof source.stem === "string" ? source.stem : "";
    if (hitStem.length === 0) continue;
    if (stem !== undefined && hitStem !== stem) continue;

    const kind = source.kind === "cmd" ? "cmd" : "out";
    const startLine =
      typeof source.start_line === "number" ? source.start_line : 1;
    const passage = passageText(hit);
    const line = kind === "out" ? startLine + lineOffset(passage, words) : 1;
    const key = `${hitStem}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);

    found.push({
      stem: hitStem,
      kind,
      line,
      text: clip(passage.split("\n")[lineOffset(passage, words)] ?? passage, 300),
      command: typeof source.command === "string" ? source.command : "",
      exitCode: typeof source.exit_code === "number" && source.exit_code >= 0
        ? source.exit_code
        : null,
    });
  }
  return found;
}

function passageText(hit: Record<string, unknown>): string {
  const fields = hit.fields as { _passage?: Array<{ text?: unknown }> } | undefined;
  const first = fields?._passage?.[0]?.text;
  return typeof first === "string" ? first : "";
}

function wordsOf(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .filter((word) => word.length > 1);
}

/** Index of the first passage line that carries a query term. */
function lineOffset(passage: string, words: ReadonlyArray<string>): number {
  const lines = passage.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.toLowerCase() ?? "";
    if (words.some((word) => line.includes(word))) return index;
  }
  return 0;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
