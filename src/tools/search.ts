// Tool surface. Two retrieval tools plus status; the model gets a citation and
// a passage, not a file listing.

import type { Plugin } from "@opencode/plugin";
import type { Config } from "../config.ts";
import type { MemoryStore } from "../memory/store.ts";
import { formatMemories } from "../memory/store.ts";
import type { RemoteSpool } from "../remote/spool.ts";
import type { Ledger } from "../stats/ledger.ts";
import type { SearchService } from "../search/service.ts";
import type { StatusSnapshot } from "../rpc.ts";

export interface ToolOptions {
  readonly config: Config;
  readonly ledger: Ledger;
  readonly getSearch: () => SearchService | null;
  readonly getMemory: () => MemoryStore | null;
  readonly getSpool: () => RemoteSpool | null;
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

const INDEX_INPUT = {
  type: "object",
  properties: {
    url: { type: "string", description: "Fetch this URL and index its text." },
    path: { type: "string", description: "Index this file from outside the project." },
  },
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

        return result.hits.length === 0
          ? { content: "No passages matched.", metadata: { xerj: { hits: 0, bytes: 0 } } }
          : {
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
