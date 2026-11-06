import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommitIndex, readCommits } from "../../src/index/commits.ts";
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

function fakeClient(): XerjClient & FakeClient {
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

function git(root: string, args: string[]): void {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "xerj-commits-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "agent@example.test"]);
  git(root, ["config", "user.name", "Agent"]);

  await writeFile(join(root, "a.txt"), "first\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "Add the first file"]);

  await writeFile(join(root, "b.txt"), "second\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "Add the second file", "-m", "Because the sweep needed it."]);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("readCommits", () => {
  test("reads subject, body, author and files", async () => {
    const commits = await readCommits(root, 10);

    expect(commits).toHaveLength(2);
    expect(commits[0]?.subject).toBe("Add the second file");
    expect(commits[0]?.body).toContain("Because the sweep needed it");
    expect(commits[0]?.author).toBe("Agent");
    expect(commits[0]?.files).toContain("b.txt");
    expect(commits[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  test("a folder that is not a repository reads nothing", async () => {
    const empty = await mkdtemp(join(tmpdir(), "xerj-nogit-"));
    try {
      expect(await readCommits(empty, 5)).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("CommitIndex", () => {
  test("indexes every commit once and records them", async () => {
    const client = fakeClient();
    const index = new CommitIndex({
      client,
      indexName: "xop-p-git-docs",
      projectRoot: root,
      statePath: join(root, ".state", "commits.json"),
      logger: logger as never,
      limit: 10,
    });

    const first = await index.run();

    expect(first.indexed).toBe(2);
    expect(client.puts).toEqual(["xop-p-git-docs"]);
    expect(client.bulks).toHaveLength(1);
    expect(client.bulks[0]?.ids).toHaveLength(2);

    const second = await index.run();

    expect(second.indexed).toBe(0);
    expect(second.skipped).toBe(2);
    expect(client.bulks).toHaveLength(1);
  });

  test("a hash outside the window is pruned", async () => {
    const client = fakeClient();
    const statePath = join(root, ".state", "prune.json");
    const full = new CommitIndex({
      client,
      indexName: "xop-p-git-docs",
      projectRoot: root,
      statePath,
      logger: logger as never,
      limit: 10,
    });
    await full.run();

    // Reading one commit makes the older hash disappear from the window.
    const narrow = new CommitIndex({
      client,
      indexName: "xop-p-git-docs",
      projectRoot: root,
      statePath,
      logger: logger as never,
      limit: 1,
    });
    const summary = await narrow.run();

    expect(summary.pruned).toBe(1);
    expect(client.deletes[0]?.ids).toHaveLength(1);
  });
});
