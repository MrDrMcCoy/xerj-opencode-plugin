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
import {
  buildRecallBlock,
  recallKey,
  type CitedLocation,
  type RecallReader,
} from "../rehydrate.ts";
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
  /** Receives every prompt, including ones the gate skips, for the archive. */
  readonly onPromptArchive?: (sessionID: string, text: string) => void;
  /** Reports a prompt whose passages the relevance gate dropped entirely. */
  readonly onNoiseSkip?: () => void;
  /** Resets the idle deadline; called for every prompt and model call. */
  readonly onActivity?: (sessionID?: string) => void;
  /** Stops the compaction watch when the plugin shuts down. */
  readonly signal?: AbortSignal;
  /** Project root used to re-read cited files after a compaction. */
  readonly projectRoot?: string;
  /** Reads a cited file for post-compaction recall; tests replace it. */
  readonly readRecallFile?: RecallReader;
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
  /** The same passages as file and line, for post-compaction recall. */
  readonly recall: ReadonlyArray<CitedLocation>;
}

const MIN_QUERY_LENGTH = 12;
const MIN_CONTENT_TERMS = 2;
// Tracking is per session and bounded: a long-lived server must not grow.
const MAX_TRACKED_SESSIONS = 200;
const MAX_LOCATIONS_PER_SESSION = 512;

/** Inserts as the newest entry and evicts the oldest session past the cap. */
function forgetOldest<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_TRACKED_SESSIONS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}
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

/**
 * One line is enough when the gate rejected every passage: it names the file
 * that might help and leaves the decision to the model. Cheaper than injecting
 * a passage the prompt never asked for.
 */
