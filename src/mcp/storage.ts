// A JSON file holding the plugin's key-value state for the standalone server:
// the lifetime ledger and the log ring. Small, and it survives restarts without
// pulling in the OpenCode storage layer.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { KeyValueStorage } from "../log.ts";

export interface FileStorage extends KeyValueStorage {
  /** Synchronous read used by the logger's warm-up path. */
  snapshot(): Record<string, unknown>;
}

/**
 * One JSON file per project. Writes are synchronous on purpose: the values are
 * small counters, and losing a write would make the ledger wrong.
 */
export function fileStorage(path: string): FileStorage {
  const read = (): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  };

  let cache: Record<string, unknown> | null = null;
  const state = (): Record<string, unknown> => {
    cache ??= read();
    return cache;
  };

  return {
    snapshot: () => ({ ...state() }),
    async get(key: string): Promise<unknown> {
      return state()[key];
    },
    async set(key: string, value: unknown): Promise<void> {
      const next = { ...state(), [key]: value };
      cache = next;
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
      } catch {
        // An unwritable state directory must not break a tool call; the value
        // stays in memory for this process.
      }
    },
  };
}
