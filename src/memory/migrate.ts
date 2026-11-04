// One-time copy of the project's memory index from the pre-lifecycle engine
// data directory. Engine data moved under the project node directory, so an
// upgrade would otherwise start with an empty memory while the old index still
// sits on disk.

import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Logger } from "../log.ts";
import { isPathInside } from "../paths.ts";

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

export interface StorageMigration {
  readonly nodeDir: boolean;
  readonly spool: boolean;
}

/**
 * Moves a project's node directory and spool from the old global data root into
 * project-local storage. The caller stops the old node first: a live process
 * holding its data directory open would keep writing to the moved tree.
 */
export async function migrateProjectStorage(
  legacyRoot: string,
  storageRoot: string,
  prefix: string,
  webPrefix: string,
  logger: Logger,
): Promise<StorageMigration> {
  const empty = { nodeDir: false, spool: false };
  if (resolve(legacyRoot) === resolve(storageRoot)) return empty;

  const nodeDir = await moveDirectory(
    join(legacyRoot, "nodes", prefix),
    join(storageRoot, "nodes", prefix),
    logger,
    "node directory",
  );
  const spool = await moveDirectory(
    join(legacyRoot, "spool", webPrefix),
    join(storageRoot, "spool", webPrefix),
    logger,
    "web spool",
  );

  return { nodeDir, spool };
}

async function moveDirectory(
  source: string,
  target: string,
  logger: Logger,
  label: string,
): Promise<boolean> {
  if (!(await exists(source))) return false;
  // A target that already holds data wins; an empty one is a directory another
  // part of setup created eagerly and can be replaced with the migrated tree.
  if ((await exists(target)) && !(await isEmptyDirectory(target))) return false;
  // Copying a directory into its own subtree would recurse forever.
  if (isPathInside(source, target)) {
    logger.warn(`cannot migrate the ${label} into itself`, target);
    return false;
  }

  const partial = `${target}.partial`;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await rm(partial, { recursive: true, force: true });
  await cp(source, partial, { recursive: true, preserveTimestamps: true });

  // Two instances can bootstrap at once; the rename picks one winner. An empty
  // target is removed first, but a peer may fill it after that check.
  if (await exists(target)) {
    if (!(await isEmptyDirectory(target))) {
      await rm(partial, { recursive: true, force: true });
      return false;
    }
    await rm(target, { recursive: true, force: true });
  }
  try {
    await rename(partial, target);
  } catch {
    await rm(partial, { recursive: true, force: true });
    return false;
  }
  await rm(source, { recursive: true, force: true });
  logger.info(`migrated the ${label} into project storage`, target);
  return true;
}

async function isEmptyDirectory(path: string): Promise<boolean> {
  const entries = await readdir(path).catch(() => null);
  return entries !== null && entries.length === 0;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
