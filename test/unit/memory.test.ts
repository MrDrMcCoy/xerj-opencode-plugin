import { describe, expect, test } from "bun:test";
import type { Logger } from "../../src/log.ts";
import type { XerjClient } from "../../src/node/client.ts";
import { formatMemories, MemoryStore, normalizeKind } from "../../src/memory/store.ts";

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

function store(namespace = "proj-test"): MemoryStore {
  return new MemoryStore({} as XerjClient, namespace, logger);
}

describe("normalizeKind", () => {
  test("accepts the known kinds", () => {
    expect(normalizeKind("decision")).toBe("decision");
    expect(normalizeKind("preference")).toBe("preference");
  });

  test("falls back to fact", () => {
    expect(normalizeKind(undefined)).toBe("fact");
    expect(normalizeKind("gossip")).toBe("fact");
  });
});

describe("memoryId", () => {
  test("is stable for the same text", () => {
    expect(store().memoryId("Use RRF.")).toBe(store().memoryId("Use RRF."));
  });

  test("ignores surrounding whitespace", () => {
    expect(store().memoryId("  Use RRF.  ")).toBe(store().memoryId("Use RRF."));
  });

  test("is namespace scoped", () => {
    expect(store("a").memoryId("x")).not.toBe(store("b").memoryId("x"));
  });
});

describe("formatMemories", () => {
  test("includes the kind and one line per memory", () => {
    const block = formatMemories(
      [
        { id: "1", text: "Use RRF client-side.", metadata: { kind: "decision" }, score: 1 },
        { id: "2", text: "Prefer tabs.", metadata: {}, score: 1 },
      ],
      500,
    );

    expect(block).toContain("[mem 1] (decision) Use RRF client-side.");
    expect(block).toContain("[mem 2] (note) Prefer tabs.");
    expect(block.startsWith("<xerj-memory>")).toBe(true);
    expect(block.endsWith("</xerj-memory>")).toBe(true);
  });

  test("stays inside the character budget", () => {
    const hits = Array.from({ length: 20 }, (_, index) => ({
      id: String(index),
      text: "x".repeat(100),
      metadata: { kind: "fact" },
      score: 1,
    }));

    const block = formatMemories(hits, 300);
    expect(block.length).toBeLessThan(420);
  });

  test("returns an empty string when nothing fits", () => {
    expect(
      formatMemories([{ id: "1", text: "long", metadata: {}, score: 1 }], 5),
    ).toBe("");
  });
});
