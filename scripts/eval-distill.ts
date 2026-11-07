// Measures the two distillation judges on the labeled set.
//
// The heuristic always runs. The model judge runs only when an
// OpenAI-compatible chat endpoint and a key are supplied, because the plugin's
// own model lives inside the host and a script cannot borrow it:
//
//   DISTILL_EVAL_URL=https://openrouter.ai/api/v1/chat/completions \
//   DISTILL_EVAL_MODEL=anthropic/claude-haiku-5.5 \
//   DISTILL_EVAL_KEY=sk-... \
//   bun run eval:distill
//
// The numbers answer the question the roadmap leaves open: does the model judge
// keep the labeled decisions and reject the labeled noise better than the
// heuristic, for the calls it costs?

import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  extractCandidates,
  makeModelJudge,
  type Candidate,
  type ModelJudge,
} from "../src/memory/distill.ts";
import type { Logger } from "../src/log.ts";
import { ACCEPT, REJECT, type Label } from "./distill-labels.ts";

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

const MIN_SCORE = DEFAULT_CONFIG.memory.distill.minConfidence / 100;

interface Tally {
  accepted: number;
  falsePositives: number;
  classOk: number;
  calls: number;
}

function empty(): Tally {
  return { accepted: 0, falsePositives: 0, classOk: 0, calls: 0 };
}

function heuristicCandidate(label: Label): Candidate | null {
  const candidates = extractCandidates(
    label.origin === "prompt" ? label.text : "",
    label.origin === "answer" ? label.text : "",
  );
  return candidates.find((candidate) => candidate.score >= MIN_SCORE) ?? null;
}

function runHeuristic(): Tally {
  const tally = empty();
  for (const label of ACCEPT) {
    const candidate = heuristicCandidate(label);
    if (candidate === null) continue;
    tally.accepted += 1;
    if (candidate.kind === label.kind) tally.classOk += 1;
  }
  for (const text of REJECT) {
    if (heuristicCandidate({ text, kind: "fact", origin: "answer" })) {
      tally.falsePositives += 1;
    }
  }
  return tally;
}

async function runModel(judge: ModelJudge): Promise<Tally> {
  const tally = empty();

  for (const label of ACCEPT) {
    const candidate: Candidate = {
      text: label.text,
      kind: label.kind,
      score: MIN_SCORE,
      origin: label.origin,
      reason: "label",
    };
    tally.calls += 1;
    const verdict = await judge(candidate, { prompt: "", answer: label.text })
      .catch(() => null);
    if (verdict === null) continue;
    if (verdict.keep) tally.accepted += 1;
    if (verdict.keep && (verdict.kind ?? candidate.kind) === label.kind) {
      tally.classOk += 1;
    }
  }

  for (const text of REJECT) {
    const candidate: Candidate = {
      text,
      kind: "fact",
      score: MIN_SCORE,
      origin: "answer",
      reason: "label",
    };
    tally.calls += 1;
    const verdict = await judge(candidate, { prompt: "", answer: text })
      .catch(() => null);
    if (verdict !== null && verdict.keep) tally.falsePositives += 1;
  }

  return tally;
}

function report(name: string, tally: Tally): void {
  const recall = Math.round((tally.accepted / ACCEPT.length) * 100);
  const precision =
    tally.accepted + tally.falsePositives === 0
      ? 100
      : Math.round(
          (tally.accepted / (tally.accepted + tally.falsePositives)) * 100,
        );
  console.log(
    `${name.padEnd(10)} accepted ${tally.accepted}/${ACCEPT.length} (${recall}%) · ` +
      `false positives ${tally.falsePositives}/${REJECT.length} · ` +
      `precision ${precision}% · ` +
      `class ${tally.classOk}/${ACCEPT.length}` +
      (tally.calls > 0 ? ` · ${tally.calls} calls` : ""),
  );
}

async function main(): Promise<void> {
  report("heuristic", runHeuristic());

  const url = process.env.DISTILL_EVAL_URL?.trim();
  const model = process.env.DISTILL_EVAL_MODEL?.trim();
  const key = process.env.DISTILL_EVAL_KEY?.trim();
  if (!url || !model || !key) {
    console.log(
      "\nmodel judge skipped: set DISTILL_EVAL_URL, DISTILL_EVAL_MODEL, and DISTILL_EVAL_KEY to compare it",
    );
    return;
  }

  const judge = makeModelJudge({
    generate: (prompt) => chat({ url, model, key, prompt }),
    logger,
    contextChars: DEFAULT_CONFIG.memory.distill.modelContextChars,
    timeoutMs: DEFAULT_CONFIG.memory.distill.modelTimeoutMs,
  });
  report("model", await runModel(judge));
}

async function chat(options: {
  readonly url: string;
  readonly model: string;
  readonly key: string;
  readonly prompt: string;
}): Promise<string> {
  const response = await fetch(options.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      temperature: 0,
      max_tokens: 120,
      messages: [{ role: "user", content: options.prompt }],
    }),
  });
  if (!response.ok) {
    throw new Error(`endpoint answered ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

void main().catch((error: unknown) => {
  console.error(String(error));
  process.exitCode = 1;
});
