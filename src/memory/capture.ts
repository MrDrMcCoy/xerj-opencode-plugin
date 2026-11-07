// Automatic memory. `session.compaction.ended` carries the generated summary,
// so this subscribes to it instead of guessing at the `compaction` hook, which
// runs before the summary exists. Compaction is rare when another tool manages
// context, so each substantive turn's final answer is also captured.
//
// The event stream is server-wide: every project's sessions appear on it. Only
// sessions this instance saw a prompt for are captured, so another project's
// work never lands in this project's memory.

import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";
import {
  distillTurn,
  type DistillSummary,
  type ModelJudge,
} from "./distill.ts";
import type { MemoryStore } from "./store.ts";

type CaptureEvent =
  | "session.compaction.ended"
  | "session.text.ended"
  | "session.execution.succeeded";

interface EventSource {
  subscribe(options?: {
    readonly types?: ReadonlyArray<CaptureEvent>;
    readonly signal?: AbortSignal;
  }): AsyncIterable<unknown>;
}

export interface CompactionCaptureOptions {
  readonly events: EventSource;
  readonly memory: MemoryStore;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  /** Summaries shorter than this are throwaway; longer ones are clipped. */
  readonly minChars?: number;
  readonly maxChars?: number;
  /** Limits capture to this instance's sessions; omitted, every one counts. */
  readonly owns?: (sessionID: string) => boolean;
}

export interface TurnCaptureOptions {
  readonly events: EventSource;
  readonly memory: MemoryStore;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly prompts: SessionPrompts;
  /** Answers shorter than this are acknowledgements, not knowledge. */
  readonly minChars?: number;
  readonly maxChars?: number;
  /** Receives each answer verbatim for the turn archive. */
  readonly onAnswer?: (sessionID: string, text: string) => void;
  /** Typed memory extraction from the turn; absent leaves it off. */
  readonly distill?: {
    readonly config: Config["memory"]["distill"];
    readonly judgeModel?: ModelJudge;
  };
  /** Times the distill run for telemetry. */
  readonly measure?: <T>(
    op: "memory.distill",
    body: () => Promise<T>,
    meta?: (result: T) => unknown,
  ) => Promise<T>;
}

/**
 * The host folds its own bookkeeping prompts into compaction summaries and
 * turn prompts. They carry no project knowledge, so they are not stored.
 */
const INTERNAL_MARKER = /^mc:/;

const DEFAULT_MIN_CHARS = 120;
const DEFAULT_MAX_CHARS = 4000;
const SUMMARY_TOPIC = "session summary";

const TURN_MIN_CHARS = 400;
const TURN_MAX_CHARS = 1500;
const PROMPT_MAX_CHARS = 200;
const TOPIC_MAX_CHARS = 80;
const MAX_TRACKED_SESSIONS = 200;

/** The latest substantive prompt per session, bounded by insertion order. */
export class SessionPrompts {
  private readonly prompts = new Map<string, string>();

  constructor(private readonly limit = MAX_TRACKED_SESSIONS) {}

  note(sessionID: string, text: string): void {
    this.prompts.delete(sessionID);
    this.prompts.set(sessionID, text);
    while (this.prompts.size > this.limit) {
      const oldest = this.prompts.keys().next().value;
      if (oldest === undefined) break;
      this.prompts.delete(oldest);
    }
  }

  knows(sessionID: string): boolean {
    return this.prompts.has(sessionID);
  }

  latest(sessionID: string): string | undefined {
    return this.prompts.get(sessionID);
  }
}

/** Listens in the background; returns immediately so plugin setup stays fast. */
export function startCompactionCapture(options: CompactionCaptureOptions): void {
  const minChars = options.minChars ?? DEFAULT_MIN_CHARS;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  listen(options, ["session.compaction.ended"], "compaction capture", async (raw) => {
    if (raw.type !== "session.compaction.ended") return;

    const data = isRecord(raw.data) ? raw.data : {};
    const text = typeof data.text === "string" ? data.text.trim() : "";
    if (text.length < minChars || INTERNAL_MARKER.test(text)) return;

    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined;
    if (options.owns && (sessionID === undefined || !options.owns(sessionID))) return;

    await remember(options, {
      text: text.slice(0, maxChars),
      topic: SUMMARY_TOPIC,
      sessionID,
    });
  });
}

/** Per-session state for turn capture, bounded by the session list itself. */
interface TurnState {
  readonly answers: Map<string, string>;
  /** Memory id already stored for a prompt, so a repeat can replace it. */
  readonly stored: Map<string, string>;
}

