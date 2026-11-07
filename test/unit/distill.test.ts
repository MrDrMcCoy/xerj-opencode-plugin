import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import {
  distillTurn,
  extractCandidates,
  extractSentences,
  retireDistilled,
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
});
