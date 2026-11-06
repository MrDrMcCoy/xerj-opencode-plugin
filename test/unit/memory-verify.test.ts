import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStale, pathsIn, verifyMemories } from "../../src/memory/verify.ts";
import type { MemoryRecord, MemoryStore } from "../../src/memory/store.ts";

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
  root = await mkdtemp(join(tmpdir(), "xerj-verify-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "config.ts"), "export const a = 1;\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("pathsIn", () => {
  test("finds relative paths and source files", () => {
    const found = pathsIn("the sweep lives in src/index/watcher.ts and notes/plan.md");

    expect(found).toContain("src/index/watcher.ts");
    expect(found).toContain("notes/plan.md");
  });

  test("ignores versions and bare words", () => {
    expect(pathsIn("it reports version 1.2.3 and uses the notifier")).toEqual([]);
  });
});

describe("isStale", () => {
  test("a memory whose only path is gone is stale", async () => {
    expect(await isStale("config lives in src/gone.ts", root)).toEqual(["src/gone.ts"]);
  });

  test("a memory whose path exists is not stale", async () => {
    expect(await isStale("config lives in src/config.ts", root)).toEqual([]);
  });

  test("a memory with no paths is never stale", async () => {
    expect(await isStale("we chose the loopback socket on purpose", root)).toEqual([]);
  });

  test("a path outside the project is not judged", async () => {
    expect(await isStale("the vendored copy sits in /usr/share/thing.py", root)).toEqual([]);
  });
});

describe("verifyMemories", () => {
  function store(records: MemoryRecord[]): {
    memory: MemoryStore;
    revisions: Array<{ id: string; metadata: Record<string, unknown> }>;
  } {
    const revisions: Array<{ id: string; metadata: Record<string, unknown> }> = [];
    const memory = {
      scan: async () => records,
      revise: async (record: MemoryRecord, metadata: Record<string, unknown>) => {
        revisions.push({ id: record.id, metadata });
      },
    } as unknown as MemoryStore;
    return { memory, revisions };
  }

  test("flags a memory whose file is gone and records why", async () => {
    const { memory, revisions } = store([
      { id: "a", text: "the sweep lives in src/removed.ts", metadata: { kind: "fix" } },
    ]);

    const summary = await verifyMemories({ memory, projectRoot: root, logger: logger as never });

    expect(summary.checked).toBe(1);
    expect(summary.stale).toBe(1);
    expect(revisions).toHaveLength(1);
    const stale = revisions[0]?.metadata.stale as { missing: string[] };
    expect(stale.missing).toEqual(["src/removed.ts"]);
    expect(revisions[0]?.metadata.kind).toBe("fix");
  });

  test("does not re-flag an already stale memory", async () => {
    const { memory, revisions } = store([
      {
        id: "a",
        text: "the sweep lives in src/removed.ts",
        metadata: { stale: { at: "2026-01-01", missing: ["src/removed.ts"] } },
      },
    ]);

    const summary = await verifyMemories({ memory, projectRoot: root, logger: logger as never });

    expect(summary.stale).toBe(1);
    expect(revisions).toEqual([]);
  });

  test("clears a flag when the path is back", async () => {
    const { memory, revisions } = store([
      {
        id: "a",
        text: "config lives in src/config.ts",
        metadata: { stale: { at: "2026-01-01", missing: ["src/config.ts"] } },
      },
    ]);

    await verifyMemories({ memory, projectRoot: root, logger: logger as never });

    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.metadata.stale).toBeUndefined();
  });

  test("a memory with no paths and no flag is left alone", async () => {
    const { memory, revisions } = store([
      { id: "a", text: "the node idles for thirty minutes", metadata: {} },
    ]);

    const summary = await verifyMemories({ memory, projectRoot: root, logger: logger as never });

    expect(summary.stale).toBe(0);
    expect(revisions).toEqual([]);
  });
});
