// Tool surface. Two retrieval tools plus status; the model gets a citation and
// a passage, not a file listing.

import type { Plugin } from "@opencode/plugin";
import type { Config } from "../config.ts";
import type { MemoryStore } from "../memory/store.ts";
import { formatMemories } from "../memory/store.ts";
import type { RemoteSpool } from "../remote/spool.ts";
import { formatAnomalies, type AnomalyService } from "../telemetry/anomaly.ts";
import type { Ledger } from "../stats/ledger.ts";
import type { XerjClient } from "../node/client.ts";
import { findPaths, searchContent } from "../analysis/find.ts";
import { findCycles, scanImports, specifiersIn } from "../analysis/imports.ts";
import { readProjectFile } from "../analysis/walk.ts";
import { DatasetService } from "../datasets/service.ts";
import type { Logger } from "../log.ts";
import type { SearchService } from "../search/service.ts";
import type { StatusSnapshot } from "../rpc.ts";

export interface ToolOptions {
  readonly config: Config;
  /** Canonical project root, for the analysis tools that read the tree. */
  readonly projectRoot: string;
  /** The node's HTTP client; the dataset tool manages arbitrary indexes. */
  readonly getClient: () => XerjClient | null;
  readonly logger: Logger;
  readonly ledger: Ledger;
  readonly getSearch: () => SearchService | null;
  readonly getMemory: () => MemoryStore | null;
  readonly getSpool: () => RemoteSpool | null;
  readonly getAnomaly: () => AnomalyService | null;
  readonly snapshot: () => Promise<StatusSnapshot>;
}

const SEARCH_INPUT = {
  type: "object",
  properties: {
    query: { type: "string", description: "What to look for, in plain words or exact terms." },
    k: { type: "number", description: "How many passages to return (1-50, default 8)." },
    max_tokens: { type: "number", description: "Approximate output budget in tokens." },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const DEF_INPUT = {
  type: "object",
  properties: {
    symbol: { type: "string", description: "Function, type, constant, or class name." },
    k: { type: "number", description: "How many declarations to return (1-50, default 5)." },
  },
  required: ["symbol"],
  additionalProperties: false,
} as const;

const REFS_INPUT = {
  type: "object",
  properties: {
    symbol: { type: "string", description: "Function, type, constant, or class name." },
    k: { type: "number", description: "How many declarations to list (1-50, default 20)." },
  },
  required: ["symbol"],
  additionalProperties: false,
} as const;

const OUTLINE_INPUT = {
  type: "object",
  properties: {
    path: { type: "string", description: "File path, relative to the project." },
    k: { type: "number", description: "How many symbols to list (1-50, default 50)." },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

const ZOOM_INPUT = {
  type: "object",
  properties: {
    path: { type: "string", description: "File path, relative to the project." },
    symbol: { type: "string", description: "Declaration name inside that file." },
    k: { type: "number", description: "How many matches to return (1-10, default 2)." },
  },
  required: ["path", "symbol"],
  additionalProperties: false,
} as const;

const FIND_INPUT = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description: "Regular expression for text, or a glob when files_only is true.",
    },
    glob: { type: "string", description: "Restrict the walk, for example src/** or *.ts." },
    ignore_case: { type: "boolean", description: "Case-insensitive match." },
    files_only: { type: "boolean", description: "Match paths instead of file contents." },
    limit: { type: "number", description: "Maximum results (1-200, default 100)." },
  },
  required: ["pattern"],
  additionalProperties: false,
} as const;

const IMPORTS_INPUT = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["cycles", "file"],
      description: "cycles lists circular imports; file lists one file's imports.",
    },
    path: { type: "string", description: "Project-relative file, for action=file." },
    limit: { type: "number", description: "How many cycles to report (1-50, default 20)." },
  },
  additionalProperties: false,
} as const;

const STATUS_INPUT = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const REMEMBER_INPUT = {
  type: "object",
  properties: {
    text: { type: "string", description: "The durable fact, decision, or preference to keep." },
    kind: {
      type: "string",
      enum: ["fact", "decision", "preference", "fix", "note"],
      description: "What kind of memory this is (default fact).",
    },
    topic: { type: "string", description: "Optional short topic label." },
  },
  required: ["text"],
  additionalProperties: false,
} as const;

