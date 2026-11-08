// A memory index built by one embedder is refused by a node running another.
// The engine reports that index as unhealthy rather than failing loudly, so
// recall and remember return nothing while the panel shows a healthy plugin.
// Memory cannot be rebuilt from the corpus, so the files are copied aside
// before the index is dropped; the next remember creates a fresh one.

import { cp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { XerjClient } from "../node/client.ts";
import type { Logger } from "../log.ts";

const MEMORY_INDEX_PREFIX = ".xerj-memory-";
const HEALTHY = "green";
const BACKUP_DIR = "embed-backup";
const UNREADABLE_BACKUP = "unreadable";
// Marks that the project's memory index existed at least once. It lives in the
// node directory so deleting `.xerj*` also clears it: a deliberate reset reads
// as a fresh store, not as a loss.
const SEEN_MARKER = "memory-seen";

/** The engine index name that backs one memory namespace. */
export function memoryIndexName(namespace: string): string {
  return `${MEMORY_INDEX_PREFIX}${namespace}`;
}

function memorySeenPath(nodeDir: string): string {
  return join(nodeDir, SEEN_MARKER);
}

/** True when the marker says this project's memory index existed before. */
export async function readMemorySeen(nodeDir: string): Promise<boolean> {
  return stat(memorySeenPath(nodeDir)).then(
    () => true,
    () => false,
  );
}

/** Records that the memory index exists; best effort, never throws. */
export async function writeMemorySeen(nodeDir: string): Promise<void> {
  await writeFile(memorySeenPath(nodeDir), "").catch(() => {});
}

/**
 * Repairs a memory index the node cannot open. Returns true when the index
 * was backed up and dropped, so the caller can report it.
 */
export async function recoverMemoryIndex(options: {
  readonly client: XerjClient;
  readonly nodeDir: string;
  readonly namespace: string;
  readonly logger?: Logger;
  /** The mode this plugin expects the node to run, from the config. */
  readonly backend?: "neural" | "lexical";
}): Promise<boolean> {
  const { client, nodeDir, namespace, logger } = options;
  const name = `${MEMORY_INDEX_PREFIX}${namespace}`;
  const indices = await client.indices().catch(() => []);
  const match = indices.find((entry) => entry.index === name);
  if (!match || match.health === HEALTHY) return false;
  if (await answers(client, name)) return false;

  // A correctly-moded index that the node refuses usually means the node is
  // running another embed mode, not that the store is damaged. Keeping it
  // costs a recall that still fails; resetting costs every memory in it.
  const recorded = await recordedBackend(nodeDir, name);
  if (
    recorded !== null &&
    options.backend !== undefined &&
    recorded === options.backend
  ) {
    logger?.warn(
      "memory index cannot be read; leaving it in place",
      `it was built for ${recorded}, so the node is probably running another embed mode. ` +
        `Start the node with the same mode, or delete ${join(BACKUP_DIR, UNREADABLE_BACKUP, name)} if it is corrupt`,
    );
    return false;
  }

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
 * True when a project corpus exists but the memory index does not, and the
 * marker says memories existed before: that is a loss. A store that was never
 * populated reports false — there is nothing to recover.
 */
export function memoryIndexMissing(
  indices: ReadonlyArray<{ index: string }>,
  namespace: string,
  projectPrefix: string,
  seenBefore: boolean,
): boolean {
  const names = indices.map((entry) => entry.index);
  const hasMemory = names.includes(memoryIndexName(namespace));
  const hasCorpus = names.some((name) => name.startsWith(`${projectPrefix}-`));
  return hasCorpus && !hasMemory && seenBefore;
}

// Health is a cluster reading, not proof that the index cannot be read: a
// stale or half-open index reports red and still answers. Only a failed query
// justifies resetting it, because memory cannot be rebuilt from the corpus.
async function answers(client: XerjClient, name: string): Promise<boolean> {
  try {
    await client.search(name, { size: 0, query: { match_all: {} } });
    return true;
  } catch {
    return false;
  }
}

async function recordedBackend(
  nodeDir: string,
  name: string,
): Promise<"neural" | "lexical" | null> {
  const text = await readFile(
    join(nodeDir, "data", name, "embedding_execution.json"),
    "utf8",
  ).catch(() => null);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as { backend?: unknown };
    return parsed.backend === "neural" || parsed.backend === "lexical"
      ? parsed.backend
      : null;
  } catch {
    return null;
  }
}

async function backupIndex(nodeDir: string, name: string): Promise<void> {
  const source = join(nodeDir, "data", name);
  const exists = await stat(source).then(() => true, () => false);
  if (!exists) return;

  const target = join(nodeDir, BACKUP_DIR, UNREADABLE_BACKUP, name);
  await cp(source, target, { recursive: true, force: true });
}
