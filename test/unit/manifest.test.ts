import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest, writeManifest } from "../../src/manifest.ts";
import type { Logger } from "../../src/log.ts";

const scratch: string[] = [];
afterAll(async () => {
  for (const directory of scratch.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function directory(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "xerj-manifest-"));
  scratch.push(created);
  return created;
}

function logger(warnings: string[] = []): Logger {
  return {
    debug: (message: string) => void warnings.push(message),
    info: () => {},
    warn: () => {},
    error: () => {},
    entries: async () => [],
    flush: async () => {},
  } as unknown as Logger;
}

describe("readManifest", () => {
  test("a missing file is an empty manifest", async () => {
    const path = join(await directory(), "absent.json");
    expect(await readManifest(path)).toEqual({});
  });

  test("a written manifest reads back", async () => {
    const path = join(await directory(), "state.json");
    await writeManifest(path, { "a.md": { hash: "x" } }, logger());

    expect(await readManifest(path)).toEqual({ "a.md": { hash: "x" } });
  });

  test("a corrupt file is an empty manifest, not an error", async () => {
    const path = join(await directory(), "broken.json");
    await writeFile(path, "{ not json");

    expect(await readManifest(path)).toEqual({});
  });

  test("a value that is not an object is rejected", async () => {
    const dir = await directory();
    for (const [name, body] of [
      ["number.json", "5"],
      ["null.json", "null"],
      ["array.json", "[1, 2]"],
    ] as const) {
      const path = join(dir, name);
      await writeFile(path, body);
      expect(await readManifest(path)).toEqual({});
    }
  });
});

describe("writeManifest", () => {
  test("the directory is created", async () => {
    const path = join(await directory(), "nested", "deep", "state.json");
    await writeManifest(path, { one: 1 }, logger());

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ one: 1 });
  });

  test("a failed write is logged and does not throw", async () => {
    const messages: string[] = [];
    // A path whose parent is a file cannot be created.
    const dir = await directory();
    const blocker = join(dir, "blocked");
    await writeFile(blocker, "not a directory");

    await expect(
      writeManifest(join(blocker, "state.json"), { a: 1 }, logger(messages)),
    ).resolves.toBeUndefined();
    expect(messages.length).toBeGreaterThan(0);
  });
});
