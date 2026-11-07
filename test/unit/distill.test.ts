import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import {
  distillTurn,
  extractCandidates,
  extractSentences,
  makeModelJudge,
  retireDistilled,
  type JudgeSample,
} from "../../src/memory/distill.ts";
import type { MemoryStore } from "../../src/memory/store.ts";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

function fakeStore(): {
  memory: MemoryStore;
  texts: Set<string>;
  forget: string[];
} {
  const texts = new Set<string>();
  const forget: string[] = [];
  const memory = {
    remember: async (input: { text: string }) => {
      if (texts.has(input.text)) return { id: "same", created: false };
      texts.add(input.text);
      return { id: `m${texts.size}`, created: true };
    },
    forget: async (id: string) => {
      forget.push(id);
      return true;
    },
    scan: async () => [],
  } as unknown as MemoryStore;
  return { memory, texts, forget };
}

describe("sentence extraction", () => {
  test("splits on sentences and drops fenced code", () => {
    const text =
      "We decided to use SQLite. ```const x = 1;``` Keep the splitter honest.";
    expect(extractSentences(text)).toEqual([
      "We decided to use SQLite.",
      "Keep the splitter honest.",
    ]);
  });
});

describe("candidate classification", () => {
  test("recognises decisions, constraints, conventions, and facts", () => {
    const decisions = extractCandidates("", "We decided to use SQLite for the store.");
    expect(decisions[0]).toMatchObject({ kind: "decision" });
    expect(decisions[0]!.score).toBeGreaterThan(0.6);

    const constraints = extractCandidates(
      "",
      "The indexer must run on musl and never shell out to a package manager.",
    );
    expect(constraints[0]).toMatchObject({ kind: "constraint" });

    const conventions = extractCandidates("", "By convention, every tool lives in src/tools.");
    expect(conventions[0]).toMatchObject({ kind: "convention" });

    const facts = extractCandidates(
      "",
      "The sweep runs hourly; see src/index/watcher.ts:44 for the timer.",
    );
    expect(facts[0]).toMatchObject({ kind: "fact" });
    expect(facts[0]!.score).toBeGreaterThan(0.6);
  });

  test("rejects questions, hedges, plans, and code", () => {
    expect(extractCandidates("", "Should we use SQLite?")).toEqual([]);
    expect(extractCandidates("", "Maybe we decided to use SQLite.")).toEqual([]);
    expect(
      extractCandidates("", "Let me check whether the indexer must run on musl."),
    ).toEqual([]);
    expect(extractCandidates("", "```\nWe decided to use SQLite.\n```")).toEqual([]);
  });

  test("a preference in the prompt is a preference, not a task", () => {
    const candidates = extractCandidates("I prefer terse replies, never a summary.", "");
    expect(candidates[0]).toMatchObject({ kind: "preference", origin: "prompt" });
  });

  test("deduplicates the same sentence across prompt and answer", () => {
    const sentence = "We decided to use SQLite for the store.";
    expect(extractCandidates(sentence, sentence)).toHaveLength(1);
  });
});

