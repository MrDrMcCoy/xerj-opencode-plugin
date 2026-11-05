import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../../src/log.ts";
import { Ledger } from "../../src/stats/ledger.ts";

const root = await mkdtemp(join(tmpdir(), "xerj-ledger-"));
afterAll(async () => rm(root, { recursive: true, force: true }));

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

function store(): { data: Map<string, unknown>; storage: { get: (k: string) => Promise<unknown>; set: (k: string, v: unknown) => Promise<void> } } {
  const data = new Map<string, unknown>();
  return {
    data,
    storage: {
      get: async (key) => data.get(key),
      set: async (key, value) => void data.set(key, value),
    },
  };
}

function ledger(
  storage: { get: (k: string) => Promise<unknown>; set: (k: string, v: unknown) => Promise<void> },
  key = "stats/lifetime:test",
): Ledger {
  return new Ledger({
    storage,
    key,
    projectRoot: root,
    bytesPerToken: 4,
    maxBaselineBytes: 1000,
    logger,
  });
}

describe("Ledger", () => {
  test("credits file size once and subtracts what the model read", async () => {
    await writeFile(join(root, "a.txt"), "a".repeat(100));
    await writeFile(join(root, "b.txt"), "b".repeat(200));

    const { storage } = store();
    const accounting = ledger(storage);

    await accounting.recordQuery("session-1", ["a.txt", "b.txt"], 50, 2);
    let snapshot = accounting.snapshot("session-1");
    expect(snapshot.queries).toBe(1);
    expect(snapshot.hits).toBe(1);
    expect(snapshot.baselineBytes).toBe(300);
    expect(snapshot.savedBytes).toBe(250);
    expect(snapshot.tokensSaved).toBe(63);

    await accounting.recordRead("session-1", "a.txt", 100);
    snapshot = accounting.snapshot("session-1");
    expect(snapshot.baselineBytes).toBe(200);
    expect(snapshot.savedBytes).toBe(150);
    expect(snapshot.filesRead).toBe(1);

    await accounting.flush();
  });

  test("nets injected tokens against tokens saved", async () => {
    await writeFile(join(root, "c.txt"), "c".repeat(400));

    const { storage } = store();
    const accounting = ledger(storage, "stats/lifetime:net");

    await accounting.recordQuery("session-n", ["c.txt"], 40, 1);
    await accounting.recordInjection(200);
    const snapshot = accounting.snapshot("session-n");
    expect(snapshot.tokensSaved).toBe(90);
    expect(snapshot.tokensCost).toBe(50);
    expect(snapshot.netTokens).toBe(40);

    await accounting.flush();
  });

  test("ranks cited files by how often they were cited", async () => {
    await writeFile(join(root, "x.txt"), "x".repeat(10));
    await writeFile(join(root, "y.txt"), "y".repeat(20));
    const { storage } = store();
    const accounting = ledger(storage);

    await accounting.recordQuery("s", ["x.txt", "y.txt"], 0, 2);
    await accounting.recordQuery("s", ["x.txt"], 0, 1);

    const top = accounting.snapshot("s").topFiles;
    expect(top[0]).toEqual({ path: "x.txt", citations: 2, bytes: 10 });
    expect(top[1]).toEqual({ path: "y.txt", citations: 1, bytes: 20 });
  });

  test("keeps projects separate in one shared storage", async () => {
    const { storage, data } = store();
    const alpha = ledger(storage, "stats/lifetime:alpha");
    const beta = ledger(storage, "stats/lifetime:beta");

    await alpha.recordQuery("s", [], 10, 1);
    await beta.recordQuery("s", [], 20, 0);
    await alpha.flush();
    await beta.flush();

    const saved = (key: string) => data.get(key) as { queries: number; returned: number };
    expect(saved("stats/lifetime:alpha")).toMatchObject({ queries: 1, returned: 10 });
    expect(saved("stats/lifetime:beta")).toMatchObject({ queries: 1, returned: 20 });
  });

  test("does not double count a file cited twice", async () => {
    await writeFile(join(root, "c.txt"), "c".repeat(50));
    const { storage } = store();
    const accounting = ledger(storage);

    await accounting.recordQuery("s", ["c.txt"], 10, 1);
    await accounting.recordQuery("s", ["c.txt"], 10, 1);

    expect(accounting.snapshot("s").baselineBytes).toBe(50);
    expect(accounting.snapshot("s").queries).toBe(2);
  });

  test("counts a miss without inflating the hit rate", async () => {
    const { storage } = store();
    const accounting = ledger(storage);

    await accounting.recordQuery("s", [], 0, 1);
    await accounting.recordQuery("s", [], 0, 0);

    const snapshot = accounting.snapshot("s");
    expect(snapshot.queries).toBe(2);
    expect(snapshot.hits).toBe(1);
    expect(snapshot.hitRate).toBe(0.5);
  });

  test("subtracts only the bytes a partial read covered", async () => {
    await writeFile(join(root, "p.txt"), "p".repeat(200));
    const { storage } = store();
    const accounting = ledger(storage);

    await accounting.recordQuery("s", ["p.txt"], 0, 1);
    await accounting.recordRead("s", "p.txt", 50);

    expect(accounting.snapshot("s").baselineBytes).toBe(150);
  });

  test("caps the baseline credited per file", async () => {
    await writeFile(join(root, "big.txt"), "x".repeat(5000));
    const { storage } = store();
    const accounting = ledger(storage);

    await accounting.recordQuery("s", ["big.txt"], 0, 1);
    expect(accounting.snapshot("s").baselineBytes).toBe(1000);
  });

  test("persists counters across instances", async () => {
    await writeFile(join(root, "d.txt"), "d".repeat(40));
    const { storage } = store();

    const first = ledger(storage);
    await first.recordQuery("s", ["d.txt"], 20, 1);
    await first.flush();

    const second = ledger(storage);
    await second.recordQuery("s2", [], 0, 0);

    expect(second.snapshot().queries).toBe(2);
    expect(second.snapshot().baselineBytes).toBe(40);
    expect(second.snapshot().topFiles[0]?.path).toBe("d.txt");
  });

  test("drops citations stored before the relevance gate, keeping counters", async () => {
    const { storage, data } = store();
    data.set("stats/lifetime:test", {
      queries: 9,
      hits: 8,
      citations: [["LICENSE", 7], ["src/a.ts", 2]],
    });

    const accounting = ledger(storage);
    await accounting.recordQuery("s", [], 0, 0);
    expect(accounting.snapshot().queries).toBe(10);
    expect(accounting.snapshot().topFiles).toEqual([]);
  });

  test("leaves generated files out of the top cited list", async () => {
    await writeFile(join(root, "bun.lock"), "lock");
    await writeFile(join(root, "e.txt"), "e");
    const { storage } = store();
    const accounting = ledger(storage);

    await accounting.recordQuery("s", ["bun.lock", "e.txt"], 0, 1);
    expect(accounting.snapshot().topFiles.map((file) => file.path)).toEqual(["e.txt"]);
  });
});
