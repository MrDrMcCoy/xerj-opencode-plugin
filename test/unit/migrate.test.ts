// The project memory index predates the per-project node data directory, so an
// upgrade has to carry it over instead of starting with empty memory.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../../src/log.ts";
import { migrateMemoryIndex, migrateProjectStorage } from "../../src/memory/migrate.ts";

const NAMESPACE = "proj-demo-1234abcd";

const silent: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

function workspace(): { root: string; legacy: string; node: string } {
  const root = mkdtempSync(join(tmpdir(), "xerj-migrate-"));
  const legacy = join(root, "data");
  const node = join(root, "nodes", "xop-demo", "data");
  mkdirSync(legacy, { recursive: true });
  return { root, legacy, node };
}

describe("migrateMemoryIndex", () => {
  test("copies the project memory index into an empty node data dir", async () => {
    const { root, legacy, node } = workspace();
    const index = join(legacy, `.xerj-memory-${NAMESPACE}`);
    mkdirSync(index, { recursive: true });
    writeFileSync(join(index, "snapshot.json"), '{"count":1}');

    const moved = await migrateMemoryIndex(legacy, node, NAMESPACE, silent);

    expect(moved).toBe(true);
    expect(readFileSync(join(node, `.xerj-memory-${NAMESPACE}`, "snapshot.json"), "utf8")).toBe(
      '{"count":1}',
    );
    rmSync(root, { recursive: true, force: true });
  });

  test("keeps an existing node memory index untouched", async () => {
    const { root, legacy, node } = workspace();
    const name = `.xerj-memory-${NAMESPACE}`;
    mkdirSync(join(legacy, name), { recursive: true });
    writeFileSync(join(legacy, name, "snapshot.json"), "old");
    mkdirSync(join(node, name), { recursive: true });
    writeFileSync(join(node, name, "snapshot.json"), "new");

    const moved = await migrateMemoryIndex(legacy, node, NAMESPACE, silent);

    expect(moved).toBe(false);
    expect(readFileSync(join(node, name, "snapshot.json"), "utf8")).toBe("new");
    rmSync(root, { recursive: true, force: true });
  });

  test("does nothing when the legacy index is absent", async () => {
    const { root, legacy, node } = workspace();

    const moved = await migrateMemoryIndex(legacy, node, NAMESPACE, silent);

    expect(moved).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("migrateProjectStorage", () => {
  test("moves the old node directory and web spool into project storage", async () => {
    const root = mkdtempSync(join(tmpdir(), "xerj-storage-"));
    const legacy = join(root, "global");
    const target = join(root, "project", ".xerj");
    const prefix = "xop-demo-1234abcd";
    const web = "xop-web-5678efgh";
    const oldNode = join(legacy, "nodes", prefix);
    const oldSpool = join(legacy, "spool", web);
    mkdirSync(join(oldNode, "data"), { recursive: true });
    mkdirSync(oldSpool, { recursive: true });
    writeFileSync(join(oldNode, "port"), "9200");
    writeFileSync(join(oldSpool, "page.md"), "cached");

    const moved = await migrateProjectStorage(legacy, target, prefix, web, silent);

    expect(moved).toEqual({ nodeDir: true, spool: true });
    expect(readFileSync(join(target, "nodes", prefix, "port"), "utf8")).toBe("9200");
    expect(readFileSync(join(target, "spool", web, "page.md"), "utf8")).toBe("cached");
    expect(existsSync(oldNode)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("keeps an existing target and never nests a move inside itself", async () => {
    const root = mkdtempSync(join(tmpdir(), "xerj-storage-"));
    const legacy = join(root, "project", ".xerj");
    const prefix = "xop-demo-1234abcd";
    const oldNode = join(legacy, "nodes", prefix);
    const target = join(oldNode, "nested");
    mkdirSync(oldNode, { recursive: true });
    writeFileSync(join(oldNode, "port"), "9200");

    const moved = await migrateProjectStorage(legacy, target, prefix, "xop-web-1", silent);

    expect(moved.nodeDir).toBe(false);
    expect(readFileSync(join(oldNode, "port"), "utf8")).toBe("9200");
    rmSync(root, { recursive: true, force: true });
  });
});
