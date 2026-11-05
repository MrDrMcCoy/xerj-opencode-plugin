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
import { contentTerms, coversTerms } from "../search/rank.ts";
import type { SearchHit, SearchService } from "../search/service.ts";

export interface SessionHookOptions {
  readonly config: Config;
  readonly logger: Logger;
  readonly getSearch: () => SearchService | null;
  readonly getMemory: () => MemoryStore | null;
  readonly summarize: () => Promise<string>;
  readonly onInject?: () => void;
  /**
   * Reports bytes the plugin placed into context beyond the passages already
   * counted as returned by `recordQuery`, so the ledger never charges a
   * passage twice: once against savings and once as cost.
   */
  readonly onCost?: (sessionID: string, bytes: number) => void;
  /** Reports a prompt worth retrieving for, e.g. to title a captured turn. */
  readonly onPrompt?: (sessionID: string, text: string) => void;
  /** Reports a prompt whose passages the relevance gate dropped entirely. */
  readonly onNoiseSkip?: () => void;
  /** Resets the idle deadline; called for every prompt and model call. */
  readonly onActivity?: (sessionID?: string) => void;
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
  /** Passage bytes inside `block`, already charged through `recordQuery`. */
  readonly passageBytes: number;
  readonly memory: string;
  readonly hits: number;
  /** `path:line` keys of the passages in this block, for session dedupe. */
  readonly locations: ReadonlyArray<string>;
}

const MIN_QUERY_LENGTH = 12;
const MIN_CONTENT_TERMS = 2;
// Memories are phrased in another session's words, so they need a looser
// match than passages before they are injected.
const MEMORY_COVERAGE_RATIO = 0.5;

/**
 * Slash commands, one-word replies, and prompts made of filler ("please
 * continue") are not worth a retrieval pass: they match nothing specific and
 * would inject whatever scores highest on common words.
 */
export function shouldRetrieve(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith("/")) return false;
  if (trimmed.length < MIN_QUERY_LENGTH) return false;
  return contentTerms(trimmed).length >= MIN_CONTENT_TERMS;
}

export function formatContextBlock(text: string): string {
  return [
    "<xerj-context>",
    "Retrieved from the local XERJ index. Cite path:line when you use it.",
    // Reads of cited files cancel the savings; say what the passage already is.
    "Passages are current file text. Read a file only to edit it or to see past the passage.",
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
  // Locations already in this session's context; injecting them again spends
  // budget on text the model can already see.
  const seen = new Map<string, Set<string>>();
  const summarized = new Set<string>();

  await ctx.session.hook("prompt", async (event) => {
    options.onActivity?.(event.sessionID);
    const text = event.prompt.text.trim();
    if (!shouldRetrieve(text)) return;
    options.onPrompt?.(event.sessionID, text);

    const search = options.getSearch();
    if (!search) return;

    try {
      const already = seen.get(event.sessionID);
      const result = await retrieve(search, text, options, (hit) =>
        already?.has(locationKey(hit)) ?? false,
      );
      const paths = result.hits.flatMap((hit) => (hit.path ? [hit.path] : []));
      await options.recordQuery(event.sessionID, paths, result.bytes, result.hits.length);

      const memory = await recallMemories(text, options, injectedMemories);

      if (result.hits.length === 0 && memory.length === 0) {
        options.onNoiseSkip?.();
        return;
      }
      prepared.set(event.sessionID, {
        messageID: event.messageID,
        block: result.text.trim().length === 0 ? "" : formatContextBlock(result.text),
        passageBytes: result.text.trim().length === 0 ? 0 : result.bytes,
        memory,
        hits: result.hits.length,
        locations: result.hits.map(locationKey),
      });
    } catch (error) {
      options.logger.debug("prompt retrieval skipped", String(error));
    }
  });

  await ctx.session.hook("context", async (event) => {
    options.onActivity?.(event.sessionID);
    if (!summarized.has(event.sessionID)) {
      summarized.add(event.sessionID);
      try {
        const summary = await options.summarize();
        if (summary.length > 0) {
          const block = formatCorpusBlock(summary);
          event.system.push({ type: "text", text: block });
          options.onCost?.(event.sessionID, Buffer.byteLength(block, "utf8"));
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

    let overhead = 0;
    if (entry.memory.length > 0) {
      event.system.push({ type: "text", text: entry.memory });
      overhead += Buffer.byteLength(entry.memory, "utf8");
    }
    if (entry.block.length > 0) {
      event.system.push({ type: "text", text: entry.block });
      overhead += Math.max(0, Buffer.byteLength(entry.block, "utf8") - entry.passageBytes);
    }
    if (entry.memory.length === 0 && entry.block.length === 0) return;

    if (entry.block.length > 0) {
      const locations = seen.get(event.sessionID) ?? new Set<string>();
      for (const key of entry.locations) locations.add(key);
      seen.set(event.sessionID, locations);
    }

    options.onInject?.();
    if (overhead > 0) options.onCost?.(event.sessionID, overhead);
  });
}

async function recallMemories(
  text: string,
  options: SessionHookOptions,
  injected: Set<string>,
): Promise<string> {
  const memory = options.getMemory();
  if (!memory) return "";

  const terms = contentTerms(text);
  const hits = (await memory.recall(text, 3)).filter((hit) => {
    if (injected.has(hit.id)) return false;
    const topic = typeof hit.metadata.topic === "string" ? hit.metadata.topic : "";
    return coversTerms(`${topic}\n${hit.text}`, terms, MEMORY_COVERAGE_RATIO);
  });
  if (hits.length === 0) return "";

  const block = formatMemories(hits, options.config.context.memoryTokens * 4);
  if (block.length === 0) return "";

  for (const hit of hits) injected.add(hit.id);
  return block;
}

/** A passage's identity for session dedupe: same file and same line. */
function locationKey(hit: { path: string | null; line: number | null; index: string }): string {
  return `${hit.path ?? hit.index}:${hit.line ?? 0}`;
}

async function retrieve(
  search: SearchService,
  text: string,
  options: SessionHookOptions,
  exclude: (hit: SearchHit) => boolean,
): Promise<Awaited<ReturnType<SearchService["search"]>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.config.context.timeoutMs);

  try {
    return await search.search(text, {
      surface: "context",
      k: options.config.context.maxPassages,
      maxTokens: options.config.context.maxTokens,
      signal: controller.signal,
      exclude,
    });
  } finally {
    clearTimeout(timer);
  }
}
