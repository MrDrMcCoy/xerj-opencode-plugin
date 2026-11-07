// Live context distillation: turn a finished turn into typed memories, and
// retire what stops being true.
//
// This is not compaction. The plugin never reads, reorders, or rewrites the
// model's window; it reads the turn's own prompt and answer after the answer
// exists, classifies a few sentences, and writes the durable ones to memory.
// Retirement is by evidence and contradiction, never by "irrelevant right
// now": a decision stays true whether or not this turn needed it.

import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";
import type { MemoryKind, MemoryStore } from "./store.ts";

export type JudgeMode = "heuristic" | "model" | "local";

export interface Candidate {
  readonly text: string;
  readonly kind: MemoryKind;
  readonly score: number;
  readonly origin: "prompt" | "answer";
  readonly reason: string;
}

export interface JudgeVerdict {
  readonly keep: boolean;
  readonly score?: number;
  readonly kind?: MemoryKind;
  /** Characters of prompt the judgement cost, for telemetry. */
  readonly promptChars?: number;
}

/** Added later: one model call per candidate, bounded by the caller. */
export type ModelJudge = (
  candidate: Candidate,
  turn: { readonly prompt: string; readonly answer: string },
) => Promise<JudgeVerdict>;

export interface DistillTurnInput {
  readonly memory: MemoryStore;
  readonly prompt: string;
  readonly answer: string;
  readonly sessionID: string;
  readonly config: Config["memory"]["distill"];
  readonly logger: Logger;
  /** Present when the model judge is wired; absent falls back to heuristic. */
  readonly judgeModel?: ModelJudge;
  /** Receives one sample per judged candidate, for tuning telemetry. */
  readonly onJudge?: (sample: JudgeSample) => void;
}

/**
 * One candidate's journey through the judge. `verdict` is null when the judge
 * failed or was unavailable and the heuristic decided instead.
 */
export interface JudgeSample {
  readonly judge: JudgeMode;
  readonly verdict: JudgeVerdict | null;
  readonly text: string;
  readonly origin: Candidate["origin"];
  readonly heuristicKind: MemoryKind;
  readonly heuristicScore: number;
  readonly kind: MemoryKind;
  readonly score: number;
  readonly threshold: number;
  readonly outcome: "promoted" | "duplicate" | "rejected";
  readonly sessionID: string;
  /** Wall time of the judge call; absent when the heuristic decided. */
  readonly judgeMs?: number;
}

export interface DistillSummary {
  readonly judge: JudgeMode;
  readonly candidates: number;
  readonly promoted: number;
  readonly duplicates: number;
  readonly rejected: number;
  /** Model calls spent, and the prompt characters they carried. */
  readonly calls: number;
  readonly chars: number;
}

export interface RetireInput {
  readonly memory: MemoryStore;
  readonly maxPerProject: number;
  readonly logger: Logger;
}

const MIN_SENTENCE = 24;
const MAX_SENTENCE = 320;
const MAX_TOPIC = 80;
const DISTILL_SOURCE = "distill:";

/** Fenced code is a quotation, not a claim. */
const FENCE = /```[\s\S]*?```/g;

