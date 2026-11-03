// Tool surface. Two retrieval tools plus status; the model gets a citation and
// a passage, not a file listing.

import type { Plugin } from "@opencode/plugin";
import type { Config } from "../config.ts";
import type { Ledger } from "../stats/ledger.ts";
import type { SearchService } from "../search/service.ts";
import type { StatusSnapshot } from "../rpc.ts";

export interface ToolOptions {
  readonly config: Config;
  readonly ledger: Ledger;
  readonly getSearch: () => SearchService | null;
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

function unavailable(): { content: string; metadata: Record<string, unknown> } {
  return {
    content: "XERJ is not ready yet; the node or index is still starting.",
    metadata: { xerj: { hits: 0, bytes: 0, ready: false } },
  };
}
