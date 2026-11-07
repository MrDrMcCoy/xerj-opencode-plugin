import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import {
  extractWindow,
  registerCompactionExtraction,
} from "../../src/memory/extract.ts";
import type { MemoryStore } from "../../src/memory/store.ts";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

const config = {
  ...DEFAULT_CONFIG.memory.extract,
  enabled: true,
};

function fakeStore(): { memory: MemoryStore; metadata: Array<Record<string, unknown>> } {
  const texts = new Set<string>();
  const metadata: Array<Record<string, unknown>> = [];
  const memory = {
    remember: async (input: {
      text: string;
      metadata?: Record<string, unknown>;
    }) => {
      metadata.push(input.metadata ?? {});
      if (texts.has(input.text)) return { id: "same", created: false };
      texts.add(input.text);
      return { id: `m${texts.size}`, created: true };
    },
  } as unknown as MemoryStore;
  return { memory, metadata };
}

const records = [
  {
    role: "user",
    text: "We decided to use SQLite for the local store.",
  },
  {
    role: "assistant",
    text: "The collector must never open a port unless sharing is on.",
  },
  {
    role: "tool",
    text: "The build printed a long list of compiler warnings.",
  },
];

describe("compaction hook", () => {
  test("runs extraction on the window and returns before the judge", async () => {
    const { memory, metadata } = fakeStore();
    const hooks: Array<(event: unknown) => void> = [];
    const ctx = {
      session: {
        hook: async (_name: string, handler: (event: unknown) => void) => {
          hooks.push(handler);
        },
      },
    };
    await registerCompactionExtraction(ctx as never, {
      memory,
      config,
      judge: "model",
      minConfidence: 0.55,
      maxCalls: 3,
      judgeModel: async () => ({ keep: true, score: 0.9, kind: "decision" }),
      logger,
      signal: new AbortController().signal,
    });

    expect(hooks).toHaveLength(1);
    hooks[0]?.({
      sessionID: "s1",
      messages: [
        {
          id: "m1",
          role: "user",
          content: [{ type: "text", text: "We decided to use SQLite for the store." }],
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(metadata).toHaveLength(1);
    expect(metadata[0]?.source).toBe("extract:model");
  });
});

describe("window extraction", () => {
  test("stores a judged fact and marks its source", async () => {
    const { memory, metadata } = fakeStore();
    const summary = await extractWindow({
      records,
      memory,
      sessionID: "s1",
      config,
      judge: "model",
      minConfidence: 0.55,
      maxCalls: 3,
      judgeModel: async () => ({ keep: true, score: 0.9, kind: "decision" }),
      logger,
    });

    expect(summary.promoted).toBe(2);
    expect(summary.judge).toBe("model");
    expect(metadata[0]).toMatchObject({
      source: "extract:model",
      derived: true,
      origin: "prompt",
    });
  });

  test("caps facts per window and skips tool output", async () => {
    const { memory } = fakeStore();
    const summary = await extractWindow({
      records,
      memory,
      sessionID: "s1",
      config: { ...config, maxFacts: 1 },
      judge: "model",
      minConfidence: 0.55,
      maxCalls: 3,
      judgeModel: async () => ({ keep: true, score: 0.9, kind: "decision" }),
      logger,
    });

    expect(summary.promoted).toBe(1);
    expect(summary.candidates).toBeGreaterThanOrEqual(2);
  });

  test("a duplicate window is counted instead of stored twice", async () => {
    const { memory } = fakeStore();
    const input = {
      records,
      memory,
      sessionID: "s1",
      config,
      judge: "heuristic" as const,
      minConfidence: 0.55,
      maxCalls: 3,
      logger,
    };
    await extractWindow(input);
    const second = await extractWindow(input);
    expect(second.promoted).toBe(0);
    expect(second.duplicates).toBeGreaterThan(0);
  });

  test("the heuristic route needs no judge model", async () => {
    const { memory } = fakeStore();
    const summary = await extractWindow({
      records,
      memory,
      sessionID: "s1",
      config,
      judge: "local",
      minConfidence: 0.55,
      maxCalls: 3,
      logger,
    });

    expect(summary.judge).toBe("heuristic");
    expect(summary.calls).toBe(0);
    expect(summary.promoted).toBeGreaterThan(0);
  });
});
