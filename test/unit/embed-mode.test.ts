import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { XerjClient } from "../../src/node/client.ts";
import {
  embedModePath,
  readEmbedMode,
  reconcileEmbedMode,
} from "../../src/node/embed-mode.ts";
import { EmbedMode } from "../../src/node/supervisor.ts";

interface StubClient {
  readonly client: XerjClient;
  readonly deleted: string[];
}

function stubClient(indices: string[]): StubClient {
  const deleted: string[] = [];
  const client = {
    indices: async () => indices.map((index) => ({ index, docs: 0, bytes: 0, health: "green" })),
    deleteIndex: async (index: string) => {
      deleted.push(index);
    },
  } as unknown as XerjClient;
  return { client, deleted };
}

describe("embedding mode reconciliation", () => {
  let root: string;
  let nodeDir: string;
  let stateDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "opencode-embed-mode-"));
    nodeDir = join(root, "node");
    stateDir = join(root, "state");
    await mkdir(nodeDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("an unrecorded node counts as lexical, the engine default", async () => {
    expect(await readEmbedMode(nodeDir)).toBe(EmbedMode.Lexical);
  });

  test("a matching record leaves indices and the journal alone", async () => {
    await writeFile(embedModePath(nodeDir), EmbedMode.Neural);
    const { client, deleted } = stubClient(["xop-proj-docs"]);

    const rebuilt = await reconcileEmbedMode({
      client,
      nodeDir,
      stateDir,
      mode: EmbedMode.Neural,
    });

    expect(rebuilt).toBe(false);
    expect(deleted).toEqual([]);
  });

  test("a changed mode drops plugin indices and the journal", async () => {
    await writeFile(join(stateDir, "journal.ndjson"), "{}");
    const { client, deleted } = stubClient([
      "xop-proj-docs",
      "xop-web-docs",
      "autoindex-catalog",
    ]);

    const rebuilt = await reconcileEmbedMode({
      client,
      nodeDir,
      stateDir,
      mode: EmbedMode.Neural,
    });

    expect(rebuilt).toBe(true);
    expect(deleted).toEqual(["xop-proj-docs", "xop-web-docs"]);
    await expect(readFile(join(stateDir, "journal.ndjson"), "utf8")).rejects.toThrow();
    expect(await readEmbedMode(nodeDir)).toBe(EmbedMode.Neural);
  });

  test("a changed mode backs up memory before dropping it", async () => {
    const memoryName = ".xerj-memory-proj";
    const memoryDir = join(nodeDir, "data", memoryName);
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(memoryDir, "segment.bin"), "memory-bytes");
    const { client, deleted } = stubClient([memoryName]);

    await reconcileEmbedMode({ client, nodeDir, stateDir, mode: EmbedMode.Neural });

    expect(deleted).toEqual([memoryName]);
    const backup = join(nodeDir, "embed-backup", EmbedMode.Lexical, memoryName, "segment.bin");
    expect(await readFile(backup, "utf8")).toBe("memory-bytes");
  });

  test("the new mode is recorded so the next start matches", async () => {
    const { client } = stubClient([]);
    await reconcileEmbedMode({ client, nodeDir, stateDir, mode: EmbedMode.Neural });

    const again = await reconcileEmbedMode({
      client,
      nodeDir,
      stateDir,
      mode: EmbedMode.Neural,
    });
    expect(again).toBe(false);
  });
});