describe("distilling a turn", () => {
  const config = { ...DEFAULT_CONFIG.memory.distill, enabled: true };

  test("stores what clears the threshold and skips the rest", async () => {
    const { memory } = fakeStore();
    const summary = await distillTurn({
      memory,
      prompt: "which store",
      answer: "We decided to use SQLite. Maybe it might work. Should we test?",
      sessionID: "s1",
      config,
      logger,
    });

    expect(summary.promoted).toBe(1);
    expect(summary.candidates).toBeGreaterThanOrEqual(1);
    expect(summary.rejected).toBeGreaterThanOrEqual(0);
  });

  test("honours maxPerTurn", async () => {
    const { memory } = fakeStore();
    const summary = await distillTurn({
      memory,
      prompt: "",
      answer:
        "We decided to use SQLite. We decided to use WAL. We decided to use one file. We decided to use no server.",
      sessionID: "s1",
      config: { ...config, maxPerTurn: 2 },
      logger,
    });
    expect(summary.promoted).toBe(2);
  });

  test("emits one tuning record per judged candidate", async () => {
    const { memory } = fakeStore();
    const samples: JudgeSample[] = [];
    await distillTurn({
      memory,
      prompt: "",
      answer: "We decided to use SQLite. We decided to use WAL for the journal.",
      sessionID: "s1",
      config: { ...config, judge: "model" },
      logger,
      judgeModel: async () => ({ keep: true, score: 0.8, kind: "decision" }),
      onJudge: (sample) => samples.push(sample),
    });

    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({
      judge: "model",
      verdict: { keep: true },
      heuristicKind: "decision",
      kind: "decision",
      outcome: "promoted",
      sessionID: "s1",
    });
    expect(samples[0]!.score).toBeCloseTo(0.8);
    expect(typeof samples[0]!.judgeMs).toBe("number");
  });

  test("records a rejected candidate with no verdict when the judge is absent", async () => {
    const { memory } = fakeStore();
    const samples: JudgeSample[] = [];
    await distillTurn({
      memory,
      prompt: "",
      answer: "The collector must never open a port unless share.enabled is true.",
      sessionID: "s1",
      config: { ...config, judge: "local", minConfidence: 99 },
      logger,
      onJudge: (sample) => samples.push(sample),
    });

    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ judge: "heuristic", verdict: null });
  });

  test("reports a repeat as a duplicate rather than creating one", async () => {
    const { memory } = fakeStore();
    const turn = {
      memory,
      prompt: "",
      answer: "We decided to use SQLite for the store.",
      sessionID: "s1",
      config,
      logger,
    };
    await distillTurn(turn);
    const second = await distillTurn(turn);
    expect(second.promoted).toBe(0);
    expect(second.duplicates).toBe(1);
  });

  test("the local judge is called like any other judge", async () => {
    const { memory } = fakeStore();
    let calls = 0;
    const summary = await distillTurn({
      memory,
      prompt: "",
      answer: "We decided to use SQLite.",
      sessionID: "s1",
      config: { ...config, judge: "local" },
      logger,
      judgeModel: async () => {
        calls += 1;
        return { keep: false, score: 0.9 };
      },
    });

    expect(calls).toBe(1);
    expect(summary.judge).toBe("local");
    expect(summary.promoted).toBe(0);
  });

  test("a judge's own score is not gated by minConfidence again", async () => {
    const { memory } = fakeStore();
    const summary = await distillTurn({
      memory,
      prompt: "",
      answer: "We decided to use SQLite.",
      sessionID: "s1",
      config: { ...config, judge: "model", minConfidence: 90 },
      logger,
      judgeModel: async () => ({ keep: true, score: 0.05 }),
    });

    expect(summary.judge).toBe("model");
    expect(summary.promoted).toBe(1);
  });

  test("model judge without a model falls back to the heuristic", async () => {
    const { memory } = fakeStore();
    const summary = await distillTurn({
      memory,
      prompt: "",
      answer: "We decided to use SQLite.",
      sessionID: "s1",
      config: { ...config, judge: "model" },
      logger,
    });
    expect(summary.judge).toBe("heuristic");
    expect(summary.promoted).toBe(1);
  });

  test("a supplied model judge can reject a candidate", async () => {
    const { memory } = fakeStore();
    const summary = await distillTurn({
      memory,
      prompt: "",
      answer: "We decided to use SQLite.",
      sessionID: "s1",
      config: { ...config, judge: "model" },
      logger,
      judgeModel: async () => ({ keep: false }),
    });
    expect(summary.judge).toBe("model");
    expect(summary.promoted).toBe(0);
    expect(summary.rejected).toBe(1);
  });
});

