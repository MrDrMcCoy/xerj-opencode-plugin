import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatExpansion, parseTurns, TurnArchive } from "../../src/archive/turns.ts";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "xerj-archive-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

function archive(maxBytes?: number): TurnArchive {
  return new TurnArchive({
    directory: join(root, `sessions-${Math.random().toString(36).slice(2)}`),
    logger: logger as never,
    maxBytes,
  });
}

describe("parseTurns", () => {
  test("numbers turns from one and skips bad lines", () => {
    const text = [
      JSON.stringify({ role: "user", at: "2026-11-06", text: "hello" }),
      "not json",
      JSON.stringify({ role: "assistant", at: "2026-11-06", text: "hi" }),
      JSON.stringify({ role: "other", text: "skip" }),
    ].join("\n");

    const turns = parseTurns(text);

    expect(turns).toHaveLength(2);
    expect(turns[1]).toEqual({ ordinal: 2, role: "assistant", at: "2026-11-06", text: "hi" });
  });
});

describe("TurnArchive", () => {
  test("appends and expands a range", async () => {
    const store = archive();
    await store.append("s1", "user", "where is the watcher");
    await store.append("s1", "assistant", "in src/index/watcher.ts");

    const all = await store.expand("s1", 1, 10);
    expect(all.total).toBe(2);
    expect(all.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);

    const one = await store.expand("s1", 2, 2);
    expect(one.turns).toHaveLength(1);
    expect(one.turns[0]?.text).toContain("watcher.ts");
  });

  test("sessions are separate", async () => {
    const store = archive();
    await store.append("a", "user", "alpha");
    await store.append("b", "user", "beta");

    expect((await store.expand("a", 1, 5)).turns[0]?.text).toBe("alpha");
    expect((await store.expand("b", 1, 5)).turns[0]?.text).toBe("beta");
  });

  test("an unknown session reads nothing", async () => {
    expect((await archive().expand("nope", 1, 5)).total).toBe(0);
  });

  test("blank text is not archived", async () => {
    const store = archive();
    await store.append("s1", "user", "   ");

    expect((await store.expand("s1", 1, 5)).total).toBe(0);
  });

  test("a file past the cap keeps its tail", async () => {
    const store = archive(200);
    for (let index = 0; index < 20; index += 1) {
      await store.append("s1", "user", `turn ${index}`);
    }

    const result = await store.expand("s1", 1, 100);
    expect(result.total).toBeLessThan(20);
    expect(result.turns.at(-1)?.text).toBe("turn 19");
  });
});

describe("formatExpansion", () => {
  test("prefixes prompts and answers", () => {
    const text = formatExpansion({
      sessionID: "s1",
      total: 2,
      turns: [
        { ordinal: 1, role: "user", at: "", text: "q" },
        { ordinal: 2, role: "assistant", at: "", text: "a" },
      ],
    });

    expect(text).toBe("[1] U: q\n[2] A: a");
  });

  test("an empty archive says so", () => {
    expect(formatExpansion({ sessionID: "s1", total: 0, turns: [] })).toContain("No archived turns");
  });
});
