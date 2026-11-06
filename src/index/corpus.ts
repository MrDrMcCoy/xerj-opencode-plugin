// Corpus layout and the autoindex command line. Pure pieces live here so the
// tests can pin the exact flags without spawning anything.
//
// Verified against v1.0.0-rc.100:
// - `--watch` requires `--no-graph` and emits one run document per pass on
//   stdout when `--json` is set.
// - `--brain <name>` writes docs under the given prefix and edges to
//   `.xerj-memory-<name>-edges`, and it reconciles deletions.
// - exit 3 is success with junk recorded; exit 4 is a decision request with a
//   JSON body on stdout.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { projectBrainName, projectStateDir } from "../paths.ts";

export interface CorpusLayout {
  readonly projectRoot: string;
  readonly prefix: string;
  readonly stateDir: string;
  readonly ignoreFile: string;
}

export function corpusLayout(
  projectRoot: string,
  prefix: string,
  stateRoot: string,
): CorpusLayout {
  return {
    projectRoot,
    prefix,
    // `--watch` refuses a state dir inside the watched tree: journal writes are
    // filesystem events and would restart the pass forever. The journal lives
    // under the node's engine data, so a fresh engine starts a fresh pass
    // instead of trusting a journal that describes an index it cannot see.
    stateDir: join(stateRoot, "state", prefix),
    ignoreFile: join(projectRoot, ".xerjignore"),
  };
}

/** Secret-shaped names XERJ's own ignore rules do not cover. */
const IGNORE_DEFAULTS = [
  "# Written once by the XERJ OpenCode plugin. Edit freely; it is not rewritten.",
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "**/secrets/**",
  "",
].join("\n");

export async function ensureIgnoreFile(layout: CorpusLayout): Promise<boolean> {
  await mkdir(projectStateDir(layout.projectRoot), { recursive: true });
  try {
    await writeFile(layout.ignoreFile, IGNORE_DEFAULTS, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

export interface AutoindexOptions {
  readonly layout: CorpusLayout;
  readonly nodeUrl: string;
  readonly config: Config;
  readonly watch: boolean;
  /** Rebuild the resume plan in place; ids stay stable for unchanged bytes. */
  readonly fresh?: boolean;
}

export function autoindexArgs(options: AutoindexOptions): ReadonlyArray<string> {
  const { layout, nodeUrl, config, watch, fresh = false } = options;
  const args = [
    "autoindex",
    layout.projectRoot,
    "--url",
    nodeUrl,
    "--prefix",
    layout.prefix,
    "--state-dir",
    layout.stateDir,
  ];

  // Graph mode turns the project corpus into one super brain: sections,
  // symbols, path:line and edges in a single index. The engine refuses
  // `--watch` in that mode, so the plugin's own watcher runs one-shot passes
  // instead, which it already does for project-local storage.
  const graph = config.index.graph;
  if (graph) {
    args.push("--brain", projectBrainName(layout.projectRoot));
  } else {
    args.push("--no-graph");
  }

  args.push("--json", "--progress", "none");

  if (watch && !graph) {
    args.push("--watch", "--debounce", String(config.index.debounceMs));
  }

  if (fresh) args.push("--fresh");

  if (config.index.workers !== null) {
    args.push("--workers", String(config.index.workers));
  }

  if (!config.index.semantic) {
    args.push("--no-semantic");
  }

  if (config.index.maxBytes > 0) {
    args.push("--max-index-size", String(config.index.maxBytes));
  }

  args.push("--max-minutes", String(config.index.maxMinutes));
  return args;
}

export interface CorpusRun {
  readonly at: number;
  readonly generation: number | null;
  readonly files: number | null;
  readonly records: number | null;
  readonly junk: number | null;
  readonly reason: string | null;
}

/** Parses one line of `autoindex --json` output. Returns null for anything else. */
export function parseRunDocument(line: string): CorpusRun | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;

  // Watch mode emits a run document per pass; decision requests carry a
  // different shape and are handled by the caller.
  if (record.doc_kind !== "run") return null;

  const started = typeof record.started === "string" ? Date.parse(record.started) : Number.NaN;

  return {
    at: Number.isFinite(started) ? started : Date.now(),
    generation: numberOrNull(record.generation),
    files: numberOrNull(record.files_indexed ?? record.files_total),
    records: numberOrNull(record.records_total),
    junk: numberOrNull(record.junk_records_total),
    reason: stringOrNull(record.reason),
  };
}

export type ExitMeaning = "ok" | "junk" | "decision" | "usage" | "error";

export function exitMeaning(code: number | null): ExitMeaning {
  if (code === 0) return "ok";
  if (code === 3) return "junk";
  if (code === 4) return "decision";
  if (code === 2) return "usage";
  return "error";
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