export function formatHintBlock(
  hit: { path: string | null; line: number | null; index: string },
  prompt: string,
): string {
  const location = `${hit.path ?? hit.index}${hit.line === null ? "" : `:${hit.line}`}`;
  const terms = prompt.trim().replace(/\s+/g, " ").slice(0, 80);
  return [
    "<xerj-hint>",
    `Possible match: ${location}.`,
    `Call xerj_search "${terms}" if that file is what you need.`,
    "</xerj-hint>",
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

  // Every per-session record is bounded: a server can run for days and see
  // thousands of sessions, so nothing here may grow without limit.
  const prepared = new Map<string, Prepared>();
  const lastInjected = new Map<string, string>();
  const memoriesShown = new Map<string, Set<string>>();
  // Locations already in this session's context; injecting them again spends
  // budget on text the model can already see.
  const seen = new Map<string, Set<string>>();
  const summarized = new Map<string, true>();
  // The passages the session is currently working from, and the snapshot taken
  // when the host compacted, waiting for the next model call.
  const working = new Map<string, ReadonlyArray<CitedLocation>>();
  const recallable = new Map<string, ReadonlyArray<CitedLocation>>();
  // The summariser itself must not receive recall; only the agent loop does.
  const compacting = new Set<string>();

  await ctx.session.hook("prompt", async (event) => {
    options.onActivity?.(event.sessionID);
    const text = event.prompt.text.trim();
    if (text.length > 0) options.onPromptArchive?.(event.sessionID, text);
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

      const shown = memoriesShown.get(event.sessionID) ?? new Set<string>();
      const memory = await recallMemories(text, options, shown);
      if (memory.length > 0) forgetOldest(memoriesShown, event.sessionID, shown);

      if (result.hits.length === 0 && memory.length === 0) {
        const hint = await retrieveHint(search, text, options, already);
        if (hint === null) {
          options.onNoiseSkip?.();
          return;
        }

        forgetOldest(prepared, event.sessionID, {
          messageID: event.messageID,
          block: formatHintBlock(hint, text),
          passageBytes: 0,
          memory: "",
          hits: 0,
          locations: [],
          recall: [],
        });
        return;
      }
      forgetOldest(prepared, event.sessionID, {
        messageID: event.messageID,
        block: result.text.trim().length === 0 ? "" : formatContextBlock(result.text),
        passageBytes: result.text.trim().length === 0 ? 0 : result.bytes,
        memory,
        hits: result.hits.length,
        locations: result.hits.map(locationKey),
        recall: result.hits.flatMap((hit) =>
          hit.path === null ? [] : [{ path: hit.path, line: hit.line ?? 1 }],
        ),
      });
    } catch (error) {
      options.logger.debug("prompt retrieval skipped", String(error));
    }
  });

  await ctx.session.hook("context", async (event) => {
    options.onActivity?.(event.sessionID);
    // The compaction request is the summariser's own call; it needs the
    // history it is about to replace, not a recall of it.
    if (compacting.has(event.sessionID)) return;
    if (!summarized.has(event.sessionID)) {
      forgetOldest(summarized, event.sessionID, true);
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
    const duplicate =
      entry !== undefined &&
      lastInjected.get(event.sessionID) === entry.messageID;
    let overhead = 0;
    let injected = false;
    // A fresh retrieval with real passages supersedes the pre-compaction
    // working set; recall would only spend budget on the same question.
    let freshHits = false;

    if (entry !== undefined && !duplicate) {
      forgetOldest(lastInjected, event.sessionID, entry.messageID);
      prepared.delete(event.sessionID);

      if (entry.memory.length > 0) {
        event.system.push({ type: "text", text: entry.memory });
        overhead += Buffer.byteLength(entry.memory, "utf8");
      }
      if (entry.block.length > 0) {
        event.system.push({ type: "text", text: entry.block });
        overhead += Math.max(
          0,
          Buffer.byteLength(entry.block, "utf8") - entry.passageBytes,
        );
      }

      if (entry.memory.length > 0 || entry.block.length > 0) {
        injected = true;
        freshHits = entry.hits > 0 && entry.block.length > 0;
        if (entry.block.length > 0) {
          rememberLocations(seen, event.sessionID, entry.locations);
        }
        if (entry.recall.length > 0) {
          forgetOldest(working, event.sessionID, entry.recall);
        }
      }
    }

    // The host compacted this session. Restore a few passages from its own
    // working set once, on the first call that is not the summariser itself.
    const snapshot = recallable.get(event.sessionID);
    if (snapshot !== undefined) {
      recallable.delete(event.sessionID);
      if (!freshHits) {
        const recall = await buildRecall({
          options,
          entry,
          snapshot,
        });
        if (recall !== null) {
          event.system.push({ type: "text", text: recall.text });
          overhead += recall.bytes;
          rememberLocations(seen, event.sessionID, recall.locations);
          const restored = snapshot.filter((location) =>
            recall.locations.includes(recallKey(location)),
          );
          if (restored.length > 0) {
            forgetOldest(working, event.sessionID, restored);
          }
          injected = true;
        }
      }
    }

    if (!injected) return;
    options.onInject?.();
    if (overhead > 0) options.onCost?.(event.sessionID, overhead);
  });

  // The summariser's own request is the one call that must not receive
  // recall, and `kind` is the only signal that distinguishes it.
  await ctx.session.hook("model.request", async (event) => {
    if (event.kind === "compaction") {
      compacting.add(event.sessionID);
      return;
    }
    compacting.delete(event.sessionID);
  });

  // The host compacts history on its own. What it drops is gone from the
  // window, so a passage injected before the compaction has to be allowed
  // back in; otherwise the plugin goes quiet exactly when room is tightest.
  void watchCompaction(ctx, options, {
    seen,
    memoriesShown,
    prepared,
    working,
    recallable,
  });
}

/** Adds keys to the session's dedupe set, evicting the oldest past the cap. */
function rememberLocations(
  seen: Map<string, Set<string>>,
  sessionID: string,
  keys: ReadonlyArray<string>,
): void {
  if (keys.length === 0) return;
  const locations = seen.get(sessionID) ?? new Set<string>();
  for (const key of keys) {
    locations.add(key);
    // A long session at the cap would stop deduping rather than grow; the
    // oldest key leaves first.
    if (locations.size > MAX_LOCATIONS_PER_SESSION) {
      const oldest = locations.values().next().value;
      if (oldest !== undefined) locations.delete(oldest);
    }
  }
  forgetOldest(seen, sessionID, locations);
}

// A recall is a bonus, so it never delays a turn for long: three file reads
// on a slow disk are dropped rather than admitted late.
const RECALL_DEADLINE_MS = 120;

async function buildRecall(input: {
  readonly options: SessionHookOptions;
  readonly entry: Prepared | undefined;
  readonly snapshot: ReadonlyArray<CitedLocation>;
}) {
  const { options, entry, snapshot } = input;
  if (!options.config.context.rehydrate) return null;
  if (options.projectRoot === undefined) return null;

  const covered = new Set(entry?.locations ?? []);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), RECALL_DEADLINE_MS);
  });

  try {
    const block = buildRecallBlock({
      projectRoot: options.projectRoot,
      locations: snapshot,
      maxBytes: options.config.context.rehydrateTokens * 4,
      exclude: (key) => covered.has(key),
      readFile: options.readRecallFile,
    });
    return await Promise.race([block, deadline]);
  } catch (error) {
    options.logger.debug("post-compaction recall failed", String(error));
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The event stream shape this file needs; the host provides more. */
interface EventStream {
  subscribe(options?: {
    readonly types?: ReadonlyArray<string>;
    readonly signal?: AbortSignal;
  }): AsyncIterable<unknown>;
}

/**
 * Forgets what a session was told before a compaction. Nothing else changes:
 * the prompt hook stays the only place that decides to inject.
 */
async function watchCompaction(
  ctx: Plugin.Context,
  options: SessionHookOptions,
  state: {
    readonly seen: Map<string, Set<string>>;
    readonly memoriesShown: Map<string, Set<string>>;
    readonly prepared: Map<string, Prepared>;
    readonly working: Map<string, ReadonlyArray<CitedLocation>>;
    readonly recallable: Map<string, ReadonlyArray<CitedLocation>>;
  },
): Promise<void> {
  const events = (ctx as { event?: EventStream }).event;
  if (events === undefined || typeof events.subscribe !== "function") return;

  try {
    for await (const raw of events.subscribe({
      types: ["session.compaction.ended"],
      signal: options.signal,
    })) {
      const sessionID = sessionOf(raw);
      if (sessionID === null) continue;

      // Keep the working set for one recall, then forget what the session was
      // told: the summary no longer carries those passages, so they must be
      // allowed back in.
      const working = state.working.get(sessionID);
      if (working !== undefined && working.length > 0) {
        forgetOldest(state.recallable, sessionID, working);
      }
      state.working.delete(sessionID);
      state.prepared.delete(sessionID);
      state.seen.delete(sessionID);
      state.memoriesShown.delete(sessionID);
      options.logger.debug("cleared injection dedupe after a compaction", sessionID);
    }
  } catch (error) {
    // An aborted or failed watch must not take the hooks down with it.
    options.logger.debug("compaction watch stopped", String(error));
  }
}

/** The session a compaction event belongs to, when it names one. */
function sessionOf(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const data = (raw as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const sessionID = (data as { sessionID?: unknown }).sessionID;
  return typeof sessionID === "string" ? sessionID : null;
}

async function recallMemories(
  text: string,
  options: SessionHookOptions,
  /** Memory ids this session already received. */
  shown: Set<string>,
): Promise<string> {
  const memory = options.getMemory();
  if (!memory) return "";

  const terms = contentTerms(text);
  const hits = (await memory.recall(text, 3)).filter((hit) => {
    if (shown.has(hit.id)) return false;
    const topic = typeof hit.metadata.topic === "string" ? hit.metadata.topic : "";
    return coversTerms(`${topic}\n${hit.text}`, terms, MEMORY_COVERAGE_RATIO);
  });
  if (hits.length === 0) return "";

  const block = formatMemories(hits, options.config.context.memoryTokens * 4);
  if (block.length === 0) return "";

  for (const hit of hits) shown.add(hit.id);
  return block;
}

/** A passage's identity for session dedupe: same file and same line. */
function locationKey(hit: { path: string | null; line: number | null; index: string }): string {
  return `${hit.path ?? hit.index}:${hit.line ?? 0}`;
}

/**
 * The best candidate when the gate rejected everything, with a short deadline:
 * a hint is a bonus, so it never delays the turn for long.
 */
const HINT_TIMEOUT_MS = 150;

async function retrieveHint(
  search: SearchService,
  text: string,
  options: SessionHookOptions,
  exclude: Set<string> | undefined,
): Promise<SearchHit | null> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.min(HINT_TIMEOUT_MS, options.config.context.timeoutMs),
  );

  try {
    const result = await search.search(text, {
      surface: "context",
      k: 1,
      maxTokens: 40,
      hint: true,
      signal: controller.signal,
      exclude: (hit) => exclude?.has(locationKey(hit)) ?? false,
    });
    return result.hits[0] ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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
      trustSemantic: options.config.index.neural,
    });
  } finally {
    clearTimeout(timer);
  }
}
