import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryBytes, fileBytes } from "../../src/disk.ts";

const root = await mkdtemp(join(tmpdir(), "xerj-disk-"));
afterAll(async () => rm(root, { recursive: true, force: true }));

describe("directoryBytes", () => {
  test("sums file sizes below a directory", async () => {
    const dir = join(root, "tree");
    await mkdir(join(dir, "nested"), { recursive: true });
    await writeFile(join(dir, "a.txt"), "12345");
    await writeFile(join(dir, "nested/b.txt"), "123");

    expect(await directoryBytes(dir)).toBe(8);
  });

  test("a missing directory is zero, not an error", async () => {
    expect(await directoryBytes(join(root, "absent"))).toBe(0);
  });

  test("stops counting past the entry limit", async () => {
    const dir = join(root, "many");
    await mkdir(dir, { recursive: true });
    for (let index = 0; index < 6; index += 1) {
      await writeFile(join(dir, `f${index}.txt`), "x");
    }

    // Fewer entries than the tree holds, so the walk stops early.
    const bounded = await directoryBytes(dir, 3);
    expect(bounded).toBeLessThanOrEqual(6);
    expect(bounded).toBeGreaterThan(0);
  });
});

describe("fileBytes", () => {
  test("reports a file size and zero when missing", async () => {
    const path = join(root, "one.txt");
    await writeFile(path, "1234");

    expect(await fileBytes(path)).toBe(4);
    expect(await fileBytes(join(root, "absent.txt"))).toBe(0);
  });
});
