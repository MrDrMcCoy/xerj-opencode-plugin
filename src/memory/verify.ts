// A memory goes stale when the file it names is gone, or the path it quotes
// no longer exists. Verification is a read-only pass: it flags the memory and
// never deletes it, because a deleted file is sometimes the point ("the old
// sweep module was removed").

import { stat } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import type { Logger } from "../log.ts";
import type { MemoryStore, MemoryRecord } from "./store.ts";

export interface VerifyOptions {
  readonly memory: MemoryStore;
  readonly projectRoot: string;
  readonly logger: Logger;
  /** Memories to check. Newest first is not assumed; the cap is a guard. */
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface VerifySummary {
  readonly checked: number;
  readonly stale: number;
  readonly flagged: ReadonlyArray<{ id: string; missing: ReadonlyArray<string> }>;
}

const DEFAULT_LIMIT = 300;
/** A path-shaped token: at least one slash or a known source extension. */
const PATH_TOKEN =
  /(?:^|[\s(`"'])((?:[\w.@-]+\/)+[\w.@-]+\.\w+|[\w.@-]+\.(?:ts|tsx|js|jsx|mjs|py|rs|go|md|json|ya?ml|toml|sh|sql|h|hpp|c|cc|cpp))\b/g;

/** Paths a memory names, deduplicated and in the order they appear. */
export function pathsIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PATH_TOKEN)) {
    const token = match[1];
    if (token === undefined || token.length < 3) continue;
    // A version like 1.2.3 or an address like example.com is not a file.
    if (/^\d+(\.\d+)+$/.test(token)) continue;
    found.add(token.replace(/^\.\//, ""));
  }
  return [...found];
}

/** True when every path the memory names is missing from the project. */
export async function isStale(
  text: string,
  projectRoot: string,
  exists: (path: string) => Promise<boolean> = defaultExists,
): Promise<string[]> {
  const paths = pathsIn(text);
  if (paths.length === 0) return [];

  const missing: string[] = [];
  for (const path of paths) {
    if (isAbsolute(path)) continue;
    // A path that climbs out of the project is not this pass's business.
    if (normalize(path).split(sep).includes("..")) continue;
    if (!(await exists(join(projectRoot, path)))) missing.push(path);
  }
  return missing.length === paths.filter((path) => !isAbsolute(path)).length
    ? missing
    : [];
}

async function defaultExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Flags memories whose every named path is gone. The flag lives in metadata as
 * `stale`, with the missing paths and the date, and a later verification that
 * finds the paths again clears it.
 */
export async function verifyMemories(options: VerifyOptions): Promise<VerifySummary> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const records = await options.memory.scan(limit).catch((error: unknown) => {
    options.logger.warn("could not list memories for verification", String(error));
    return [] as MemoryRecord[];
  });

  const flagged: Array<{ id: string; missing: ReadonlyArray<string> }> = [];
  let checked = 0;

  for (const record of records) {
    if (options.signal?.aborted) break;
    checked += 1;
    const missing = await isStale(record.text, options.projectRoot);
    const wasFlagged = record.metadata.stale !== undefined;

    if (missing.length === 0) {
      if (wasFlagged) await revise(options, record, { stale: undefined });
      continue;
    }

    flagged.push({ id: record.id, missing });
    if (wasFlagged) continue;
    await revise(options, record, {
      stale: { at: new Date().toISOString(), missing },
    });
  }

  return { checked, stale: flagged.length, flagged };
}

/** Rewrites one memory's metadata, keeping its id, text, and other fields. */
async function revise(
  options: VerifyOptions,
  record: MemoryRecord,
  change: { stale: unknown },
): Promise<void> {
  const metadata: Record<string, unknown> = { ...record.metadata };
  if (change.stale === undefined) delete metadata.stale;
  else metadata.stale = change.stale;

  await options.memory.revise(record, metadata).catch((error: unknown) => {
    options.logger.debug("could not update a memory's metadata", String(error));
  });
}
