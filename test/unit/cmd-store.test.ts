import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../../src/log.ts";
import { CmdStore, cmdStem, countLines, stemTime } from "../../src/cmd/store.ts";

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

async function store(
  overrides: { maxBytes?: number; maxIndexBytes?: number; maxFileBytes?: number } = {},
): Promise<CmdStore> {
  const directory = await mkdtemp(join(tmpdir(), "xerj-cmd-"));
  scratch.push(directory);
  const built = new CmdStore({
    directory,
    maxBytes: overrides.maxBytes ?? 256 * 1024 ** 2,
    maxIndexBytes: overrides.maxIndexBytes ?? 32 * 1024 ** 2,
    maxFileBytes: overrides.maxFileBytes ?? 1024,
    logger,
  });
  await built.init();
  return built;
}

describe("stem format", () => {
  test("is sortable and reversible", () => {
    const at = Date.UTC(2026, 10, 6, 19, 22, 33, 123);
    const stem = cmdStem(at);
    expect(stem).toBe("20261106T192233123Z");
    expect(stemTime(stem)).toBe(at);
    expect(cmdStem(at + 1) > stem).toBe(true);
  });

  test("rounds a missing millisecond field to zero", () => {
    expect(stemTime("not-a-stem")).toBe(0);
  });
});

describe("CmdStore", () => {
  test("writes a pair and lists it only once complete", async () => {
    const built = await store();
    const pair = await built.begin("printf hello", "run");
    expect(await readdir(built.path)).toContain(`${pair.stem}-cmd.txt`);
    expect(built.list(10)).toEqual([]);

    await writeFile(pair.partPath, "hello\nworld\n");
    await built.finish(pair.stem, {
      stem: pair.stem,
      exitCode: 0,
      durationMs: 5,
      bytes: 12,
      lines: 2,
      truncated: false,
      binary: false,
      timedOut: false,
    });

    const listed = built.list(10);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ stem: pair.stem, exitCode: 0, lines: 2 });
    expect(await readFile(pair.outputPath, "utf8")).toBe("hello\nworld\n");
  });

  test("gives two commands in one millisecond distinct stems", async () => {
    const built = await store();
    const at = Date.UTC(2026, 10, 6, 1, 2, 3, 4);
    const first = await built.begin("one", "run", at);
    const second = await built.begin("two", "run", at);
    expect(first.stem).not.toBe(second.stem);
    expect(built.list(10)).toEqual([]);
  });

  test("reads an exact range and reports the total", async () => {
    const built = await store();
    const pair = await built.begin("seq 1 5", "run");
    await writeFile(pair.partPath, "1\n2\n3\n4\n5\n");
    await built.finish(pair.stem, {
      stem: pair.stem,
      exitCode: 0,
      durationMs: 1,
      bytes: 10,
      lines: 5,
      truncated: false,
      binary: false,
      timedOut: false,
    });

    const read = await built.read(pair.stem, 2, 4);
    expect(read).toEqual({ lines: ["2", "3", "4"], total: 5, from: 2 });
    const tail = await built.read(pair.stem);
    expect(tail?.lines.at(-1)).toBe("5");
  });

  test("records a mirrored result and redacts the command", async () => {
    const built = await store();
    const entry = await built.record(
      "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'",
      "line\n",
      { source: "host", truncated: true },
    );

    expect(entry).not.toBeNull();
    expect(entry?.command).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(entry?.truncated).toBe(true);
    expect(built.list(10)).toHaveLength(1);
  });

  test("filters the list by command text", async () => {
    const built = await store();
    await built.record("npm test", "a\n", { source: "host", truncated: false });
    await built.record("cargo build", "b\n", { source: "host", truncated: false });

    expect(built.list(10, "npm")).toHaveLength(1);
    expect(built.list(10, "npm")[0]?.command).toBe("npm test");
  });

  test("sweeps the oldest pairs when the file cap binds", async () => {
    const built = await store({ maxBytes: 150 });
    const first = await built.record("first", "x".repeat(100), {
      source: "host",
      truncated: false,
    });
    const second = await built.record("second", "y".repeat(100), {
      source: "host",
      truncated: false,
    });
    expect(built.list(10)).toHaveLength(2);

    const removed = await built.sweep(0);
    expect(removed.map((entry) => entry.stem)).toEqual([first!.stem]);
    expect(built.list(10).map((entry) => entry.stem)).toEqual([second!.stem]);
  });

  test("sweeps when the index cap binds, even with files under the cap", async () => {
    const built = await store({ maxBytes: 10_000, maxIndexBytes: 10 });
    const first = await built.record("first", "x".repeat(50), {
      source: "host",
      truncated: false,
    });
    await built.record("second", "y".repeat(50), { source: "host", truncated: false });
    await built.markIndexed(first!.stem, [1], 20);

    const removed = await built.sweep(20);
    expect(removed.map((entry) => entry.stem)).toEqual([first!.stem]);
  });

  test("rebuilds a missing manifest from the pairs", async () => {
    const built = await store();
    await built.record("kept", "a\n", { source: "host", truncated: false });
    await rm(join(built.path, "manifest.json"), { force: true });

    const rebuilt = await storeAt(built.path);
    expect(rebuilt.list(10)).toHaveLength(1);
    expect(rebuilt.list(10)[0]?.command).toBe("kept");
  });

  test("recovers a partial left by a killed process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xerj-cmd-"));
    scratch.push(directory);
    await writeFile(join(directory, "20260101T000000000Z-cmd.txt"), "sleep 9\n");
    await writeFile(join(directory, "20260101T000000000Z-out.txt.part"), "partial\n");

    const rebuilt = await storeAt(directory);
    const entry = rebuilt.list(10)[0];
    expect(entry?.command).toBe("sleep 9");
    expect(entry?.truncated).toBe(true);
  });

  test("reconcile forgets entries whose output vanished", async () => {
    const built = await store();
    const entry = await built.record("gone", "a\n", { source: "host", truncated: false });
    await rm(join(built.path, `${entry!.stem}-out.txt`), { force: true });

    const gone = await built.reconcile();
    expect(gone.map((item) => item.stem)).toEqual([entry!.stem]);
    expect(built.list(10)).toEqual([]);
  });
});

async function storeAt(directory: string): Promise<CmdStore> {
  const built = new CmdStore({
    directory,
    maxBytes: 256 * 1024 ** 2,
    maxIndexBytes: 32 * 1024 ** 2,
    maxFileBytes: 1024,
    logger,
  });
  await built.init();
  return built;
}

describe("countLines", () => {
  test("counts a final line without a newline", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\nb")).toBe(2);
  });
});
