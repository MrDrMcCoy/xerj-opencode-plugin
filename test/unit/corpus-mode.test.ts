import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readCorpusMode,
  reconcileCorpusMode,
} from "../../src/node/corpus-mode.ts";

const root = await mkdtemp(join(tmpdir(), "xerj-corpus-mode-"));
afterAll(async () => rm(root, { recursive: true, force: true }));

function client(indices: string[]): {
  indices: () => Promise<Array<{ index: string; docs: number; bytes: number }>>;
  deleteIndex: (name: string) => Promise<void>;
  deleted: string[];
} {
  const deleted: string[] = [];
  return {
    indices: async () =>
      indices.map((index) => ({ index, docs: 1, bytes: 10 })),
    deleteIndex: async (name: string) => void deleted.push(name),
    deleted,
  };
}

describe("corpus mode reconciliation", () => {
  test("a missing record counts as the old non-graph corpus", async () => {
    const dir = await mkdtemp(join(root, "unrecorded-"));
    expect(await readCorpusMode(dir)).toBe("flat");
  });

  test("a matching record leaves the corpus and journal alone", async () => {
    const dir = await mkdtemp(join(root, "match-"));
    await writeFile(join(dir, "corpus-mode"), "graph");
    const stateDir = join(dir, "state");
    const fake = client(["xop-proj-docs"]);

    const dropped = await reconcileCorpusMode({
      client: fake as never,
      nodeDir: dir,
      stateDir,
      mode: "graph",
    });

    expect(dropped).toBe(false);
    expect(fake.deleted).toEqual([]);
  });

  test("a changed mode drops only the project corpus and its journal", async () => {
    const dir = await mkdtemp(join(root, "changed-"));
    const stateDir = join(dir, "state");
    await writeFile(join(dir, "corpus-mode"), "flat");
    const fake = client([
      "xop-proj-docs",
      "xop-proj-hidden-docs",
      "xop-web-abc-docs",
      "xop-ext-def-docs",
      ".xerj-memory-proj-12345678",
      "autoindex-catalog",
    ]);

    const dropped = await reconcileCorpusMode({
      client: fake as never,
      nodeDir: dir,
      stateDir,
      mode: "graph",
      projectPrefix: "xop-proj",
    });

    expect(dropped).toBe(true);
    expect(fake.deleted).toContain("xop-proj-docs");
    // Hidden documents, the web spool, external files, memory, and the catalog
    // are separate corpora and are rebuilt or kept by their own paths.
    expect(fake.deleted).not.toContain("xop-proj-hidden-docs");
    expect(fake.deleted).not.toContain("xop-web-abc-docs");
    expect(fake.deleted).not.toContain(".xerj-memory-proj-12345678");
    expect(fake.deleted).not.toContain("autoindex-catalog");
    expect(await readFile(join(dir, "corpus-mode"), "utf8")).toBe("graph");
  });

  test("the new mode is recorded so the next start matches", async () => {
    const dir = await mkdtemp(join(root, "record-"));
    const fake = client([]);

    await reconcileCorpusMode({
      client: fake as never,
      nodeDir: dir,
      stateDir: join(dir, "state"),
      mode: "flat",
    });

    expect(await readCorpusMode(dir)).toBe("flat");
  });
});
