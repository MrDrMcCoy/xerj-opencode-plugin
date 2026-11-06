import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateNodeLog } from "../../src/node/log-file.ts";

const root = await mkdtemp(join(tmpdir(), "xerj-nodelog-"));
afterAll(async () => rm(root, { recursive: true, force: true }));

async function sizeOf(path: string): Promise<number> {
  return (await stat(path).catch(() => ({ size: 0 }))).size;
}

describe("rotateNodeLog", () => {
  test("leaves a log under the cap alone", async () => {
    const dir = await mkdtemp(join(root, "under-"));
    await writeFile(join(dir, "node.log"), "small");

    await rotateNodeLog(dir, 1024);

    expect(await readFile(join(dir, "node.log"), "utf8")).toBe("small");
    expect(await sizeOf(join(dir, "node.log.1"))).toBe(0);
  });

  test("moves an oversized log aside and starts fresh", async () => {
    const dir = await mkdtemp(join(root, "over-"));
    await writeFile(join(dir, "node.log"), "x".repeat(2048));

    await rotateNodeLog(dir, 1024);

    expect(await sizeOf(join(dir, "node.log"))).toBe(0);
    expect(await sizeOf(join(dir, "node.log.1"))).toBe(2048);
  });

  test("replaces the previous rotated file instead of stacking", async () => {
    const dir = await mkdtemp(join(root, "twice-"));
    await writeFile(join(dir, "node.log"), "a".repeat(2048));
    await rotateNodeLog(dir, 1024);

    await writeFile(join(dir, "node.log"), "b".repeat(4096));
    await rotateNodeLog(dir, 1024);

    expect(await sizeOf(join(dir, "node.log.1"))).toBe(4096);
    expect(await sizeOf(join(dir, "node.log.2"))).toBe(0);
  });

  test("a cap of zero disables rotation", async () => {
    const dir = await mkdtemp(join(root, "off-"));
    await writeFile(join(dir, "node.log"), "x".repeat(2048));

    await rotateNodeLog(dir, 0);

    expect(await sizeOf(join(dir, "node.log"))).toBe(2048);
    expect(await sizeOf(join(dir, "node.log.1"))).toBe(0);
  });

  test("a missing log is not an error", async () => {
    const dir = await mkdtemp(join(root, "missing-"));
    await expect(rotateNodeLog(dir, 1024)).resolves.toBeUndefined();
  });
});
