import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchiveIndex, turnId } from "../../src/archive/index.ts";
import type { XerjClient } from "../../src/node/client.ts";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

interface FakeClient {
  bulks: Array<{ index: string; ids: string[] }>;
  deletes: Array<{ index: string; ids: string[] }>;
  puts: string[];
}

function client(): XerjClient & FakeClient {
  const fake: FakeClient = { bulks: [], deletes: [], puts: [] };
  return Object.assign(fake, {
    bulk: async (index: string, actions: Array<{ id: string }>) => {
      fake.bulks.push({ index, ids: actions.map((action) => action.id) });
    },
    bulkDelete: async (index: string, ids: ReadonlyArray<string>) => {
      fake.deletes.push({ index, ids: [...ids] });
    },
    put: async (path: string) => void fake.puts.push(path),
  }) as unknown as XerjClient & FakeClient;
}

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "xerj-archive-index-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function writeSession(directory: string, name: string, turns: Array<{ role: string; text: string }>): Promise<void> {
  await mkdir(directory, { recursive: true });
  const body = turns.map((turn) => JSON.stringify({ ...turn, at: "2026-11-06T10:00:00Z" })).join("\n");
  await writeFile(join(directory, `${name}.ndjson`), `${body}\n`, "utf8");
}

function indexer(directory: string, statePath: string, xerj = client()): { index: ArchiveIndex; client: XerjClient & FakeClient } {
  return {
    index: new ArchiveIndex({
      client: xerj,
      indexName: "xop-p-archive-docs",
      directory,
      statePath,
      logger: logger as never,
    }),
    client: xerj,
  };
}

describe("turnId", () => {
  test("is stable per session and ordinal", () => {
    expect(turnId("s1", 1)).toBe(turnId("s1", 1));
    expect(turnId("s1", 1)).not.toBe(turnId("s1", 2));
    expect(turnId("s1", 1)).not.toBe(turnId("s2", 1));
  });
});

describe("ArchiveIndex", () => {
  test("indexes every turn once", async () => {
    const directory = join(root, "sessions-a");
    await writeSession(directory, "abc", [
      { role: "user", text: "where is the watcher" },
      { role: "assistant", text: "in src/index/watcher.ts" },
    ]);
    const { index, client: xerj } = indexer(directory, join(root, "state-a.json"));

    const first = await index.run();
    expect(first.indexed).toBe(2);
    expect(xerj.bulks[0]?.ids).toHaveLength(2);

    const second = await index.run();
    expect(second.indexed).toBe(0);
    expect(second.skipped).toBe(2);
    expect(xerj.bulks).toHaveLength(1);
  });

  test("an emptied session prunes its turns", async () => {
    const directory = join(root, "sessions-b");
    await writeSession(directory, "abc", [{ role: "user", text: "first" }]);
    const statePath = join(root, "state-b.json");
    const { index, client: xerj } = indexer(directory, statePath);
    await index.run();

    // Pruning the archive removed the only line.
    await writeFile(join(directory, "abc.ndjson"), "", "utf8");
    const summary = await index.run();

    expect(summary.pruned).toBe(1);
    expect(xerj.deletes[0]?.ids).toHaveLength(1);
  });

  test("an empty directory is not an error", async () => {
    const { index } = indexer(join(root, "missing"), join(root, "state-c.json"));

    expect(await index.run()).toEqual({ indexed: 0, skipped: 0, pruned: 0, turns: 0 });
  });

  test("a malformed line is skipped", async () => {
    const directory = join(root, "sessions-d");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "abc.ndjson"),
      `not json\n${JSON.stringify({ role: "user", text: "kept" })}\n`,
      "utf8",
    );
    const { index } = indexer(directory, join(root, "state-d.json"));

    expect((await index.run()).indexed).toBe(1);
  });
});
