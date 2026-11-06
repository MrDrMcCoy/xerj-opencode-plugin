import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiddenIndex } from "../../src/index/hidden.ts";
import type { Logger } from "../../src/log.ts";
import { NodeRequestError, type XerjClient } from "../../src/node/client.ts";
import { documentRoots } from "../../src/paths.ts";

const root = await mkdtemp(join(tmpdir(), "xerj-hidden-"));
afterAll(async () => rm(root, { recursive: true, force: true }));

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

interface Captured {
  readonly index: string;
  readonly actions: ReadonlyArray<{ id: string; source: Record<string, unknown> }>;
}

async function fixture(existingIndex = false): Promise<{
  root: string;
  bulks: Captured[];
  deleted: string[];
  index: HiddenIndex;
}> {
  const project = await mkdtemp(join(root, "project-"));
  const agents = join(project, ".agents");
  const git = join(project, ".git");
  const nested = join(agents, "nested");
  const secrets = join(agents, "secrets");
  await mkdir(nested, { recursive: true });
  await mkdir(git, { recursive: true });
  await mkdir(secrets, { recursive: true });

  await writeFile(join(agents, "plan.md"), "# Plan\n\nHidden body.");
  await writeFile(join(nested, "note.md"), "Nested note.");
  await writeFile(join(agents, ".env"), "SECRET=1");
  await writeFile(join(agents, "image.png"), "not text");
  await writeFile(join(agents, "big.md"), "x".repeat(400));
  await writeFile(join(agents, "secrets", "key.md"), "SECRET");
  await writeFile(join(git, "config"), "ignored");

  const bulks: Captured[] = [];
  const deleted: string[] = [];
  const client = {
    put: async () => {
      if (existingIndex) throw new NodeRequestError("exists", 409, "already exists");
    },
    search: async () => ({ hits: { hits: [{ _id: "stale-id" }] } }),
    bulk: async (index: string, actions: Captured["actions"]) => {
      bulks.push({ index, actions });
    },
    bulkDelete: async (_index: string, ids: ReadonlyArray<string>) => {
      deleted.push(...ids);
    },
  } as unknown as XerjClient;

  const index = new HiddenIndex({
    client,
    projectRoot: project,
    prefix: "xop-demo-1234",
    roots: documentRoots(project, [".agents"]),
    maxBytes: 256,
    logger,
  });

  return { root: project, bulks, deleted, index };
}

describe("HiddenIndex", () => {
  test("indexes text under a hidden folder and skips secrets and binaries", async () => {
    const { bulks, index } = await fixture();
    await index.reindex();

    const actions = bulks.flatMap((bulk) => bulk.actions);
    const paths = actions.map((action) => action.source.path).sort();

    const plan = actions.find((action) => action.source.path === ".agents/plan.md");

    expect(bulks[0]?.index).toBe("xop-demo-1234-hidden-docs");
    expect(paths).toEqual([".agents/nested/note.md", ".agents/plan.md"]);
    expect(plan?.source.hidden).toBe(true);
    expect(plan?.source.body).toContain("Hidden body");
    expect(index.snapshot().docs).toBe(2);
  });

  test("uploads documents in path order regardless of directory order", async () => {
    const { bulks, index } = await fixture();
    await index.reindex();

    const uploaded = bulks.flatMap((bulk) => bulk.actions).map((action) => action.source.path);

    expect(uploaded).toEqual([...uploaded].sort());
  });

  test("tolerates an index that already exists", async () => {
    const { index } = await fixture(true);
    await index.reindex();

    expect(index.snapshot().docs).toBe(2);
    expect(index.snapshot().error).toBeNull();
  });

  test("deletes documents whose files disappeared", async () => {
    const { deleted, index } = await fixture();
    await index.reindex();

    expect(deleted).toEqual(["stale-id"]);
  });

  test("keeps stable ids for the same relative path", async () => {
    const { bulks, index } = await fixture();
    await index.reindex();
    await index.reindex();

    const first = bulks[0]?.actions.map((action) => action.id).sort();
    const second = bulks[1]?.actions.map((action) => action.id).sort();
    expect(first).toEqual(second);
  });

  test("ignores a missing folder", async () => {
    const project = await mkdtemp(join(root, "missing-"));
    const bulks: Captured[] = [];
    const client = {
      put: async () => {},
      search: async () => ({ hits: { hits: [] } }),
      bulk: async (index: string, actions: Captured["actions"]) => {
        bulks.push({ index, actions });
      },
      bulkDelete: async () => {},
    } as unknown as XerjClient;

    const index = new HiddenIndex({
      client,
      projectRoot: project,
      prefix: "xop-missing-0000",
      roots: documentRoots(project, [".absent"]),
      maxBytes: 256,
      logger,
    });

    await index.reindex();
    expect(bulks).toHaveLength(0);
    expect(index.snapshot().docs).toBe(0);
  });
});

describe("an empty hidden scan", () => {
  test("warns once when a folder that has files yields nothing", async () => {
    const project = await mkdtemp(join(root, "empty-"));
    const agents = join(project, ".agents");
    await mkdir(agents, { recursive: true });
    // Only skipped content: a binary and a secret.
    await writeFile(join(agents, "image.png"), "not text");
    await writeFile(join(agents, ".env"), "SECRET=1");

    const warned: string[] = [];
    const index = new HiddenIndex({
      client: {
        put: async () => {},
        search: async () => ({ hits: { hits: [] } }),
        bulk: async () => {},
        bulkDelete: async () => {},
      } as never,
      projectRoot: project,
      prefix: "xop-empty-0000",
      roots: documentRoots(project, [".agents"]),
      maxBytes: 1024,
      logger: {
        ...logger,
        warn: (message: string) => void warned.push(message),
      } as Logger,
      onRun: () => {},
      onChange: () => {},
    });

    await index.reindex();
    await index.reindex();
    await index.stop();

    expect(warned.filter((line) => line.includes("no documents"))).toHaveLength(1);
  });

  test("does not warn when the folder has indexable text", async () => {
    const project = await mkdtemp(join(root, "full-"));
    await mkdir(join(project, ".agents"), { recursive: true });
    await writeFile(join(project, ".agents", "note.md"), "# Note\n");

    const warned: string[] = [];
    const index = new HiddenIndex({
      client: {
        put: async () => {},
        search: async () => ({ hits: { hits: [] } }),
        bulk: async () => {},
        bulkDelete: async () => {},
      } as never,
      projectRoot: project,
      prefix: "xop-full-0000",
      roots: documentRoots(project, [".agents"]),
      maxBytes: 1024,
      logger: {
        ...logger,
        warn: (message: string) => void warned.push(message),
      } as Logger,
      onRun: () => {},
      onChange: () => {},
    });

    await index.reindex();
    await index.stop();

    expect(warned).toEqual([]);
  });
});
