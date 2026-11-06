// Shared pieces for the integration tests: one binary resolution and one set of
// paths, so a checkout with a pinned release is used the same way everywhere.
//
// Set XERJ_BIN to reuse an existing build; otherwise the pinned release is
// downloaded once into XERJ_CACHE (default `~/.cache/opencode/xerj-int`).

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectRuntime } from "../../src/binary/detect.ts";
import { ensureBinary } from "../../src/binary/manager.ts";
import { createLogger, type Logger } from "../../src/log.ts";

/** A logger that discards everything; tests assert on state, not on logs. */
export const quietLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

/** The shared logger the harness uses for binary downloads. */
const harnessLogger = createLogger(
  (() => {
    const store = new Map<string, unknown>();
    return {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
    };
  })(),
  { echoToConsole: false },
);

export function cacheRoot(): string {
  return process.env.XERJ_CACHE ?? join(homedir(), ".cache", "opencode", "xerj-int");
}

/**
 * The binary to test against: `XERJ_BIN` when set, otherwise the newest release
 * downloaded into the cache. Returns null when the platform is unsupported or
 * the download fails, so a caller can skip instead of failing.
 */
export async function resolveBinary(root = cacheRoot()): Promise<string | null> {
  const pinned = process.env.XERJ_BIN;
  if (pinned) return pinned;

  const host = await detectRuntime({ libc: "musl", target: null });
  if (!host.info) return null;

  await mkdir(root, { recursive: true });
  const binary = await ensureBinary({
    root,
    requested: "auto",
    platform: process.platform,
    info: host.info,
    logger: harnessLogger,
  }).catch(() => null);
  return binary?.path ?? null;
}
