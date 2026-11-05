// Embedding mode is fixed when a node's indices are built: the engine never
// re-embeds existing documents. Recording the mode per node lets a change
// rebuild the plugin's indices instead of mixing vectors from two models.

import { cp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { XerjClient } from "./client.ts";
import { EmbedMode } from "./supervisor.ts";

/** Indices every plugin-owned corpus shares; this node serves one project only. */
const PLUGIN_INDEX_PREFIX = "xop-";

/**
 * Project memory is not rebuildable from the corpus, so a mode change copies
 * its index directory aside before the index is dropped.
 */
const MEMORY_INDEX_PREFIX = ".xerj-memory-";
const BACKUP_DIR = "embed-backup";

/** A node built before the option existed used the engine's lexical default. */
const UNRECORDED_MODE = EmbedMode.Lexical;

export function embedModePath(nodeDir: string): string {
  return join(nodeDir, "embed-mode");
}

export async function readEmbedMode(nodeDir: string): Promise<EmbedMode> {
  const text = await readFile(embedModePath(nodeDir), "utf8").catch(() => null);
  const recorded = text?.trim();
  return Object.values(EmbedMode).find((mode) => mode === recorded) ?? UNRECORDED_MODE;
}

/**
 * Brings the node's indices in line with the requested mode. Returns true when
 * the indices were dropped so the next index pass rebuilds them.
 */
export async function reconcileEmbedMode(options: {
  readonly client: XerjClient;
  readonly nodeDir: string;
  readonly stateDir: string;
  readonly mode: EmbedMode;
}): Promise<boolean> {
  const { client, nodeDir, stateDir, mode } = options;
  const recorded = await readEmbedMode(nodeDir);
  if (recorded === mode) return false;

  const indices = await client.indices();
  for (const { index } of indices) {
    if (index.startsWith(MEMORY_INDEX_PREFIX)) {
      await backupMemoryIndex(nodeDir, recorded, index);
      await client.deleteIndex(index);
      continue;
    }
    if (!index.startsWith(PLUGIN_INDEX_PREFIX)) continue;
    await client.deleteIndex(index);
  }
  // The journal records documents the dropped indices held, so it goes too.
  await rm(stateDir, { recursive: true, force: true });
  await writeFile(embedModePath(nodeDir), mode, { mode: 0o600 });
  return true;
}

async function backupMemoryIndex(
  nodeDir: string,
  recordedMode: EmbedMode,
  index: string,
): Promise<void> {
  const source = join(nodeDir, "data", index);
  const exists = await stat(source).then(() => true, () => false);
  if (!exists) return;

  // A failed copy throws, so the caller keeps the index instead of dropping it.
  const target = join(nodeDir, BACKUP_DIR, recordedMode, index);
  await cp(source, target, { recursive: true, force: true });
}
