import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { XerjClient } from "../../src/node/client.ts";
import { recoverMemoryIndex } from "../../src/memory/health.ts";

interface Stub {
  readonly client: XerjClient;
  readonly deleted: string[];
  readonly created: string[];
}

function stubClient(
  indices: ReadonlyArray<{ index: string; health: string }>,
): Stub {
  const deleted: string[] = [];
  const created: string[] = [];
  const client = {
    indices: async () =>
      indices.map(({ index, health }) => ({ index, health, docs: 0, bytes: 0 })),
    deleteIndex: async (index: string) => {
      deleted.push(index);
    },
    createIndex: async (index: string) => {
      created.push(index);
    },
  } as unknown as XerjClient;
  return { client, deleted, created };
}

describe("memory index health", () => {
  let root: string;
  let nodeDir: string;
  const namespace = "proj-demo-abc12345";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "opencode-memory-health-"));
    nodeDir = join(root, "node");
    await mkdir(nodeDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("a healthy index is left alone", async () => {
    const health = `green`;
    const { client, deleted } = stubClient([
      { index: `.xerj-memory-${namespace}`, health },
    ]);

    const recovered = await recoverMemoryIndex({ client, nodeDir, namespace });

    expect(recovered).toBe(false);
    expect(deleted).toEqual([]);
  });

  test("a red index is backed up and rebuilt empty", async () => {
    const name = `.xerj-memory-${namespace}`;
    const indexDir = join(nodeDir, "data", name);
    await mkdir(indexDir, { recursive: true });
    await writeFile(join(indexDir, "xerj_meta.json"), "old");
    const { client, deleted } = stubClient([{ index: name, health: "red" }]);

    const recovered = await recoverMemoryIndex({ client, nodeDir, namespace });

    expect(recovered).toBe(true);
    expect(deleted).toEqual([name]);
    const backup = join(nodeDir, "embed-backup", "unreadable", name, "xerj_meta.json");
    expect(await readFile(backup, "utf8")).toBe("old");
  });

  test("a missing index is not created up front", async () => {
    const { client, deleted, created } = stubClient([]);

    const recovered = await recoverMemoryIndex({ client, nodeDir, namespace });

    expect(recovered).toBe(false);
    expect(deleted).toEqual([]);
    expect(created).toEqual([]);
  });
});

describe("memory index health failures", () => {
  let root: string;
  let nodeDir: string;
  const namespace = "proj-demo-abc12345";
  const name = `.xerj-memory-${namespace}`;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "opencode-memory-health-"));
    nodeDir = join(root, "node");
    await mkdir(nodeDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("a failed delete is logged and still reports a repair", async () => {
    const warnings: string[] = [];
    const client = {
      indices: async () => [{ index: name, health: "red", docs: 0, bytes: 0 }],
      deleteIndex: async () => {
        throw new Error("node refused");
      },
    } as unknown as XerjClient;

    const recovered = await recoverMemoryIndex({
      client,
      nodeDir,
      namespace,
      logger: {
        debug: () => {},
        info: () => {},
        warn: (message: string) => void warnings.push(message),
        error: () => {},
        entries: async () => [],
        flush: async () => {},
      },
    });

    expect(recovered).toBe(true);
    expect(warnings).toContain("could not drop the unreadable memory index");
  });

  test("a missing index directory is not an error", async () => {
    const client = {
      indices: async () => [{ index: name, health: "red", docs: 0, bytes: 0 }],
      deleteIndex: async () => {},
    } as unknown as XerjClient;

    await expect(recoverMemoryIndex({ client, nodeDir, namespace })).resolves.toBe(true);
  });

  test("an index list that fails leaves the index alone", async () => {
    const client = {
      indices: async () => {
        throw new Error("node down");
      },
      deleteIndex: async () => {},
    } as unknown as XerjClient;

    await expect(recoverMemoryIndex({ client, nodeDir, namespace })).resolves.toBe(false);
  });

  test("a yellow index counts as unreadable", async () => {
    const client = {
      indices: async () => [{ index: name, health: "yellow", docs: 0, bytes: 0 }],
      deleteIndex: async () => {},
    } as unknown as XerjClient;

    await expect(recoverMemoryIndex({ client, nodeDir, namespace })).resolves.toBe(true);
  });
});
