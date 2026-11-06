// A memory index built by one embedder is refused by a node running another.
// The engine reports that index as unhealthy rather than failing loudly, so
// recall and remember return nothing while the panel shows a healthy plugin.
// Memory cannot be rebuilt from the corpus, so the files are copied aside
// before the index is dropped; the next remember creates a fresh one.

import { cp, stat } from "node:fs/promises";
import { join } from "node:path";
import type { XerjClient } from "../node/client.ts";
import type { Logger } from "../log.ts";

const MEMORY_INDEX_PREFIX = ".xerj-memory-";
const HEALTHY = "green";
const BACKUP_DIR = "embed-backup";
const UNREADABLE_BACKUP = "unreadable";

/**
 * Repairs a memory index the node cannot open. Returns true when the index
 * was backed up and dropped, so the caller can report it.
 */
export async function recoverMemoryIndex(options: {
  readonly client: XerjClient;
  readonly nodeDir: string;
  readonly namespace: string;
  readonly logger?: Logger;
}): Promise<boolean> {
  const { client, nodeDir, namespace, logger } = options;
  const name = `${MEMORY_INDEX_PREFIX}${namespace}`;
  const indices = await client.indices().catch(() => []);
  const match = indices.find((entry) => entry.index === name);
  if (!match || match.health === HEALTHY) return false;

  await backupIndex(nodeDir, name);
  await client.deleteIndex(name).catch((error: unknown) => {
    logger?.warn("could not drop the unreadable memory index", String(error));
  });
  logger?.warn(
    "memory index was unreadable and has been reset",
    `old contents are under ${join(nodeDir, BACKUP_DIR, UNREADABLE_BACKUP, name)}`,
  );
  return true;
}

/**
 * True when a project corpus exists but the memory index does not: memories
 * stored earlier are gone, which an empty store cannot otherwise signal. A
 * fresh project has no corpus yet, so it reports false.
 */
export function memoryIndexMissing(
  indices: ReadonlyArray<{ index: string }>,
  namespace: string,
  projectPrefix: string,
): boolean {
  const names = indices.map((entry) => entry.index);
  const hasMemory = names.includes(`${MEMORY_INDEX_PREFIX}${namespace}`);
  const hasCorpus = names.some((name) => name.startsWith(`${projectPrefix}-`));
  return hasCorpus && !hasMemory;
}

async function backupIndex(nodeDir: string, name: string): Promise<void> {
  const source = join(nodeDir, "data", name);
  const exists = await stat(source).then(() => true, () => false);
  if (!exists) return;

  const target = join(nodeDir, BACKUP_DIR, UNREADABLE_BACKUP, name);
  await cp(source, target, { recursive: true, force: true });
}
