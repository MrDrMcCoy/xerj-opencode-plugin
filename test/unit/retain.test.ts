import { describe, expect, test } from "bun:test";
import {
  planPrune,
  pruneMemory,
  startRetention,
  type RetainEntry,
  type RetainLimits,
} from "../../src/memory/retain.ts";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const DAY = 86_400_000;

function entry(
  id: string,
  daysAgo: number | null,
  bytes = 100,
  kind = "summary",
): RetainEntry {
  return {
    id,
    kind,
    created: daysAgo === null ? null : new Date(NOW - daysAgo * DAY).toISOString(),
    bytes,
  };
}

const none: RetainLimits = { days: 0, maxCount: 0, maxBytes: 0 };

describe("planPrune", () => {
  test("keeps everything when every cap is disabled", () => {
    const entries = [entry("a", 400), entry("b", 1)];
    expect(planPrune(entries, none, NOW)).toEqual([]);
  });

  test("age alone drops summaries past the cutoff", () => {
    const entries = [entry("old", 120), entry("fresh", 10)];
    expect(planPrune(entries, { ...none, days: 90 }, NOW)).toEqual(["old"]);
  });

  test("count alone keeps the newest entries", () => {
    const entries = [entry("a", 1), entry("b", 2), entry("c", 3)];
    expect(planPrune(entries, { ...none, maxCount: 2 }, NOW)).toEqual(["c"]);
  });

  test("size alone keeps the newest entries until the byte cap", () => {
    const entries = [entry("a", 1, 100), entry("b", 2, 100), entry("c", 3, 100)];
    expect(planPrune(entries, { ...none, maxBytes: 250 }, NOW)).toEqual(["c"]);
  });

  test("age and size both apply in one pass", () => {
    const entries = [
      entry("fresh", 1, 100),
      entry("middle", 40, 100),
      entry("stale", 200, 100),
    ];
    // Age removes `stale`; the byte cap then removes the oldest survivor.
    expect(planPrune(entries, { days: 90, maxCount: 0, maxBytes: 150 }, NOW)).toEqual([
      "middle",
      "stale",
    ]);
  });

  test("count and size bind together, whichever is tighter", () => {
    const entries = [entry("a", 1, 100), entry("b", 2, 100), entry("c", 3, 100)];
    // Count allows two; bytes allow one.
    expect(planPrune(entries, { days: 0, maxCount: 2, maxBytes: 150 }, NOW)).toEqual([
      "b",
      "c",
    ]);
  });

  test("explicit memories are never pruned", () => {
    const entries = [
      entry("fact", 900, 100, "fact"),
      entry("decision", 900, 100, "decision"),
      entry("summary", 900, 100),
    ];
    expect(planPrune(entries, { days: 1, maxCount: 1, maxBytes: 1 }, NOW)).toEqual([
      "summary",
    ]);
  });

  test("an entry without a timestamp survives the age cap", () => {
    const entries = [entry("undated", null), entry("old", 400)];
    expect(planPrune(entries, { ...none, days: 90 }, NOW)).toEqual(["old"]);
  });

  test("an undated entry ranks as the oldest under the count cap", () => {
    const entries = [entry("undated", null, 100), entry("fresh", 1, 100)];
    expect(planPrune(entries, { ...none, maxCount: 1 }, NOW)).toEqual(["undated"]);
  });

  test("the newest entry always survives", () => {
    const entries = [entry("only", 900)];
    expect(planPrune(entries, { days: 1, maxCount: 1, maxBytes: 1_000 }, NOW)).toEqual([
      "only",
    ]);
  });
});

describe("pruneMemory", () => {
  function memory(
    entries: RetainEntry[],
  ): { memory: { list: () => Promise<RetainEntry[]>; forget: (id: string) => Promise<boolean> }; forgotten: string[] } {
    const forgotten: string[] = [];
    return {
      forgotten,
      memory: {
        list: async () => entries,
        forget: async (id: string) => {
          forgotten.push(id);
          return true;
        },
      },
    };
  }

  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    entries: async () => [],
    flush: async () => {},
  } as never;

  test("forgets the planned ids and reports the count", async () => {
    const { memory: store, forgotten } = memory([entry("a", 1), entry("b", 400)]);

    const removed = await pruneMemory({
      memory: store as never,
      limits: { days: 90, maxCount: 0, maxBytes: 0 },
      logger,
      now: NOW,
    });

    expect(removed).toBe(1);
    expect(forgotten).toEqual(["b"]);
  });

  test("an empty store is a no-op", async () => {
    const { memory: store, forgotten } = memory([]);
    const removed = await pruneMemory({
      memory: store as never,
      limits: { days: 1, maxCount: 1, maxBytes: 1 },
      logger,
      now: NOW,
    });

    expect(removed).toBe(0);
    expect(forgotten).toEqual([]);
  });
});

describe("startRetention", () => {
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    entries: async () => [],
    flush: async () => {},
  } as never;

  test("sweeps immediately and stops when the signal aborts", async () => {
    let listed = 0;
    const store = {
      list: async () => {
        listed += 1;
        return [];
      },
      forget: async () => true,
    };

    const controller = new AbortController();
    startRetention(store as never, { days: 1, maxCount: 0, maxBytes: 1 }, controller.signal, logger);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const afterAbort = listed;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(afterAbort).toBe(1);
    expect(listed).toBe(afterAbort);
  });

  test("a failing sweep is swallowed", async () => {
    const store = {
      list: async () => {
        throw new Error("node is down");
      },
      forget: async () => true,
    };

    const controller = new AbortController();
    startRetention(store as never, { days: 1, maxCount: 0, maxBytes: 1 }, controller.signal, logger);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
  });
});
