// Automatic memory grows with every substantive turn, so it needs a ceiling.
// Two independent caps apply: age says a summary stops being knowledge after
// a while, size says the store must stay cheap to search no matter how fresh
// it is. Whichever binds first decides.
//
// Deliberate memories (facts, decisions, preferences, fixes, notes) are never
// pruned: the user asked for those to be kept, and they are small. Only
// `summary` entries, written by capture, are subject to retention.

import type { Logger } from "../log.ts";
import type { MemoryStore } from "./store.ts";

const SUMMARY_KIND = "summary";
const DAY_MS = 86_400_000;
/** One page is enough: above this, the store is far past any sane cap. */
const MAX_LISTED = 5_000;

export interface RetainLimits {
  /** Days a summary is kept; 0 disables the age cap. */
  readonly days: number;
  /** Summaries kept regardless of age; 0 disables the count cap. */
  readonly maxCount: number;
  /** Bytes of summary text kept; 0 disables the size cap. */
  readonly maxBytes: number;
}

export interface RetainEntry {
  readonly id: string;
  readonly kind: string;
  readonly created: string | null;
  readonly bytes: number;
}

/**
 * Ids to forget. Keeps the newest summaries while every enabled cap still
 * admits them, so a single pass enforces age, count, and size together.
 */
export function planPrune(
  entries: ReadonlyArray<RetainEntry>,
  limits: RetainLimits,
  now: number,
): string[] {
  const summaries = entries.filter((entry) => entry.kind === SUMMARY_KIND);
  const newestFirst = [...summaries].sort((left, right) => at(right) - at(left));
  const cutoff = limits.days > 0 ? now - limits.days * DAY_MS : null;

  const forgotten: string[] = [];
  let kept = 0;
  let bytes = 0;

  for (const entry of newestFirst) {
    const created = at(entry);
    // An entry with no timestamp cannot be aged out; only size can drop it.
    const tooOld = cutoff !== null && created > 0 && created < cutoff;
    const tooMany = limits.maxCount > 0 && kept >= limits.maxCount;
    const tooBig = limits.maxBytes > 0 && bytes + entry.bytes > limits.maxBytes;

    if (tooOld || tooMany || tooBig) {
      forgotten.push(entry.id);
      continue;
    }
    kept += 1;
    bytes += entry.bytes;
  }

  return forgotten;
}

/** How often the background sweep runs while the plugin is loaded. */
const SWEEP_INTERVAL_MS = 3_600_000;

/**
 * Runs one sweep now and then hourly until `signal` aborts. Errors are logged
 * and never escape: retention is maintenance, not a request path.
 */
export function startRetention(
  memory: MemoryStore,
  limits: RetainLimits,
  signal: AbortSignal,
  logger: Logger,
): void {
  const sweep = (): void => {
    void pruneMemory({ memory, limits, logger }).catch((error: unknown) => {
      logger.debug("memory retention skipped", String(error));
    });
  };

  sweep();
  const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  signal.addEventListener(
    "abort",
    () => {
      clearInterval(timer);
    },
    { once: true },
  );
}

/** Lists, plans, and forgets. Returns how many entries were removed. */
export async function pruneMemory(options: {
  readonly memory: MemoryStore;
  readonly limits: RetainLimits;
  readonly logger: Logger;
  readonly now?: number;
}): Promise<number> {
  const entries = await options.memory.list(MAX_LISTED);
  if (entries.length === 0) return 0;

  const forgotten = planPrune(entries, options.limits, options.now ?? Date.now());
  let removed = 0;
  for (const id of forgotten) {
    const ok = await options.memory.forget(id).catch(() => false);
    if (ok) removed += 1;
  }

  if (removed > 0) {
    options.logger.info("pruned old memories", {
      removed,
      kept: entries.length - removed,
      limits: options.limits,
    });
  }
  return removed;
}

function at(entry: RetainEntry): number {
  if (entry.created === null) return 0;
  const parsed = Date.parse(entry.created);
  return Number.isFinite(parsed) ? parsed : 0;
}
