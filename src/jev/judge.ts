// The local judgement: one request to the jevos server, two questions over the
// same state, and one five-way kind choice.
//
// Calibrated on the labeled set in `scripts/distill-labels.ts` (2026-11-06,
// jevos-v5): no single question separates durable statements from noise well.
// "Durable fact" scores facts and constraints high but leaves preferences
// low; "rule or decision" scores rules high but leaves facts low. Taking the
// larger of the two scores 13 of 14 at a 0.35 floor, with the one miss a
// preference the heuristic already classifies.
//
// The state is the sentence alone. Adding the turn around it, before or after,
// lowered every positive and cost three to five of the eight accepted
// sentences at the same floor. The wording is a constant so a test can pin
// it.

import type { Logger } from "../log.ts";
import type { JudgeVerdict, ModelJudge } from "../memory/distill.ts";

export const JEVOS_DURABLE_INSTRUCTIONS =
  "Is the sentence a durable fact about the project that will remain true?";

export const JEVOS_APPLIES_INSTRUCTIONS =
  "Is this a project rule or decision that applies to all future work?";

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
  /** P(keep) floor, 0..1, applied to the larger of the two answers. */
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
        durable: { type: "noul", instructions: JEVOS_DURABLE_INSTRUCTIONS },
        applies: { type: "noul", instructions: JEVOS_APPLIES_INSTRUCTIONS },
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
    const durable = noul(answers.durable);
    const applies = noul(answers.applies);
    if (durable === null || applies === null) {
      throw new Error("jevos returned no keep probability");
    }
    const score = Math.max(durable, applies);

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
      durable: round3(durable),
      applies: round3(applies),
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
