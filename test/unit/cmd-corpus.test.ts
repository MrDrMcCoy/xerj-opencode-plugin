import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../../src/log.ts";
import type { XerjClient } from "../../src/node/client.ts";
import { CmdCorpus, documentId, splitWindows } from "../../src/cmd/corpus.ts";
import { CmdStore } from "../../src/cmd/store.ts";
import { runCommand } from "../../src/cmd/runner.ts";

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

const scratch: string[] = [];

afterEach(async () => {
  for (const directory of scratch.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function store(maxFileBytes = 64 * 1024): Promise<CmdStore> {
  const directory = await mkdtemp(join(tmpdir(), "xerj-cmdc-"));
  scratch.push(directory);
  const built = new CmdStore({
    directory,
    maxBytes: 256 * 1024 ** 2,
    maxIndexBytes: 32 * 1024 ** 2,
    maxFileBytes,
    logger,
  });
  await built.init();
  return built;
}

describe("splitWindows", () => {
  test("splits on the line limit", () => {
    const text = Array.from({ length: 5 }, (_, index) => String(index + 1)).join("\n");
    const windows = splitWindows(text, 2, 10_000);
    expect(windows.map((window) => [window.start, window.end])).toEqual([
      [1, 2],
      [3, 4],
      [5, 5],
    ]);
  });

  test("splits on the byte limit but keeps one line per window", () => {
    const windows = splitWindows("aaaa\nbbbb\ncccc", 100, 6);
    expect(windows[0]?.body).toBe("aaaa");
    expect(windows.at(-1)?.body).toBe("cccc");
  });
});

describe("CmdCorpus", () => {
  test("indexes the command and the output windows, then remembers them", async () => {
    const built = await store();
    const entry = await built.record("grep marker file", "a\nmarker here\nc\n", {
      source: "host",
      truncated: false,
    });
    const bulks: Array<{ index: string; ids: string[] }> = [];
    const client = {
      put: async () => {},
      bulk: async (index: string, actions: Array<{ id: string }>) => {
        bulks.push({ index, ids: actions.map((action) => action.id) });
      },
    } as unknown as XerjClient;

    const corpus = new CmdCorpus({
      client,
      indexName: "xop-demo-cmd-docs",
      store: built,
      logger,
      windowLines: 2,
      windowBytes: 16_384,
      maxFileBytes: 64 * 1024,
    });
    const summary = await corpus.run();

    expect(summary.files).toBe(1);
    expect(bulks[0]?.ids).toContain(documentId(entry!.stem, "cmd", 0));
    expect(bulks[0]?.ids).toContain(documentId(entry!.stem, "out", 1));
    expect(built.get(entry!.stem)?.windows).toEqual([1, 3]);

    // A second pass with no changes writes nothing.
    await corpus.run();
    expect(bulks).toHaveLength(1);
  });

  test("prunes the documents of a dropped stem", async () => {
    const built = await store();
    const entry = await built.record("gone", "a\nb\n", {
      source: "host",
      truncated: false,
    });
    await built.markIndexed(entry!.stem, [1], 4);

    const deleted: string[][] = [];
    const client = {
      bulkDelete: async (_index: string, ids: ReadonlyArray<string>) => {
        deleted.push([...ids]);
      },
    } as unknown as XerjClient;
    const corpus = new CmdCorpus({
      client,
      indexName: "xop-demo-cmd-docs",
      store: built,
      logger,
      windowLines: 200,
      windowBytes: 16_384,
      maxFileBytes: 64 * 1024,
    });

    await corpus.prune([built.get(entry!.stem)!]);
    expect(deleted[0]).toEqual([
      documentId(entry!.stem, "cmd", 0),
      documentId(entry!.stem, "out", 1),
    ]);
  });

  test("maps a passage hit back to the line in the file", async () => {
    const built = await store();
    const client = {
      search: async () => ({
        hits: {
          hits: [
            {
              _source: {
                stem: "20260101T000000000Z",
                kind: "out",
                start_line: 41,
                exit_code: 1,
                command: "npm test",
              },
              fields: {
                _passage: [{ text: "ok\nFAIL src/a.test.ts:3\nexpected 1" }],
              },
            },
          ],
        },
      }),
    } as unknown as XerjClient;
    const corpus = new CmdCorpus({
      client,
      indexName: "xop-demo-cmd-docs",
      store: built,
      logger,
      windowLines: 200,
      windowBytes: 16_384,
      maxFileBytes: 64 * 1024,
    });

    const hits = await corpus.search("FAIL", { k: 5 });
    expect(hits[0]).toMatchObject({
      stem: "20260101T000000000Z",
      kind: "out",
      line: 42,
      exitCode: 1,
    });
    expect(hits[0]?.text).toContain("FAIL");
  });
});

describe("runCommand", () => {
  test("captures stdout, stderr, exit code, and lines", async () => {
    const built = await store();
    const result = await runCommand({
      command: "printf 'out\\n'; printf 'err\\n' >&2; exit 3",
      cwd: built.path,
      timeoutMs: 5_000,
      maxBytes: 64 * 1024,
      store: built,
      logger,
    });

    expect(result.exitCode).toBe(3);
    expect(result.lines).toBe(2);
    expect(result.truncated).toBe(false);
    const entry = built.get(result.stem);
    const text = await readFile(
      join(built.path, `${result.stem}-out.txt`),
      "utf8",
    );
    expect(text).toContain("out");
    expect(text).toContain("err");
    expect(entry?.exitCode).toBe(3);
  });

  test("kills a command at its deadline and marks it", async () => {
    const built = await store();
    const result = await runCommand({
      command: "sleep 5",
      cwd: built.path,
      timeoutMs: 1_000,
      maxBytes: 64 * 1024,
      store: built,
      logger,
    });

    expect(result.timedOut).toBe(true);
  }, 15_000);

  test("stops capturing at the byte cap and marks the file", async () => {
    const built = await store(4_096);
    const result = await runCommand({
      command: "yes x",
      cwd: built.path,
      timeoutMs: 10_000,
      maxBytes: 4_096,
      store: built,
      logger,
    });

    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(4_096);
    const text = await readFile(
      join(built.path, `${result.stem}-out.txt`),
      "utf8",
    );
    expect(text).toContain("output truncated");
  }, 15_000);
});
