// Prompt-time retrieval and context injection.
//
// The prompt hook runs at admission and does the retrieval once, with a hard
// deadline. The context hook runs before every model call; it injects that one
// prepared block exactly once and forgets it, so tool-driven continuations do
// not repeat the same passages into the window.

import type { Plugin } from "@opencode/plugin";
import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";
import type { MemoryStore } from "../memory/store.ts";
import { formatMemories } from "../memory/store.ts";
import type { SearchService } from "../search/service.ts";

export interface SessionHookOptions {
  readonly config: Config;
  readonly logger: Logger;
  readonly getSearch: () => SearchService | null;
  readonly getMemory: () => MemoryStore | null;
  readonly summarize: () => Promise<string>;
  readonly onInject?: () => void;
  readonly recordQuery: (
    sessionID: string,
    paths: ReadonlyArray<string>,
    bytes: number,
    hits: number,
  ) => Promise<void>;
}

interface Prepared {
  readonly messageID: string;
  readonly block: string;
  readonly memory: string;
  readonly hits: number;
}

const MIN_QUERY_LENGTH = 12;

/** Slash commands and one-word replies are not worth a retrieval pass. */
export function shouldRetrieve(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith("/")) return false;
  return trimmed.length >= MIN_QUERY_LENGTH;
}

export function formatContextBlock(text: string): string {
  return [
    "<xerj-context>",
    "Retrieved from the local XERJ index. Cite path:line when you use it.",
    "",
    text,
    "</xerj-context>",
  ].join("\n");
}

export function formatCorpusBlock(summary: string): string {
  return `<xerj-corpus>\n${summary}\n</xerj-corpus>`;
}

export async function registerSessionHooks(
  ctx: Plugin.Context,
  options: SessionHookOptions,
): Promise<void> {
  if (!options.config.context.enabled) return;

  const prepared = new Map<string, Prepared>();
  const injected = new Set<string>();
  const injectedMemories = new Set<string>();
  const summarized = new Set<string>();

  await ctx.session.hook("prompt", async (event) => {
    const text = event.prompt.text.trim();
    if (!shouldRetrieve(text)) return;

    const search = options.getSearch();
    if (!search) return;

    try {
      const result = await retrieve(search, text, options);
      const paths = result.hits.flatMap((hit) => (hit.path ? [hit.path] : []));
      await options.recordQuery(event.sessionID, paths, result.bytes, result.hits.length);

      const memory = await recallMemories(text, options, injectedMemories);

      if (result.hits.length === 0 && memory.length === 0) return;
      prepared.set(event.sessionID, {
        messageID: event.messageID,
        block: result.text.trim().length === 0 ? "" : formatContextBlock(result.text),
        memory,
        hits: result.hits.length,
      });
    } catch (error) {
      options.logger.debug("prompt retrieval skipped", String(error));
    }
  });

  await ctx.session.hook("context", async (event) => {
    if (!summarized.has(event.sessionID)) {
      summarized.add(event.sessionID);
      try {
        const summary = await options.summarize();
        if (summary.length > 0) {
          event.system.push({ type: "text", text: formatCorpusBlock(summary) });
        }
      } catch (error) {
        options.logger.debug("could not summarize the corpus", String(error));
      }
    }

    const entry = prepared.get(event.sessionID);
    if (!entry) return;

    const key = `${event.sessionID}:${entry.messageID}`;
    if (injected.has(key)) return;
    injected.add(key);
    prepared.delete(event.sessionID);

    if (entry.memory.length > 0) {
      event.system.push({ type: "text", text: entry.memory });
    }
    if (entry.block.length > 0) {
      event.system.push({ type: "text", text: entry.block });
    }
    if (entry.memory.length > 0 || entry.block.length > 0) {
      options.onInject?.();
    }
  });
}

async function recallMemories(
  text: string,
  options: SessionHookOptions,
  injected: Set<string>,
): Promise<string> {
  const memory = options.getMemory();
  if (!memory) return "";

  const hits = (await memory.recall(text, 3)).filter((hit) => !injected.has(hit.id));
  if (hits.length === 0) return "";

  const block = formatMemories(hits, options.config.context.memoryTokens * 4);
  if (block.length === 0) return "";

  for (const hit of hits) injected.add(hit.id);
  return block;
}

async function retrieve(
  search: SearchService,
  text: string,
  options: SessionHookOptions,
): Promise<Awaited<ReturnType<SearchService["search"]>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.config.context.timeoutMs);

  try {
    return await search.search(text, {
      k: options.config.context.maxPassages,
      maxTokens: options.config.context.maxTokens,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
