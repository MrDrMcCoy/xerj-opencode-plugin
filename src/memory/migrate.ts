// One-time copy of the project's memory index from the pre-lifecycle engine
// data directory. Engine data moved under the project node directory, so an
// upgrade would otherwise start with an empty memory while the old index still
// sits on disk.

import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../log.ts";

export async function migrateMemoryIndex(
  legacyDataDir: string,
  nodeDataDir: string,
  namespace: string,
  logger: Logger,
): Promise<boolean> {
  const name = `.xerj-memory-${namespace}`;
  const source = join(legacyDataDir, name);
  const target = join(nodeDataDir, name);
  const partial = `${target}.partial`;
  if (source === target) return false;
  if (!(await exists(source)) || (await exists(target))) return false;

  // Two plugin instances can bootstrap at once; the rename is atomic, so the
  // loser discards its copy instead of merging into the winner's index.
  await mkdir(nodeDataDir, { recursive: true, mode: 0o700 });
  await rm(partial, { recursive: true, force: true });
  await cp(source, partial, { recursive: true });
  if (await exists(target)) {
    await rm(partial, { recursive: true, force: true });
    return false;
  }
  await rename(partial, target);
  logger.info("migrated project memory into the node data directory", name);
  return true;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