/**
 * Stores the last text a turn produced, paired with the prompt that asked for
 * it. One memory per turn; ids hash the text, so a replayed event is a no-op.
 */
export function startTurnCapture(options: TurnCaptureOptions): void {
  const state: TurnState = { answers: new Map(), stored: new Map() };
  const types: CaptureEvent[] = ["session.text.ended", "session.execution.succeeded"];

  listen(options, types, "turn capture", async (raw) => {
    const data = isRecord(raw.data) ? raw.data : {};
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : null;
    if (sessionID === null || !options.prompts.knows(sessionID)) return;

    if (raw.type === "session.text.ended") {
      noteAnswer(state, sessionID, data.text);
      return;
    }
    if (raw.type === "session.execution.succeeded") {
      await storeTurn(state, sessionID, options);
    }
  });
}

/** A turn emits text several times; the last one is the answer. */
function noteAnswer(state: TurnState, sessionID: string, text: unknown): void {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed.length > 0) state.answers.set(sessionID, trimmed);
}

/** Pairs the answer with its prompt and stores one memory for the turn. */
async function storeTurn(
  state: TurnState,
  sessionID: string,
  options: TurnCaptureOptions,
): Promise<void> {
  const answer = state.answers.get(sessionID);
  state.answers.delete(sessionID);
  if (answer !== undefined) options.onAnswer?.(sessionID, answer);

  const prompt = options.prompts.latest(sessionID);
  if (answer === undefined || prompt === undefined) return;
  if (INTERNAL_MARKER.test(prompt)) return;

  // Distillation sees short turns too: "we decided to use Postgres" is a
  // decision even when the whole answer is one sentence.
  await maybeDistill(prompt, answer, sessionID, options);

  const minChars = options.minChars ?? TURN_MIN_CHARS;
  if (answer.length < minChars) return;

  const topic = clip(prompt, TOPIC_MAX_CHARS);
  const key = `${sessionID}\u0000${topic}`;
  const previous = state.stored.get(key);
  const id = await remember(options, {
    text: `Q: ${clip(prompt, PROMPT_MAX_CHARS)}\nA: ${clip(answer, options.maxChars ?? TURN_MAX_CHARS)}`,
    topic,
    sessionID,
  });
  if (id === undefined) return;

  state.stored.set(key, id);
  if (previous !== undefined && previous !== id) {
    await options.memory.forget(previous).catch(() => false);
  }
}

/** Runs the configured judge and logs what it decided. Never throws. */
async function maybeDistill(
  prompt: string,
  answer: string,
  sessionID: string,
  options: TurnCaptureOptions,
): Promise<void> {
  const distill = options.distill;
  if (distill === undefined || !distill.config.enabled) return;

  const run = (): Promise<DistillSummary> =>
    distillTurn({
      memory: options.memory,
      prompt,
      answer,
      sessionID,
      config: distill.config,
      logger: options.logger,
      judgeModel: distill.judgeModel,
    });

  try {
    const summary =
      options.measure === undefined
        ? await run()
        : await options.measure("memory.distill", run, (result) => ({
            judge: result.judge,
            candidates: result.candidates,
            promoted: result.promoted,
            duplicates: result.duplicates,
            rejected: result.rejected,
            calls: result.calls,
            chars: result.chars,
          }));
    if (summary.promoted > 0) {
      options.logger.debug("distilled memories from a turn", {
        judge: summary.judge,
        promoted: summary.promoted,
        candidates: summary.candidates,
      });
    }
  } catch (error) {
    options.logger.debug("memory distill failed", String(error));
  }
}

function listen(
  options: { events: EventSource; signal: AbortSignal; logger: Logger },
  types: CaptureEvent[],
  label: string,
  handle: (event: Record<string, unknown>) => Promise<void>,
): void {
  void (async () => {
    try {
      const events = options.events.subscribe({ types, signal: options.signal });
      for await (const raw of events) {
        if (isRecord(raw)) await handle(raw);
      }
    } catch (error) {
      // An aborted subscription is the normal shutdown path.
      if (!options.signal.aborted) {
        options.logger.debug(`${label} stopped`, String(error));
      }
    }
  })();
}

async function remember(
  options: { memory: MemoryStore; logger: Logger },
  input: { text: string; topic: string; sessionID?: string },
): Promise<string | undefined> {
  return await options.memory
    .remember({ ...input, kind: "summary" })
    .then((result) => result.id)
    .catch((error: unknown) => {
      options.logger.warn("memory capture failed", String(error));
      return undefined;
    });
}

function clip(text: string, max: number): string {
  const flat = text.trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
