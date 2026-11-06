// Disk accounting for the node directory. The engine's own data grows with the
// corpus and the node log grows with time, and neither was reported anywhere,
// so a project could quietly occupy gigabytes with `docs` counts as the only
// number in the UI.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Entries walked before the answer is called close enough. */
const DEFAULT_ENTRY_LIMIT = 5_000;

/**
 * Total bytes of every regular file below `directory`. A missing directory is
 * zero. The walk stops after `entryLimit` entries: this feeds a status line,
 * and an exact number is not worth a long scan.
 */
export async function directoryBytes(
  directory: string,
  entryLimit = DEFAULT_ENTRY_LIMIT,
): Promise<number> {
  let total = 0;
  let seen = 0;
  const pending = [directory];

  while (pending.length > 0 && seen < entryLimit) {
    const current = pending.pop();
    if (current === undefined) break;

    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (seen >= entryLimit) break;
      seen += 1;

      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;

      const info = await stat(path).catch(() => null);
      if (info !== null) total += info.size;
    }
  }

  return total;
}

/** One file's size, or zero when it is absent. */
export async function fileBytes(path: string): Promise<number> {
  const info = await stat(path).catch(() => null);
  return info?.size ?? 0;
}
