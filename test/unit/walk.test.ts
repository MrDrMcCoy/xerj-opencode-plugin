// The analysis tools share one project walk. It decides which files a tool can
// read, so the skip list and the root boundary are worth pinning directly.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProjectFiles, readProjectFile } from "../../src/analysis/walk.ts";

const scratch: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "xerj-walk-"));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of scratch.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("listProjectFiles", () => {
  test("skips hidden, dependency, build, and secret folders", async () => {
    const root = await tempDir();
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules"), { recursive: true });
    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(join(root, ".hidden"), { recursive: true });
    await mkdir(join(root, "secrets"), { recursive: true });
    await writeFile(join(root, "a.ts"), "a");
    await writeFile(join(root, "src", "b.ts"), "b");
    await writeFile(join(root, "docs.md"), "d");
    await writeFile(join(root, "node_modules", "x.js"), "x");
    await writeFile(join(root, "dist", "y.js"), "y");
    await writeFile(join(root, ".hidden", "z.ts"), "z");
    await writeFile(join(root, "secrets", "s.txt"), "s");
    await writeFile(join(root, ".env"), "TOKEN=secret");

    expect(await listProjectFiles(root)).toEqual([
      "a.ts",
      "docs.md",
      "src/b.ts",
    ]);
  });

  test("honours the file cap", async () => {
    const root = await tempDir();
    await writeFile(join(root, "a.ts"), "a");
    await writeFile(join(root, "b.ts"), "b");
    await writeFile(join(root, "c.ts"), "c");

    const found = await listProjectFiles(root, { maxFiles: 2 });
    expect(found).toHaveLength(2);
  });
});

describe("readProjectFile", () => {
  test("reads a path inside the project", async () => {
    const root = await tempDir();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
    expect(await readProjectFile(root, "src/a.ts")).toBe("export const a = 1;\n");
  });

  test("refuses a relative escape and an absolute outside path", async () => {
    const parent = await tempDir();
    const root = join(parent, "project");
    await mkdir(root, { recursive: true });
    await writeFile(join(parent, "outside.txt"), "not yours");

    expect(await readProjectFile(root, "../outside.txt")).toBeNull();
    expect(await readProjectFile(root, join(parent, "outside.txt"))).toBeNull();
  });

  test("returns null for a missing file or one above the cap", async () => {
    const root = await tempDir();
    await writeFile(join(root, "big.txt"), "0123456789");
    expect(await readProjectFile(root, "missing.txt")).toBeNull();
    expect(await readProjectFile(root, "big.txt", 4)).toBeNull();
  });
});