describe("retirement", () => {
  test("drops the lowest-confidence distilled memories past the budget", async () => {
    const records = [
      {
        id: "a",
        text: "one",
        metadata: { source: "distill:heuristic", confidence: 0.9, created: "2026-01-01" },
      },
      {
        id: "b",
        text: "two",
        metadata: { source: "distill:heuristic", confidence: 0.6, created: "2026-01-02" },
      },
      {
        id: "c",
        text: "three",
        metadata: { source: "distill:heuristic", confidence: 0.7, created: "2026-01-03" },
      },
      { id: "note", text: "manual", metadata: { kind: "note" } },
    ];
    const forgotten: string[] = [];
    const memory = {
      scan: async () => records,
      forget: async (id: string) => {
        forgotten.push(id);
        return true;
      },
    } as unknown as MemoryStore;

    const retired = await retireDistilled({
      memory,
      maxPerProject: 1,
      logger,
    });

    expect(retired).toBe(2);
    expect(forgotten).toEqual(["b", "c"]);
  });

  test("counts extracted memories toward the same budget", async () => {
    const records = [
      {
        id: "extract",
        text: "one",
        metadata: { source: "extract:local", confidence: 0.9 },
      },
      {
        id: "distill",
        text: "two",
        metadata: { source: "distill:heuristic", confidence: 0.4 },
      },
    ];
    const forgotten: string[] = [];
    const memory = {
      scan: async () => records,
      forget: async (id: string) => {
        forgotten.push(id);
        return true;
      },
    } as unknown as MemoryStore;

    const retired = await retireDistilled({
      memory,
      maxPerProject: 1,
      logger,
    });

    expect(retired).toBe(1);
    expect(forgotten).toEqual(["distill"]);
  });
});

describe("model judge", () => {
  const config = {
    ...DEFAULT_CONFIG.memory.distill,
    enabled: true,
    judge: "model" as const,
  };

  test("parses a JSON verdict wrapped in prose", async () => {
    const judge = makeModelJudge({
      generate: async () => 'Sure.\n{"keep":true,"kind":"decision","score":0.82}',
      logger,
      contextChars: 500,
      timeoutMs: 1_000,
    });
    const verdict = await judge(
      { text: "We decided to use SQLite.", kind: "decision", score: 0.7, origin: "answer", reason: "cue" },
      { prompt: "which store", answer: "We decided to use SQLite." },
    );

    expect(verdict.keep).toBe(true);
    expect(verdict.kind).toBe("decision");
    expect(verdict.score).toBeCloseTo(0.82);
    expect(verdict.promptChars).toBeGreaterThan(0);
  });

  test("an unusable answer rejects so the caller keeps the heuristic", async () => {
    const judge = makeModelJudge({
      generate: async () => "I am not sure.",
      logger,
      contextChars: 500,
      timeoutMs: 1_000,
    });
    await expect(
      judge(
        { text: "We decided to use SQLite.", kind: "decision", score: 0.7, origin: "answer", reason: "cue" },
        { prompt: "which store", answer: "We decided." },
      ),
    ).rejects.toBeDefined();
  });

  test("a slow model times out", async () => {
    const judge = makeModelJudge({
      generate: () => new Promise(() => {}),
      logger,
      contextChars: 500,
      timeoutMs: 20,
    });
    await expect(
      judge(
        { text: "We decided to use SQLite.", kind: "decision", score: 0.7, origin: "answer", reason: "cue" },
        { prompt: "which store", answer: "We decided." },
      ),
    ).rejects.toThrow("timed out");
  });

  test("a failed model call falls back to the heuristic verdict", async () => {
    const { memory } = fakeStore();
    const summary = await distillTurn({
      memory,
      prompt: "",
      answer: "We decided to use SQLite.",
      sessionID: "s1",
      config,
      logger,
      judgeModel: async () => {
        throw new Error("offline");
      },
    });

    expect(summary.judge).toBe("model");
    expect(summary.calls).toBe(1);
    expect(summary.promoted).toBe(1);
  });

  test("modelMaxCalls bounds the calls, not the promotions", async () => {
    const { memory } = fakeStore();
    let calls = 0;
    const summary = await distillTurn({
      memory,
      prompt: "",
      answer: "We decided to use SQLite for the store. We decided to use WAL for the journal.",
      sessionID: "s1",
      config: { ...config, modelMaxCalls: 1 },
      logger,
      judgeModel: async () => {
        calls += 1;
        return { keep: true, score: 0.9, promptChars: 100 };
      },
    });

    expect(calls).toBe(1);
    expect(summary.calls).toBe(1);
    expect(summary.chars).toBe(100);
    expect(summary.promoted).toBe(2);
  });
});
