// The local judgement: one request to the jevos server with the sentence as
// the state, one durability question, and one five-way kind choice.
//
// Calibrated on the labeled set in `scripts/distill-labels.ts` and on
// candidates mined from this project's turn archive (2026-11-06, jevos-v5).
// The question that works is contrastive: a lasting rule or fact, rather than
// a report of what was just done. Plain "is this a durable fact" wording
// accepted 24 of 40 real archived candidates, most of them progress reports.
// The contrastive wording keeps 10 of 11 durable sentences and rejects 9 of 10
// reports. Questions and hedges are not the model's job: the heuristic filter
// already drops them before a candidate reaches a judge.
//
// The state is the sentence alone. Adding the turn around it, before or after,
// lowered every positive and cost three to five of the eight accepted
// sentences. The wording is a constant so a test can pin it.

import type { Logger } from "../log.ts";
import type { JudgeVerdict, ModelJudge } from "../memory/distill.ts";

export const JEVOS_KEEP_INSTRUCTIONS =
  "Is this sentence a lasting project rule or fact, rather than a report of " +
  "what was just done?";

export type JudgedKind =
  | "decision"
  | "constraint"
  | "convention"
  | "preference"
  | "fact";

export const JEVOS_KIND_INSTRUCTIONS =
  "Which of these best describes the sentence: a decision, a constraint, " +
  "a convention, a preference, or a fact?";

export const JEVOS_KIND_CRITERIA: Readonly<Record<JudgedKind, string>> = {
  decision: "a choice the project will keep, such as an engine or an approach",
  constraint: "a limit or requirement the project must obey",
  convention: "a naming, layout, or style rule the code follows",
  preference: "a way the user wants the work done",
  fact: "a stable fact about the project, its paths, or its configuration",
};

const KIND_ORDER: ReadonlyArray<JudgedKind> = [
  "decision",
  "constraint",
  "convention",
  "preference",
  "fact",
];

export interface JevosJudgeOptions {
  readonly baseUrl: string;
  /** P(keep) floor, 0..1. The report question scores conservatively. */
  readonly threshold: number;
  /** Choice confidence floor, 0..1; below it the heuristic kind stays. */
  readonly kindConfidence: number;
  readonly timeoutMs: number;
  readonly logger: Logger;
}

export function makeJevosJudge(options: JevosJudgeOptions): ModelJudge {
  return async (candidate) => {
    const state = candidate.text;
    const body = {
      model: "jev-latest",
      state,
      questions: {
        keep: { type: "noul", instructions: JEVOS_KEEP_INSTRUCTIONS },
        kind: {
          type: "choice",
          instructions: JEVOS_KIND_INSTRUCTIONS,
          criteria: Object.fromEntries(
            KIND_ORDER.map((kind) => [kind, JEVOS_KIND_CRITERIA[kind]]),
          ),
        },
      },
    };

    const response = await fetch(`${options.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) throw new Error(`jevos answered ${response.status}`);

    const answers = asRecord(asRecord(await response.json()).answers);
    const score = noul(answers.keep);
    if (score === null) throw new Error("jevos returned no keep probability");

    const kindAnswer = asRecord(answers.kind);
    const choice = typeof kindAnswer.choice === "string" ? kindAnswer.choice : null;
    const confidence =
      typeof kindAnswer.confidence === "number" ? clamp01(kindAnswer.confidence) : 0;
    const kind =
      choice !== null &&
      KIND_ORDER.includes(choice as JudgedKind) &&
      confidence >= options.kindConfidence
        ? (choice as JudgedKind)
        : undefined;

    const verdict: JudgeVerdict = {
      keep: score >= options.threshold,
      score,
      ...(kind === undefined ? {} : { kind }),
      promptChars: state.length + JSON.stringify(body.questions).length,
    };
    options.logger.debug("jevos judged a candidate", {
      keep: verdict.keep,
      score: round3(score),
      kind: kind ?? "heuristic",
    });
    return verdict;
  };
}

function noul(value: unknown): number | null {
  const answer = asRecord(value);
  return typeof answer.noul === "number" ? clamp01(answer.noul) : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}