const RECALL_INPUT = {
  type: "object",
  properties: {
    query: { type: "string", description: "What to remember, in plain words." },
    k: { type: "number", description: "How many memories to return (1-20, default 5)." },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const ANOMALY_INPUT = {
  type: "object",
  properties: {
    index: {
      type: "string",
      description: "Index or pattern with a date field and a numeric metric.",
    },
    time_field: {
      type: "string",
      description: "Date field to bucket by (default @timestamp).",
    },
    function: {
      type: "string",
      enum: ["count", "mean", "min", "max", "sum"],
      description: "Aggregation per bucket (default count).",
    },
    field: {
      type: "string",
      description: "Numeric field; required unless function is count.",
    },
    bucket_span: {
      type: "string",
      description: "Bucket size such as 1m or 1h (default 1h).",
    },
    threshold: {
      type: "number",
      description: "Z-score gate for a flag (default 3).",
    },
  },
  required: ["index"],
  additionalProperties: false,
} as const;

const INDEX_INPUT = {
  type: "object",
  properties: {
    url: { type: "string", description: "Fetch this URL and index its text." },
    path: { type: "string", description: "Index this file from outside the project." },
  },
  additionalProperties: false,
} as const;

const DATASET_INPUT = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list", "describe", "create", "delete", "export", "import"],
      description: "What to do with the index or dataset.",
    },
    index: {
      type: "string",
      description: "Index name. For import, an optional target override.",
    },
    path: {
      type: "string",
      description: "File path for export or import (NDJSON, Elasticsearch dump format).",
    },
    mapping: {
      type: "object",
      description: "Mapping to create the index with, as an Elasticsearch `mappings` body.",
    },
    force: {
      type: "boolean",
      description: "Required to delete an index the plugin maintains.",
    },
    pageSize: { type: "number", description: "Documents per export request." },
    batchSize: { type: "number", description: "Documents per import bulk request." },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

const FORGET_INPUT = {
  type: "object",
  properties: {
    id: { type: "string", description: "Memory id returned by xerj_remember or xerj_recall." },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function buildTools(options: ToolOptions): ReadonlyArray<{
  name: string;
  description: string;
  input: unknown;
  options: { namespace: string };
  execute: (input: unknown, context: unknown) => Promise<unknown>;
}> {
  return [
    {
      name: "search",
      description:
        "Search this project's local XERJ index. Returns cited passages with path:line instead of whole files. Use it before reading files or grepping when you need to find where something is implemented or described.",
      input: SEARCH_INPUT,
      options: { namespace: "xerj" },
      execute: async (input, context) => {
        const args = input as { query: string; k?: number; max_tokens?: number };
        const tool = context as { sessionID: string; signal: AbortSignal };
        const search = options.getSearch();
        if (!search) return unavailable();

        const result = await search.search(args.query, {
          k: args.k,
          maxTokens: args.max_tokens ?? options.config.context.maxTokens,
          signal: tool.signal,
        });
        await record(options, tool.sessionID, result);

        if (result.hits.length === 0) {
          return {
            content: await emptySearchHint(options),
            metadata: { xerj: { hits: 0, bytes: 0 } },
          };
        }
        return {
          content: result.text,
          metadata: {
            xerj: {
              hits: result.hits.length,
              bytes: result.bytes,
              strategy: result.strategy,
              narrowingBytes: result.narrowingBytes,
            },
          },
        };
      },
    },
    {
      name: "def",
      description:
        "Find the declaration of a symbol in this project's index. Returns file:line and the declaration text, which is cheaper than reading the file around a grep hit.",
      input: DEF_INPUT,
      options: { namespace: "xerj" },
      execute: async (input, context) => {
        const args = input as { symbol: string; k?: number };
        const tool = context as { sessionID: string; signal: AbortSignal };
        const search = options.getSearch();
        if (!search) return unavailable();

        const result = await search.definition(args.symbol, {
          k: args.k,
          maxTokens: options.config.context.maxTokens,
          signal: tool.signal,
        });
        await record(options, tool.sessionID, result);

        return result.hits.length === 0
          ? { content: "No declaration matched.", metadata: { xerj: { hits: 0, bytes: 0 } } }
          : {
              content: result.text,
              metadata: { xerj: { hits: result.hits.length, bytes: result.bytes } },
            };
      },
    },
    {
      name: "refs",
      description:
        "List the declarations that use a symbol, as path:line. Use it before renaming or changing a signature, instead of grepping the tree.",
      input: REFS_INPUT,
      options: { namespace: "xerj" },
      execute: async (input, context) => {
        const args = input as { symbol: string; k?: number };
        const tool = context as { sessionID: string; signal: AbortSignal };
        const search = options.getSearch();
        if (!search) return unavailable();

        const result = await search.references(args.symbol, {
          k: args.k,
          maxTokens: options.config.context.maxTokens,
          signal: tool.signal,
        });
        await record(options, tool.sessionID, result);

        return result.hits.length === 0
          ? {
              content: `No declaration in the index uses ${args.symbol}.`,
              metadata: { xerj: { hits: 0, bytes: 0 } },
            }
          : {
              content: result.text,
              metadata: { xerj: { hits: result.hits.length, bytes: result.bytes } },
            };
      },
    },
    {
      name: "outline",
      description:
        "List the symbols a file declares, with line numbers, without reading the file. Use it to decide what to zoom into.",
      input: OUTLINE_INPUT,
      options: { namespace: "xerj" },
      execute: async (input, context) => {
        const args = input as { path: string; k?: number };
        const tool = context as { sessionID: string; signal: AbortSignal };
        const search = options.getSearch();
        if (!search) return unavailable();

        const result = await search.outline(args.path, {
          k: args.k,
          maxTokens: options.config.context.maxTokens,
          signal: tool.signal,
        });
        await record(options, tool.sessionID, result);

        return result.hits.length === 0
          ? {
              content: `No symbols indexed for ${args.path}.`,
              metadata: { xerj: { hits: 0, bytes: 0 } },
            }
          : {
              content: result.text,
              metadata: { xerj: { hits: result.hits.length, bytes: result.bytes } },
            };
      },
    },
    {
      name: "zoom",
      description:
        "Return one declaration's source by file and symbol name. Cheaper than reading the file when you only need that function or type.",
      input: ZOOM_INPUT,
      options: { namespace: "xerj" },
      execute: async (input, context) => {
        const args = input as { path: string; symbol: string; k?: number };
        const tool = context as { sessionID: string; signal: AbortSignal };
        const search = options.getSearch();
        if (!search) return unavailable();

        const result = await search.symbol(args.path, args.symbol, {
          k: args.k === undefined ? undefined : Math.min(10, args.k),
          maxTokens: 1200,
          signal: tool.signal,
        });
        await record(options, tool.sessionID, result);

        return result.hits.length === 0
          ? {
              content: `No declaration named ${args.symbol} in ${args.path}.`,
              metadata: { xerj: { hits: 0, bytes: 0 } },
            }
          : {
              content: result.text,
              metadata: { xerj: { hits: result.hits.length, bytes: result.bytes } },
            };
      },
    },
    {
      name: "find",
      description:
        "Search the project's files with a regular expression, or list paths with a glob. Use it for exact text, symbols in comments, or a file pattern; the index answers concepts.",
      input: FIND_INPUT,
      options: { namespace: "xerj" },
      execute: async (input, context) => {
        const args = input as {
          pattern: string;
          glob?: string;
          ignore_case?: boolean;
          files_only?: boolean;
          limit?: number;
        };
        const tool = context as { signal: AbortSignal };
        const limit = Math.min(200, Math.max(1, Math.round(args.limit ?? 100)));

        if (args.files_only === true) {
          const paths = await findPaths(options.projectRoot, args.pattern, {
            signal: tool.signal,
            limit,
          });
          return {
            content:
              paths.length === 0
                ? `No path matches ${args.pattern}.`
                : [`${paths.length} ${paths.length === 1 ? "path" : "paths"}:`, ...paths].join("\n"),
            metadata: { xerj: { kind: "find", paths: paths.length } },
          };
        }

        let result;
        try {
          result = await searchContent(options.projectRoot, {
            pattern: args.pattern,
            glob: args.glob,
            ignoreCase: args.ignore_case,
            limit,
            signal: tool.signal,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return {
            content: `Invalid pattern: ${detail}`,
            metadata: { xerj: { kind: "find", error: true } },
          };
        }

        if (result.matches.length === 0) {
          return {
            content: `No match in ${result.files} files.`,
            metadata: { xerj: { kind: "find", matches: 0, files: result.files } },
          };
        }

        const lines = result.matches.map(
          (match) => `${match.path}:${match.line}: ${match.text}`,
        );
        return {
          content: [
            `${result.matches.length} ${result.matches.length === 1 ? "match" : "matches"} across ${result.files} files` +
              (result.truncated ? " (stopped at the limit)" : ""),
            ...lines,
          ].join("\n"),
          metadata: {
            xerj: { kind: "find", matches: result.matches.length, files: result.files },
          },
        };
      },
    },
    {
      name: "imports",
      description:
        "Read the project's import graph without a language server: circular imports, or the imports of one file with their resolution. Use it before restructuring modules.",
      input: IMPORTS_INPUT,
      options: { namespace: "xerj" },
      execute: async (input, context) => {
        const args = input as { action?: string; path?: string; limit?: number };
        const tool = context as { signal: AbortSignal };
        const action = args.action ?? "cycles";

        if (action === "file") {
          if (args.path === undefined || args.path.trim().length === 0) {
            return { content: "action=file needs a path", metadata: { xerj: { kind: "imports" } } };
          }
          const text = await readProjectFile(options.projectRoot, args.path.trim());
          if (text === null) {
            return {
              content: `No readable file at ${args.path}.`,
              metadata: { xerj: { kind: "imports" } },
            };
          }
          const specifiers = specifiersIn(args.path.trim(), text);
          return {
            content:
              specifiers.length === 0
                ? `${args.path} names no imports.`
                : specifiers.map((specifier) => `- ${specifier}`).join("\n"),
            metadata: { xerj: { kind: "imports", specifiers: specifiers.length } },
          };
        }

        const scan = await scanImports(options.projectRoot, { signal: tool.signal });
        const cycles = findCycles(scan.edges, clampK(args.limit ?? 20));
        if (cycles.length === 0) {
          return {
            content: `No import cycles across ${scan.files} files (${scan.edges.length} edges, ${scan.unresolved} unresolved specifiers).`,
            metadata: {
              xerj: { kind: "imports", cycles: 0, edges: scan.edges.length, files: scan.files },
            },
          };
        }

        const lines = [
          `${cycles.length} import ${cycles.length === 1 ? "cycle" : "cycles"} ` +
            `across ${scan.files} files (${scan.edges.length} edges):`,
          ...cycles.map((cycle) => `- ${cycle.join(" → ")}`),
        ];
        return {
          content: lines.join("\n"),
          metadata: {
            xerj: { kind: "imports", cycles: cycles.length, edges: scan.edges.length },
          },
        };
      },
    },
    {
      name: "status",
      description:
        "Report the XERJ search node, project index, and retrieval counters. Use it to check whether local search is available before falling back to reading files.",
      input: STATUS_INPUT,
      options: { namespace: "xerj" },
      execute: async () => ({
        content: JSON.stringify(await options.snapshot(), null, 2),
        metadata: { xerj: { kind: "status" } },
      }),
    },
    {
      name: "remember",
      description:
        "Store a durable project fact, decision, or preference in XERJ memory so a later session recalls it. Use it when you learn something that is not obvious from the code.",
      input: REMEMBER_INPUT,
      options: { namespace: "xerj" },
      execute: async (input, context) => {
        const args = input as { text: string; kind?: string; topic?: string };
        const tool = context as { sessionID: string };
        const memory = options.getMemory();
        if (!memory) return unavailable();

        const saved = await memory.remember({ ...args, sessionID: tool.sessionID });
        return {
          content: saved.created ? `Remembered as ${saved.id}.` : `Already remembered as ${saved.id}.`,
          metadata: { xerj: { memory: saved.id, created: saved.created } },
        };
      },
    },
    {
      name: "recall",
      description:
        "Recall project memories by meaning. Use it before asking the user something they may have already decided, or when a task depends on an earlier decision.",
      input: RECALL_INPUT,
      options: { namespace: "xerj" },
      execute: async (input) => {
        const args = input as { query: string; k?: number };
        const memory = options.getMemory();
        if (!memory) return unavailable();

        const hits = await memory.recall(args.query, clampK(args.k ?? 5));
        const block = formatMemories(hits, options.config.context.memoryTokens * 4);
        return block.length === 0
          ? { content: "No memories matched.", metadata: { xerj: { memories: 0 } } }
          : { content: block, metadata: { xerj: { memories: hits.length } } };
      },
    },
    {
      name: "index",
      description:
        "Index a URL or an external file so later searches can find it. Use it after fetching a page you expect to need again.",
      input: INDEX_INPUT,
      options: { namespace: "xerj" },
      execute: async (input, context) => {
        const args = input as { url?: string; path?: string };
        const tool = context as { signal: AbortSignal };
        const spool = options.getSpool();
        if (!spool) return unavailable();

        if (args.url) {
          const response = await fetch(args.url, { signal: withTimeout(tool.signal, 10_000) });
          if (!response.ok) {
            return { content: `Fetch failed: HTTP ${response.status}.`, metadata: { xerj: { indexed: false } } };
          }

          const text = await response.text();
          const stored = await spool.ingestUrl(args.url, text);
          options.getSearch()?.invalidate();
          return stored
            ? {
                content: `Indexed ${stored.bytes} bytes from ${args.url}.`,
                metadata: { xerj: { indexed: true, bytes: stored.bytes } },
              }
            : { content: "Nothing indexable at that URL.", metadata: { xerj: { indexed: false } } };
        }

        if (args.path) {
          const stored = await spool.ingestExternalFile(args.path);
          if (stored) options.getSearch()?.invalidate();
          return stored
            ? {
                content: `Indexed ${stored.path} (${stored.bytes} bytes).`,
                metadata: { xerj: { indexed: true, bytes: stored.bytes } },
              }
            : { content: `Could not index ${args.path}: unsupported, binary, or unreadable.`, metadata: { xerj: { indexed: false } } };
        }

        return { content: "Pass either a url or a path.", metadata: { xerj: { indexed: false } } };
      },
    },
    {
      name: "anomaly",
      description:
        "Find spikes in a numeric metric series indexed in XERJ. On-demand batch scoring, not continuous monitoring; returns only the flagged buckets.",
      input: ANOMALY_INPUT,
      options: { namespace: "xerj" },
      execute: async (input) => {
        const args = input as {
          index: string;
          time_field?: string;
          function?: string;
          field?: string;
          bucket_span?: string;
          threshold?: number;
        };
        const anomaly = options.getAnomaly();
        if (!anomaly) return unavailable();

        const result = await anomaly.score({
          index: args.index,
          timeField: args.time_field,
          function: args.function,
          field: args.field,
          bucketSpan: args.bucket_span,
          threshold: args.threshold,
        });

        return {
          content: formatAnomalies(result),
          metadata: {
            xerj: {
              anomalyCount: result.anomalyCount,
              detector: result.detector,
              buckets: result.buckets,
            },
          },
        };
      },
    },
    {
      name: "dataset",
      description:
        "Manage extra indexes on this node and move data in and out: list, describe, create, delete, export to an Elasticsearch-compatible NDJSON dump, or import one. Use it to bring a dataset in for searching or to hand one to another tool.",
      input: DATASET_INPUT,
      options: { namespace: "xerj" },
      execute: async (raw) => {
        const input = (raw ?? {}) as Record<string, unknown>;
        const action = typeof input.action === "string" ? input.action : "";
        const client = options.getClient();
        if (client === null) {
          return { content: "the XERJ node is not available yet" };
        }

        const datasets = new DatasetService(client, options.logger);
        const index = typeof input.index === "string" ? input.index : null;
        const path = typeof input.path === "string" ? input.path : null;
        const force = input.force === true;

        switch (action) {
          case "list": {
            const rows = await datasets.list();
            if (rows.length === 0) return { content: "no indexes on this node" };
            return {
              content: rows
                .map(
                  (row) =>
                    `${row.index} · ${row.docs} docs · ${formatBytes(row.bytes)}` +
                    (row.managed ? " · managed" : ""),
                )
                .join("\n"),
              metadata: { xerj: { datasets: rows.length } },
            };
          }
          case "describe": {
            if (index === null) return { content: "describe needs an index" };
            const described = await datasets.describe(index);
            if (described.info === null) return { content: `no index named ${index}` };
            return {
              content:
                `${described.info.index} · ${described.info.docs} docs · ` +
                `${formatBytes(described.info.bytes)}\n` +
                JSON.stringify(described.mapping, null, 2),
              metadata: { xerj: { docs: described.info.docs } },
            };
          }
          case "create": {
            if (index === null) return { content: "create needs an index" };
            const mapping =
              typeof input.mapping === "object" && input.mapping !== null
                ? (input.mapping as Record<string, unknown>)
                : undefined;
            const result = await datasets.create(index, mapping);
            return {
              content: result.created
                ? `created ${index}`
                : `${index} already exists; nothing changed`,
            };
          }
          case "delete": {
            if (index === null) return { content: "delete needs an index" };
            const result = await datasets.remove(index, force);
            return {
              content: result.deleted ? `deleted ${index}` : (result.reason ?? "not deleted"),
            };
          }
          case "export": {
            if (index === null || path === null) return { content: "export needs index and path" };
            const summary = await datasets.exportIndex({
              index,
              path,
              pageSize: typeof input.pageSize === "number" ? input.pageSize : undefined,
            });
            return {
              content:
                `exported ${summary.docs} documents from ${index} to ${summary.path}` +
                (summary.truncated ? " (stopped at the export limit)" : ""),
              metadata: { xerj: { docs: summary.docs, bytes: summary.bytes } },
            };
          }
          case "import": {
            if (path === null) return { content: "import needs a path" };
            const summary = await datasets.importDump({
              path,
              index: index ?? undefined,
              mapping:
                typeof input.mapping === "object" && input.mapping !== null
                  ? (input.mapping as Record<string, unknown>)
                  : undefined,
              batchSize: typeof input.batchSize === "number" ? input.batchSize : undefined,
            });
            return {
              content:
                `imported ${summary.docs} documents into ${summary.index}` +
                (summary.created ? " (index created)" : "") +
                (summary.skipped > 0 ? ` · ${summary.skipped} lines skipped` : ""),
              metadata: { xerj: { docs: summary.docs, batches: summary.batches } },
            };
          }
          default:
            return { content: `unknown dataset action: ${action || "(none)"}` };
        }
      },
    },
    {
      name: "forget",
      description: "Retract a memory that is no longer true. Takes the id returned by xerj_remember or xerj_recall.",
      input: FORGET_INPUT,
      options: { namespace: "xerj" },
      execute: async (input) => {
        const args = input as { id: string };
        const memory = options.getMemory();
        if (!memory) return unavailable();

        const forgotten = await memory.forget(args.id);
        return {
          content: forgotten ? `Forgot ${args.id}.` : `No memory with id ${args.id}.`,
          metadata: { xerj: { memory: args.id, forgotten } },
        };
      },
    },
  ];
}

/**
 * An empty result carries no information on its own: the model cannot tell a
 * miss from an index that is still building, so it either retries blindly or
 * reads files. Say what the index holds and what to try instead.
 */
async function emptySearchHint(options: ToolOptions): Promise<string> {
  const status = await options.snapshot().catch(() => null);
  const index = status?.index ?? null;
  if (index !== null && index.docs === 0) {
    return (
      `No passages matched: this project is still indexing (${index.state}). ` +
      "Try again shortly, or read the file directly."
    );
  }
  const held =
    index === null
      ? "an unknown number of records"
      : `${index.docs} records from ${index.lastFiles} files (${index.state})`;
  return (
    `No passages matched. The index holds ${held}. ` +
    "Try different words, a narrower phrase, or xerj_def for a symbol name."
  );
}

async function record(
  options: ToolOptions,
  sessionID: string,
  result: Awaited<ReturnType<SearchService["search"]>>,
): Promise<void> {
  const paths = result.hits.flatMap((hit) => (hit.path ? [hit.path] : []));
  await options.ledger.recordQuery(sessionID, paths, result.bytes, result.hits.length);
}

function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const forward = (): void => controller.abort();

  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", forward, { once: true });

  controller.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", forward);
    },
    { once: true },
  );

  return controller.signal;
}

function clampK(value: number): number {
  return Math.min(20, Math.max(1, Math.round(value)));
}

function unavailable(): { content: string; metadata: Record<string, unknown> } {
  return {
    content: "XERJ is not ready yet; the node or index is still starting.",
    metadata: { xerj: { hits: 0, bytes: 0, ready: false } },
  };
}
