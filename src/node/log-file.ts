// The node writes its own log to `<node dir>/node.log` and never rotates it, so
// a long-running project accumulates a file that is slow to read and wasteful to
// keep. One rotation is enough: the current pass stays in `node.log` and the
// previous one in `node.log.1`, which is all a debugging session needs.

import { rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const LOG_NAME = "node.log";
const ROTATED_NAME = "node.log.1";

/**
 * Renames `node.log` to `node.log.1` when it exceeds `maxBytes`, replacing any
 * earlier rotated file. A cap of zero disables rotation; a missing log is not
 * an error, because the next spawn creates it.
 */
export async function rotateNodeLog(nodeDir: string, maxBytes: number): Promise<void> {
  if (maxBytes <= 0) return;

  const path = join(nodeDir, LOG_NAME);
  const size = await stat(path).then(
    (info) => info.size,
    () => -1,
  );
  if (size <= maxBytes) return;

  const rotated = join(nodeDir, ROTATED_NAME);
  await unlink(rotated).catch(() => {});
  await rename(path, rotated).catch(() => {});
}
