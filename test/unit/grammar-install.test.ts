// The grammar pack install is a download, a sha512 check, an extraction, and
// a rename. These tests serve a fixture tarball from loopback so the failure
// paths run without the real 4.4 MB pack.

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GrammarManager } from "../../src/analysis/grammar.ts";

const run = promisify(execFile);
const tarTest = process.platform === "win32" ? test.skip : test;

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

const scratch: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "xerj-grammar-"));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of scratch.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function pack(
  dir: string,
  options: { out?: boolean } = {},
): Promise<{ tarball: string; integrity: string }> {
  const stage = join(dir, "stage");
  const folder = options.out === false ? "lib" : "out";
  const name = options.out === false ? "readme.md" : "tree-sitter-typescript.wasm";
  await mkdir(join(stage, "package", folder), { recursive: true });
  await writeFile(join(stage, "package", folder, name), "wasm");
  const tarball = join(dir, "pack.tgz");
  await run("tar", ["-czf", tarball, "-C", stage, "package"]);
  const hash = createHash("sha512");
  hash.update(await readFile(tarball));
  return { tarball, integrity: `sha512-${hash.digest("base64")}` };
}

function serve(tarball: string): { url: string; stop: () => void; requests: () => number } {
  let count = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      count += 1;
      return new Response(Bun.file(tarball));
    },
  });
  return {
    url: `${server.url}pack.tgz`,
    stop: () => server.stop(true),
    requests: () => count,
  };
}

describe("GrammarManager install", () => {
  tarTest("installs the pack and reuses it on a second call", async () => {
    const dir = await tempDir();
    const { tarball, integrity } = await pack(dir);
    const served = serve(tarball);
    const manager = new GrammarManager({
      root: join(dir, "grammars"),
      logger,
      url: served.url,
      integrity,
      timeoutMs: 10_000,
    });

    try {
      const first = await manager.ensure(["typescript"]);
      expect(first).not.toBeNull();
      const wasm = first?.get("typescript");
      expect(wasm).toBeDefined();
      expect(await readFile(wasm!, "utf8")).toBe("wasm");

      const second = await manager.ensure(["typescript"]);
      expect(second).toEqual(first);
      expect(served.requests()).toBe(1);
    } finally {
      served.stop();
    }
  }, 30_000);

  tarTest("rejects a tarball whose hash does not match", async () => {
    const dir = await tempDir();
    const { tarball } = await pack(dir);
    const served = serve(tarball);
    const manager = new GrammarManager({
      root: join(dir, "grammars"),
      logger,
      url: served.url,
      integrity: "sha512-not-the-real-one",
      timeoutMs: 10_000,
    });

    try {
      expect(await manager.ensure(["typescript"])).toBeNull();
      expect(
        await readFile(manager.directory, "utf8").catch(() => null),
      ).toBeNull();
    } finally {
      served.stop();
    }
  }, 30_000);

  tarTest("rejects a pack without an out/ directory", async () => {
    const dir = await tempDir();
    const { tarball, integrity } = await pack(dir, { out: false });
    const served = serve(tarball);
    const manager = new GrammarManager({
      root: join(dir, "grammars"),
      logger,
      url: served.url,
      integrity,
      timeoutMs: 10_000,
    });

    try {
      expect(await manager.ensure(["typescript"])).toBeNull();
    } finally {
      served.stop();
    }
  }, 30_000);
});
