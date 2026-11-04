// Automatic memory from compaction. `session.compaction.ended` carries the
// generated summary, so this subscribes to it instead of guessing at the
// `compaction` hook, which runs before the summary exists.

import type { Logger } from "../log.ts";
import type { MemoryStore } from "./store.ts";

type CompactionEnded = "session.compaction.ended";

interface EventSource {
  subscribe(options?: {
    readonly types?: ReadonlyArray<CompactionEnded>;
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
}

const DEFAULT_MIN_CHARS = 120;
const DEFAULT_MAX_CHARS = 4000;
const SUMMARY_TOPIC = "session summary";

/** Listens in the background; returns immediately so plugin setup stays fast. */
export function startCompactionCapture(options: CompactionCaptureOptions): void {
  const minChars = options.minChars ?? DEFAULT_MIN_CHARS;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  void (async () => {
    try {
      const events = options.events.subscribe({
        types: ["session.compaction.ended"],
        signal: options.signal,
      });
      for await (const raw of events) {
        if (!isRecord(raw) || raw.type !== "session.compaction.ended") continue;

        const data = isRecord(raw.data) ? raw.data : {};
        const text = typeof data.text === "string" ? data.text.trim() : "";
        if (text.length < minChars) continue;

        const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined;
        await options.memory
          .remember({
            text: text.slice(0, maxChars),
            kind: "summary",
            topic: SUMMARY_TOPIC,
            sessionID,
          })
          .catch((error: unknown) => {
            options.logger.debug("compaction memory failed", String(error));
          });
      }
    } catch (error) {
      // An aborted subscription is the normal shutdown path.
      if (!options.signal.aborted) {
        options.logger.debug("compaction capture stopped", String(error));
      }
    }
  })();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
