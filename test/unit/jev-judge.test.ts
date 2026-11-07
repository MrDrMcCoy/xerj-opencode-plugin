import { afterEach, describe, expect, test } from "bun:test";
import {
  JEVOS_KEEP_INSTRUCTIONS,
  makeJevosJudge,
} from "../../src/jev/judge.ts";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

const candidate = {
  text: "We decided to use SQLite instead of Postgres.",
  kind: "decision" as const,
  score: 0.7,
  origin: "answer" as const,
  reason: "cue",
};

const turn = {
  prompt: "which store should we use?",
  answer: "We decided to use SQLite instead of Postgres.",
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type Answers = Record<string, unknown>;

function answer(answers: Answers, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ answers }), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function judge(overrides: { threshold?: number; kindConfidence?: number } = {}) {
  return makeJevosJudge({
    baseUrl: "http://127.0.0.1:8017",
    threshold: overrides.threshold ?? 0.15,
    kindConfidence: overrides.kindConfidence ?? 0.4,
    timeoutMs: 1_000,
    logger,
  });
}

describe("jevos judge", () => {
  test("keeps the model's keep probability and its kind", async () => {
    answer({
      keep: { type: "noul", noul: 0.61 },
      kind: { type: "choice", choice: "decision", confidence: 0.8 },
    });

    const verdict = await judge()(candidate, turn);
    expect(verdict.keep).toBe(true);
    expect(verdict.score).toBeCloseTo(0.61);
    expect(verdict.kind).toBe("decision");
    expect(verdict.promptChars).toBeGreaterThan(0);
  });

  test("rejects a report below the floor", async () => {
    answer({
      keep: { type: "noul", noul: 0.09 },
      kind: { type: "choice", choice: "fact", confidence: 0.9 },
    });

    const verdict = await judge()(candidate, turn);
    expect(verdict.keep).toBe(false);
    expect(verdict.score).toBeCloseTo(0.09);
  });

  test("keeps the heuristic kind when the choice is unsure", async () => {
    answer({
      keep: { type: "noul", noul: 0.96 },
      kind: { type: "choice", choice: "fact", confidence: 0.2 },
    });

    expect((await judge()(candidate, turn)).kind).toBeUndefined();
  });

  test("ignores a kind outside the five classes", async () => {
    answer({
      keep: { type: "noul", noul: 0.96 },
      kind: { type: "choice", choice: "note", confidence: 0.9 },
    });

    expect((await judge()(candidate, turn)).kind).toBeUndefined();
  });

  test("a missing probability is a failed judgement", async () => {
    answer({ kind: {} });
    await expect(judge()(candidate, turn)).rejects.toBeDefined();
  });

  test("an HTTP failure is a failed judgement", async () => {
    answer({ detail: "boom" }, 500);
    await expect(judge()(candidate, turn)).rejects.toThrow("500");
  });

  test("sends the sentence alone with the keep question and kind criteria", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          answers: {
            keep: { type: "noul", noul: 0.9 },
            kind: { type: "choice", choice: "decision", confidence: 0.9 },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await judge()(candidate, turn);

    expect(body.state).toBe(candidate.text);
    const questions = body.questions as Record<string, { instructions: string }>;
    expect(questions.keep?.instructions).toBe(JEVOS_KEEP_INSTRUCTIONS);
    expect(questions.kind).toBeDefined();
  });
});
