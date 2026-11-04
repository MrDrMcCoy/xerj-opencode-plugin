// The project memory index predates the per-project node data directory, so an
// upgrade has to carry it over instead of starting with empty memory.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../../src/log.ts";
import { migrateMemoryIndex } from "../../src/memory/migrate.ts";

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
