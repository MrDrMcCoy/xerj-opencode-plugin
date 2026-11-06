// A project walk shared by the analysis tools. It reads what the indexer reads:
// the same skip list, text files only, and a size cap so a bundled asset is
// never pulled into memory.

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const SKIP_DIRS = new Set([
  ".git",
  ".xerj",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".next",
  ".turbo",
  ".idea",
  "secrets",
]);

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_BYTES = 1_048_576;

export interface WalkOptions {
  readonly signal?: AbortSignal;
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  /** Restricts the walk to paths matching one of these extensions. */
  readonly extensions?: ReadonlyArray<string>;
}

/** Project-relative paths under `root`, sorted, with ignored folders skipped. */
export async function listProjectFiles(
  root: string,
  options: WalkOptions = {},
): Promise<string[]> {
  const found: string[] = [];
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const extensions = options.extensions;

  async function walk(directory: string): Promise<void> {
    if (found.length >= maxFiles || options.signal?.aborted) return;

    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    // Filesystem order is not stable; sort so a report reads the same twice.
    const ordered = [...entries].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );

    for (const entry of ordered) {
      if (found.length >= maxFiles || options.signal?.aborted) return;
      if (entry.name.startsWith(".")) continue;

      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;

      if (extensions !== undefined) {
        const dot = entry.name.lastIndexOf(".");
        const extension = dot === -1 ? "" : entry.name.slice(dot);
        if (!extensions.includes(extension)) continue;
      }
      found.push(relative(root, absolute).split(sep).join("/"));
    }
  }

  await walk(root);
  return found.sort();
}

/** Reads one project file, or null when it is missing or too large. */
export async function readProjectFile(
  root: string,
  path: string,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<string | null> {
  const absolute = join(root, path);
  const info = await stat(absolute).catch(() => null);
  if (info === null || !info.isFile() || info.size > maxBytes) return null;
  return readFile(absolute, "utf8").catch(() => null);
}
