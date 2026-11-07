// Fact mining from the pre-compaction window.
//
// The `compaction` hook still holds the messages the summary is about to
// replace. This flattens their user and assistant text, classifies the
// sentences with the same candidate extractor the turn distiller uses, and
// writes the durable ones to memory. It is gated by `memory.extract.enabled`
// and off by default: the precision of the window is not measured yet.
//
// The write is fire-and-forget. A compaction must finish, so a slow judge or a
// failed memory write is logged and never delays the summary.

import type { Plugin } from "@opencode/plugin";
import { MAX_WINDOW_MESSAGES, captureWindow } from "../archive/window.ts";
import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";
import type { ArchiveRecord } from "../archive/turns.ts";
import {
  extractCandidates,
  type JudgeMode,
  type ModelJudge,
} from "./distill.ts";
import type { MemoryStore } from "./store.ts";

export interface ExtractWindowInput {
  readonly records: ReadonlyArray<{
    readonly role: string;
    readonly text: string;
  }>;
  readonly memory: MemoryStore;
  readonly sessionID: string;
  readonly config: Config["memory"]["extract"];
  readonly judge: JudgeMode;
  readonly minConfidence: number;
  readonly maxCalls: number;
  readonly judgeModel?: ModelJudge;
  readonly logger: Logger;
}

export interface ExtractSummary {
  readonly judge: JudgeMode;
  readonly candidates: number;
  readonly promoted: number;
  readonly duplicates: number;
  readonly rejected: number;
  readonly calls: number;
}

const SOURCE = "extract:";
const TOPIC = "compaction window";

/** Mines one window; never throws at the caller. */
export async function extractWindow(
  input: ExtractWindowInput,
): Promise<ExtractSummary> {
  const prompt = textFor(input.records, "user");
  const answer = textFor(input.records, "assistant");
  const candidates = extractCandidates(prompt, answer);
  const threshold = input.minConfidence;
  let used = input.judge;
  if (used !== "heuristic" && input.judgeModel === undefined) {
    used = "heuristic";
  }

  let promoted = 0;
  let duplicates = 0;
  let rejected = 0;
  let calls = 0;

  for (const candidate of candidates) {
    if (promoted >= input.config.maxFacts) break;

    let kept = candidate.score >= threshold;
    let score = candidate.score;
    let kind = candidate.kind;
    let judged = false;

    if (
      used !== "heuristic" &&
      input.judgeModel !== undefined &&
      calls < input.maxCalls
    ) {
      calls += 1;
      const verdict = await input.judgeModel(candidate, {
        prompt,
        answer,
      }).catch((error: unknown) => {
        input.logger.debug("window judge failed; keeping the heuristic", String(error));
        return null;
      });
      if (verdict !== null) {
        kept = verdict.keep;
        score = verdict.score ?? score;
        kind = verdict.kind ?? kind;
        judged = true;
      }
    }

    if (!kept || (!judged && score < threshold)) {
      rejected += 1;
      continue;
    }

    const result = await input.memory
      .remember({
        text: candidate.text,
        kind,
        topic: TOPIC,
        sessionID: input.sessionID,
        metadata: {
          source: `${SOURCE}${used}`,
          derived: true,
          confidence: Number(score.toFixed(2)),
          origin: candidate.origin,
        },
      })
      .catch((error: unknown) => {
        input.logger.debug("could not store an extracted memory", String(error));
        return null;
      });

    if (result === null) {
      rejected += 1;
    } else if (result.created) {
      promoted += 1;
    } else {
      duplicates += 1;
    }
  }

  return {
    judge: used,
    candidates: candidates.length,
    promoted,
    duplicates,
    rejected,
    calls,
  };
}

function textFor(
  records: ReadonlyArray<{ readonly role: string; readonly text: string }>,
  role: "user" | "assistant",
): string {
  return records
    .filter((record) => record.role === role)
    .map((record) => record.text)
    .join("\n\n")
    .trim();
}

export interface CompactionExtractionOptions {
  readonly memory: MemoryStore;
  readonly config: Config["memory"]["extract"];
  readonly judge: JudgeMode;
  readonly minConfidence: number;
  readonly maxCalls: number;
  readonly judgeModel?: ModelJudge;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly owns?: (sessionID: string) => boolean;
  readonly measure?: <T>(
    op: "memory.extract",
    body: () => Promise<T>,
    meta?: (result: T) => unknown,
  ) => Promise<T>;
}

/** Registers the extraction half of the `compaction` hook. */
export async function registerCompactionExtraction(
  ctx: Plugin.Context,
  options: CompactionExtractionOptions,
): Promise<void> {
  await ctx.session.hook("compaction", (event) => {
    if (options.signal.aborted) return;
    const sessionID = event.sessionID;
    if (options.owns !== undefined && !options.owns(sessionID)) return;

    let records: ReadonlyArray<ArchiveRecord>;
    try {
      records = captureWindow({
        messages: event.messages,
        seen: new Set<string>(),
        maxBytes: options.config.maxBytes,
        maxMessages: MAX_WINDOW_MESSAGES,
      }).records;
    } catch (error) {
      options.logger.debug("could not read the compaction window", String(error));
      return;
    }
    if (records.length === 0) return;

    const run = (): Promise<ExtractSummary> =>
      extractWindow({
        records,
        memory: options.memory,
        sessionID,
        config: options.config,
        judge: options.judge,
        minConfidence: options.minConfidence,
        maxCalls: options.maxCalls,
        judgeModel: options.judgeModel,
        logger: options.logger,
      });
    const measured =
      options.measure === undefined
        ? run()
        : options.measure("memory.extract", run, (result) => ({
            judge: result.judge,
            candidates: result.candidates,
            promoted: result.promoted,
            duplicates: result.duplicates,
            rejected: result.rejected,
            calls: result.calls,
          }));
    void measured
      .then((summary) => {
        if (summary.promoted > 0) {
          options.logger.debug("extracted memories from the compaction window", {
            sessionID,
            promoted: summary.promoted,
            candidates: summary.candidates,
          });
        }
      })
      .catch((error: unknown) => {
        options.logger.debug("memory extraction failed", String(error));
      });
  });
}
