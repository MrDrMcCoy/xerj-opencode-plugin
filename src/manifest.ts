// A manifest is a small JSON object a corpus keeps beside its index: page path
// to entry, so a later run can skip unchanged pages and prune vanished ones.
// Two indexers use one, so the read-and-forgive rules live here once.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "./log.ts";

/**
 * Reads a manifest. A missing file is an empty manifest, and a corrupt one is
 * too: everything is re-ingested once and the file is rewritten, which is
 * cheaper than failing a run the reader cannot repair.
 */
export async function readManifest<T>(path: string): Promise<Record<string, T>> {
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return {};

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, T>;
  } catch {
    return {};
  }
}

/** Writes a manifest, creating its directory. A failed write is not fatal. */
export async function writeManifest(
  path: string,
  value: unknown,
  logger: Logger,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true }).catch(() => {});
  await writeFile(path, JSON.stringify(value), "utf8").catch((error: unknown) => {
    logger.debug("could not write a manifest", String(error));
  });
}
