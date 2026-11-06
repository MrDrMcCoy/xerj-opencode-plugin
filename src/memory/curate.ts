// Memory curation: the store grows by one summary per substantive turn, and
// restatements accumulate. Exact duplicates of an automatic summary are
// dropped; anything else that looks like a repeat is flagged, never deleted,
// because a human's fact and a model's summary are not the same thing even
// when they read alike.

import type { Logger } from "../log.ts";
import type { MemoryRecord, MemoryStore } from "./store.ts";

export interface CurateOptions {
  readonly memory: MemoryStore;
  readonly logger: Logger;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface CurateSummary {
  readonly checked: number;
  /** Exact duplicates of an automatic summary that were removed. */
  readonly merged: number;
  /** Memories flagged as near-duplicates of a newer one. */
  readonly flagged: number;
}

const DEFAULT_LIMIT = 500;
/** Only automatic summaries are safe to drop: they are regenerable prose. */
const DROPPABLE_KIND = "summary";
/** Token overlap above this is a restatement, not a new fact. */
const NEAR_DUPLICATE = 0.9;

/** Case, punctuation, and spacing removed, so "The node idles." matches "node idles". */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Jaccard overlap of two texts' word sets. */
export function overlap(left: string, right: string): number {
  const a = new Set(normalize(left).split(" ").filter((word) => word.length > 0));
  const b = new Set(normalize(right).split(" ").filter((word) => word.length > 0));
  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export async function curateMemories(options: CurateOptions): Promise<CurateSummary> {
  const records = await options.memory.scan(options.limit ?? DEFAULT_LIMIT).catch((error: unknown) => {
    options.logger.warn("could not list memories for curation", String(error));
    return [] as MemoryRecord[];
  });

  let merged = 0;
  let flagged = 0;
  const kept: MemoryRecord[] = [];

  for (const record of records) {
    if (options.signal?.aborted) break;
    const duplicate = kept.find((other) => normalize(other.text) === normalize(record.text));
    if (duplicate !== undefined) {
      const droppable = kindOf(record) === DROPPABLE_KIND && kindOf(duplicate) === DROPPABLE_KIND;
      if (droppable) {
        // Both are generated prose: the newer one stays, the older is noise.
        await options.memory.forget(duplicate.id).catch(() => false);
        kept.splice(kept.indexOf(duplicate), 1);
        merged += 1;
      } else {
        await flag(options, record, duplicate.id);
        flagged += 1;
      }
      continue;
    }

    const near = kept.find((other) => overlap(other.text, record.text) >= NEAR_DUPLICATE);
    if (near !== undefined && kindOf(record) === DROPPABLE_KIND) {
      await flag(options, record, near.id);
      flagged += 1;
    }
    kept.push(record);
  }

  return { checked: records.length, merged, flagged };
}

function kindOf(record: MemoryRecord): string {
  const kind = record.metadata.kind;
  return typeof kind === "string" ? kind : "";
}

/** Records which memory this one repeats; never changes the text. */
async function flag(options: CurateOptions, record: MemoryRecord, duplicateOf: string): Promise<void> {
  const existing = record.metadata.duplicateOf;
  if (existing === duplicateOf) return;

  await options.memory
    .revise(record, { ...record.metadata, duplicateOf })
    .catch((error: unknown) => {
      options.logger.debug("could not flag a duplicate memory", String(error));
    });
}
