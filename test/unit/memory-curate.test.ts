import { describe, expect, test } from "bun:test";
import { curateMemories, normalize, overlap } from "../../src/memory/curate.ts";
import type { MemoryRecord, MemoryStore } from "../../src/memory/store.ts";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

function store(records: MemoryRecord[]): {
  memory: MemoryStore;
  forgotten: string[];
  revisions: Array<{ id: string; metadata: Record<string, unknown> }>;
} {
  const forgotten: string[] = [];
  const revisions: Array<{ id: string; metadata: Record<string, unknown> }> = [];
  const memory = {
    scan: async () => records,
    forget: async (id: string) => {
      forgotten.push(id);
      return true;
    },
    revise: async (record: MemoryRecord, metadata: Record<string, unknown>) => {
      revisions.push({ id: record.id, metadata });
    },
  } as unknown as MemoryStore;
  return { memory, forgotten, revisions };
}

describe("normalize", () => {
  test("strips case, punctuation, and spacing", () => {
    expect(normalize("The  Node idles for 30 minutes.")).toBe("the node idles for 30 minutes");
  });
});

describe("overlap", () => {
  test("identical texts overlap fully", () => {
    expect(overlap("the node idles for 30 minutes", "the node idles for 30 minutes")).toBe(1);
  });

  test("unrelated texts do not", () => {
    expect(overlap("the node idles", "citations are measured")).toBe(0);
  });
});

describe("curateMemories", () => {
  test("an exact duplicate summary is dropped, newest kept", async () => {
    const { memory, forgotten } = store([
      { id: "old", text: "The sweep runs hourly.", metadata: { kind: "summary" } },
      { id: "new", text: "the sweep runs hourly", metadata: { kind: "summary" } },
    ]);

    const summary = await curateMemories({ memory, logger: logger as never });

    expect(summary.merged).toBe(1);
    expect(forgotten).toEqual(["old"]);
  });

  test("a duplicated user fact is flagged, never forgotten", async () => {
    const { memory, forgotten, revisions } = store([
      { id: "a", text: "We chose the loopback socket.", metadata: { kind: "decision" } },
      { id: "b", text: "we chose the loopback socket", metadata: { kind: "decision" } },
    ]);

    const summary = await curateMemories({ memory, logger: logger as never });

    expect(summary.merged).toBe(0);
    expect(summary.flagged).toBe(1);
    expect(forgotten).toEqual([]);
    expect(revisions[0]?.metadata.duplicateOf).toBe("a");
  });

  test("a near-duplicate summary is flagged against the earlier one", async () => {
    const text = "the sweep runs hourly and writes a journal beside the index";
    const { memory, revisions } = store([
      { id: "a", text, metadata: { kind: "summary" } },
      { id: "b", text: `${text} state`, metadata: { kind: "summary" } },
    ]);

    const summary = await curateMemories({ memory, logger: logger as never });

    expect(summary.flagged).toBe(1);
    expect(revisions[0]?.metadata.duplicateOf).toBe("a");
  });

  test("distinct memories are left alone", async () => {
    const { memory, forgotten, revisions } = store([
      { id: "a", text: "The node idles for thirty minutes.", metadata: { kind: "summary" } },
      { id: "b", text: "Citations use path:line.", metadata: { kind: "fix" } },
    ]);

    const summary = await curateMemories({ memory, logger: logger as never });

    expect(summary).toMatchObject({ merged: 0, flagged: 0 });
    expect(forgotten).toEqual([]);
    expect(revisions).toEqual([]);
  });
});