/** A sentence that is a question, a plan, or a hedge is not a memory. */
const REJECT = [
  /\?$/,
  /\b(let me|let's|i'll|i will check|next,? i|here'?s what|for example|for instance)\b/i,
  /\b(maybe|perhaps|might|possibly|not sure|i think|probably|seems|unsure|tbd)\b/i,
  /^(q|a):\s/i,
];

interface Rule {
  readonly kind: MemoryKind;
  readonly pattern: RegExp;
  readonly base: number;
}

// Order is priority: a decision outranks the constraint words inside it.
const CLASSES: ReadonlyArray<Rule> = [
  {
    kind: "decision",
    pattern:
      /\b(decided|decision is|we (will|chose|agreed|settled)|i (chose|agreed)|settled on|going with|instead of)\b/i,
    base: 0.7,
  },
  {
    kind: "preference",
    pattern:
      /\b(i prefer|i'?d rather|i would rather|please (always|never)|do not ask|always use)\b/i,
    base: 0.72,
  },
  {
    kind: "constraint",
    pattern:
      /\b(must|must not|required|only|never|always|cannot|can'?t|do not|don'?t)\b/i,
    base: 0.66,
  },
  {
    kind: "convention",
    pattern: /\b(convention|by convention|the rule is|we use|naming|style is)\b/i,
    base: 0.6,
  },
  {
    kind: "fact",
    pattern:
      /\b[\w./-]+\.\w+:\d+\b|\bv?\d+\.\d+(\.\d+)?\b|`[a-z]+\.[a-zA-Z]+`|\b[a-z]{2,}\.[a-z][a-zA-Z]{2,}\b/,
    base: 0.58,
  },
];

const EVIDENCE = /\b[\w./-]+\.\w+:\d+\b|`[a-z]+\.[a-zA-Z]+`/;

/**
 * Sentences worth a candidate, from the assistant's answer and the user's
 * prompt. Nothing here touches the message window.
 */
export function extractCandidates(
  prompt: string,
  answer: string,
): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  const add = (text: string, origin: "prompt" | "answer"): void => {
    for (const sentence of extractSentences(text)) {
      if (REJECT.some((pattern) => pattern.test(sentence))) continue;
      const rule = CLASSES.find((entry) => entry.pattern.test(sentence));
      if (rule === undefined) continue;

      const key = sentence.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const evidence = EVIDENCE.test(sentence) ? 0.08 : 0;
      candidates.push({
        text: sentence,
        kind: rule.kind,
        score: Math.min(0.95, rule.base + evidence),
        origin,
        reason: `${rule.kind} cue`,
      });
    }
  };

  add(answer, "answer");
  add(prompt, "prompt");
  return candidates.sort((left, right) => right.score - left.score);
}

export interface ModelJudgeOptions {
  readonly generate: (prompt: string) => Promise<string>;
  readonly logger: Logger;
  /** Characters of the turn shown to the model. */
  readonly contextChars: number;
  /** Deadline for one judgement. */
  readonly timeoutMs: number;
}

const MODEL_KINDS: ReadonlySet<string> = new Set([
  "decision",
  "constraint",
  "convention",
  "preference",
  "fact",
]);

/**
 * Asks the current model about one candidate. The answer must be a JSON
 * object; anything else is a failed judgement, and the caller keeps the
 * heuristic verdict rather than losing the candidate.
 */
export function makeModelJudge(options: ModelJudgeOptions): ModelJudge {
  return async (candidate, turn) => {
    const prompt = [
      "You decide whether one sentence belongs in durable project memory.",
      `Sentence: ${candidate.text}`,
      `Session prompt: ${clip(turn.prompt, Math.floor(options.contextChars * 0.4))}`,
      `Session answer: ${clip(turn.answer, Math.floor(options.contextChars * 0.6))}`,
      "",
      "Keep it only if it is a durable statement that stays true in a later",
      "session: a decision, constraint, convention, preference, or fact.",
      "Reject plans, questions, hypotheses, and observations of tool output.",
      'Answer with JSON only: {"keep":true|false,"kind":"decision|constraint|convention|preference|fact","score":0.0}',
    ].join("\n");

    const answer = await withDeadline(
      options.generate(prompt),
      options.timeoutMs,
    );
    const verdict = parseVerdict(answer);
    if (verdict === null) {
      options.logger.debug("model judge answered nothing usable", clip(answer, 120));
      throw new Error("model judge returned no verdict");
    }
    return { ...verdict, promptChars: prompt.length };
  };
}

/** Promotes the candidates that clear the threshold; never throws at a turn. */
export async function distillTurn(input: DistillTurnInput): Promise<DistillSummary> {
  const threshold = input.config.minConfidence / 100;
  const judge: JudgeMode = input.config.judge;
  const candidates = extractCandidates(input.prompt, input.answer);
  let promoted = 0;
  let duplicates = 0;
  let rejected = 0;
  let used = judge;
  let calls = 0;
  let chars = 0;

  if (judge !== "heuristic" && input.judgeModel === undefined) {
    // The configured judge is unavailable (no host model, no local install,
    // an unsupported platform). Say so rather than claiming its label.
    input.logger.debug(
      `memory.distill.judge is ${judge}, but that judge is unavailable; using heuristic`,
    );
    used = "heuristic";
  }

  for (const candidate of candidates) {
    if (promoted >= input.config.maxPerTurn) break;

    let kept = candidate.score >= threshold;
    let score = candidate.score;
    let kind = candidate.kind;
    let judged = false;
    let judgedVerdict: JudgeVerdict | null = null;
    let judgeMs: number | undefined;

    if (
      used !== "heuristic" &&
      input.judgeModel !== undefined &&
      calls < input.config.modelMaxCalls
    ) {
      calls += 1;
      const started = performance.now();
      const verdict = await input.judgeModel(candidate, {
        prompt: input.prompt,
        answer: input.answer,
      }).catch((error: unknown) => {
        input.logger.debug("model judge failed; keeping the heuristic", String(error));
        return null;
      });
      if (verdict !== null) {
        chars += verdict.promptChars ?? 0;
        kept = verdict.keep;
        score = verdict.score ?? score;
        kind = verdict.kind ?? kind;
        judged = true;
        judgedVerdict = verdict;
        judgeMs = performance.now() - started;
      }
    }

    const emit = (outcome: JudgeSample["outcome"]): void => {
      if (input.onJudge === undefined) return;
      try {
        input.onJudge({
          judge: used,
          verdict: judgedVerdict,
          text: candidate.text,
          origin: candidate.origin,
          heuristicKind: candidate.kind,
          heuristicScore: candidate.score,
          kind,
          score,
          threshold,
          outcome,
          sessionID: input.sessionID,
          ...(judgeMs === undefined ? {} : { judgeMs }),
        });
      } catch (error) {
        input.logger.debug("judge telemetry callback failed", String(error));
      }
    };

    // A judge answers on its own scale, so its score only gates when the
    // verdict fell back to the heuristic.
    if (!kept || (!judged && score < threshold)) {
      rejected += 1;
      emit("rejected");
      continue;
    }

    const result = await input.memory
      .remember({
        text: candidate.text,
        kind,
        topic: clip(input.prompt, MAX_TOPIC),
        sessionID: input.sessionID,
        metadata: {
          source: `${DISTILL_SOURCE}${used}`,
          confidence: Number(score.toFixed(2)),
          origin: candidate.origin,
        },
      })
      .catch((error: unknown) => {
        input.logger.debug("could not store a distilled memory", String(error));
        return null;
      });

    if (result === null) {
      rejected += 1;
      emit("rejected");
      continue;
    }
    if (result.created) {
      promoted += 1;
      emit("promoted");
    } else {
      duplicates += 1;
      emit("duplicate");
    }
  }

  return {
    judge: used,
    candidates: candidates.length,
    promoted,
    duplicates,
    rejected,
    calls,
    chars,
  };
}

/**
 * Keeps the distilled store inside its budget. Lowest confidence goes first,
 * oldest first at equal confidence. Explicit memories are never touched.
 */
export function startDistillRetention(
  input: RetireInput & {
    readonly signal: AbortSignal;
    /** Times the sweep, so its cost sits beside the extraction cost. */
    readonly measure?: (body: () => Promise<number>) => Promise<number>;
  },
): void {
  const run = (): void => {
    const body = (): Promise<number> =>
      retireDistilled({
        memory: input.memory,
        maxPerProject: input.maxPerProject,
        logger: input.logger,
      });
    void (input.measure === undefined
      ? body()
      : input.measure(body)
    ).catch((error: unknown) => {
      input.logger.debug("memory distill retention failed", String(error));
    });
  };

  run();
  const timer = setInterval(run, 60 * 60_000);
  timer.unref?.();
  input.signal.addEventListener("abort", () => clearInterval(timer), {
    once: true,
  });
}

export async function retireDistilled(input: RetireInput): Promise<number> {
  const records = await input.memory.scan(Math.max(50, input.maxPerProject * 2));
  const distilled = records.filter((record) => {
    const source = record.metadata.source;
    return typeof source === "string" && source.startsWith(DISTILL_SOURCE);
  });
  const excess = distilled.length - input.maxPerProject;
  if (excess <= 0) return 0;

  const ranked = [...distilled].sort((left, right) => {
    const leftScore = numberOr(left.metadata.confidence, 0);
    const rightScore = numberOr(right.metadata.confidence, 0);
    if (leftScore !== rightScore) return leftScore - rightScore;
    return String(left.metadata.created ?? "").localeCompare(
      String(right.metadata.created ?? ""),
    );
  });

  let removed = 0;
  for (const record of ranked.slice(0, excess)) {
    const forgotten = await input.memory.forget(record.id).catch(() => false);
    if (forgotten) removed += 1;
  }
  if (removed > 0) {
    input.logger.info("retired distilled memories", {
      retired: removed,
      kept: distilled.length - removed,
    });
  }
  return removed;
}

export function extractSentences(text: string): string[] {
  return text
    .replace(FENCE, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter(
      (sentence) =>
        sentence.length >= MIN_SENTENCE && sentence.length <= MAX_SENTENCE,
    );
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function parseVerdict(text: string): JudgeVerdict | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (match === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as { keep?: unknown; score?: unknown; kind?: unknown };
  if (typeof record.keep !== "boolean") return null;

  const score =
    typeof record.score === "number" && Number.isFinite(record.score)
      ? Math.min(1, Math.max(0, record.score))
      : undefined;
  const kind =
    typeof record.kind === "string" && MODEL_KINDS.has(record.kind)
      ? (record.kind as MemoryKind)
      : undefined;
  return { keep: record.keep, score, kind };
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("model judge timed out")), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
