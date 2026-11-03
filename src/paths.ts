// Filesystem layout and stable names. Pure so the tests can pin the naming
// without touching disk: index prefixes are the only identity XERJ keeps
// between runs, and one wrong character means a second copy of the corpus.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

export interface Environment {
  readonly XDG_DATA_HOME?: string;
  readonly LOCALAPPDATA?: string;
  readonly HOME?: string;
}

/** Picks the variables that matter out of a wider process environment. */
export function environmentFrom(env: Readonly<Record<string, string | undefined>>): Environment {
  return {
    XDG_DATA_HOME: env.XDG_DATA_HOME,
    LOCALAPPDATA: env.LOCALAPPDATA,
    HOME: env.HOME,
  };
}

const APP_DIR = "opencode/xerj";
const PREFIX_ROOT = "xop";
const MAX_SLUG_LENGTH = 24;
const HASH_LENGTH = 8;

/** Root for the binary, node data, and spool. Independent of any project. */
export function dataRoot(env: Environment, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? join(env.HOME ?? homedir(), "AppData", "Local");
    return join(local, APP_DIR);
  }

  if (platform === "darwin") {
    const base = env.XDG_DATA_HOME ?? join(env.HOME ?? homedir(), "Library", "Application Support");
    return join(base, APP_DIR);
  }

  const base = env.XDG_DATA_HOME ?? join(env.HOME ?? homedir(), ".local", "share");
  return join(base, APP_DIR);
}

export function binaryPath(
  root: string,
  version: string,
  platform: NodeJS.Platform,
  target: string,
): string {
  // The target is part of the directory so a shared data root can hold more
  // than one platform's binary without one overwriting the other.
  return join(root, "bin", `${version}-${target}`, binaryName(platform));
}

export function binaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "xerj.exe" : "xerj";
}

export function nodeDataDir(root: string): string {
  return join(root, "data");
}

export function nodeLogPath(root: string): string {
  return join(root, "data", "node.log");
}

export function nodePidPath(root: string): string {
  return join(root, "data", "node.pid");
}

export function releaseCachePath(root: string): string {
  return join(root, "release-cache.json");
}

export function spoolDir(root: string, prefix: string): string {
  return join(root, "spool", prefix);
}

/** Project-local state: ignore file and caches. Never the engine index. */
export function projectStateDir(projectRoot: string): string {
  return join(projectRoot, ".xerj");
}


/** Lowercase alphanumeric slug, joined by single dashes. */
export function slug(name: string, maxLength = MAX_SLUG_LENGTH): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (cleaned.length === 0) return "project";
  return cleaned.slice(0, maxLength).replace(/-+$/g, "");
}

/** First `length` hex characters of the canonical path's SHA-256. */
export function pathHash(directory: string, length = HASH_LENGTH): string {
  const canonical = resolve(directory).split(sep).join("/");
  return createHash("sha256").update(canonical).digest("hex").slice(0, length);
}

/**
 * One prefix per folder. XERJ refuses to index two folders under one prefix,
 * so the path hash is part of the name, not a nicety.
 */
export function indexPrefix(directory: string): string {
  return `${PREFIX_ROOT}-${slug(basename(resolve(directory)))}-${pathHash(directory)}`;
}

export function webPrefix(directory: string): string {
  return `${PREFIX_ROOT}-web-${pathHash(directory)}`;
}

export function externalPrefix(directory: string): string {
  return `${PREFIX_ROOT}-ext-${pathHash(directory)}`;
}

export function brainPrefix(directory: string, brain: string, hashLength = 6): string {
  return (
    `${PREFIX_ROOT}-${slug(brain, 16)}-` +
    `${pathHash(directory, hashLength)}`
  );
}

export interface DocumentRoot {
  readonly label: string;
  readonly directory: string;
}

/** Resolves configured folders relative to the project, dropping duplicates. */
export function documentRoots(
  projectRoot: string,
  labels: ReadonlyArray<string>,
): DocumentRoot[] {
  const seen = new Set<string>();

  return labels.flatMap((label) => {
    const trimmed = label.trim();
    const directory = isAbsolute(trimmed)
      ? resolve(trimmed)
      : resolve(join(projectRoot, trimmed));
    if (seen.has(directory)) return [];
    seen.add(directory);
    return [{ label: trimmed, directory }];
  });
}

export interface BrainSpec {
  /** Graph name, also the `--brain` argument. */
  readonly name: string;
  /** The configured value, e.g. `.agents` or `docs/notes`. */
  readonly label: string;
  readonly directory: string;
  readonly prefix: string;
}

/**
 * One brain per configured folder. The graph name is the folder's basename, so
 * `index.brain: [".agents"]` produces brain `agents`; duplicate basenames get a
 * numeric suffix rather than silently sharing an edge index.
 */
export function brainSpecs(
  projectRoot: string,
  labels: ReadonlyArray<string>,
): BrainSpec[] {
  const used = new Map<string, number>();
  const seenDirs = new Set<string>();

  return labels.flatMap((label) => {
    const trimmed = label.trim();
    const directory = isAbsolute(trimmed)
      ? resolve(trimmed)
      : resolve(join(projectRoot, trimmed));

    // The same folder configured twice is one brain, not two graphs.
    if (seenDirs.has(directory)) return [];
    seenDirs.add(directory);

    // The graph name is global to the node, while projects share one node.
    // A folder hash keeps two projects' `agents` brains from sharing edges.
    const folder = slug(basename(directory), 12);
    const base = `${folder}-${pathHash(directory, 4)}`;
    const seen = (used.get(base) ?? 0) + 1;
    used.set(base, seen);
    const name = seen === 1 ? base : `${base}-${seen}`;

    return [
      {
        name,
        label: trimmed,
        directory,
        prefix: brainPrefix(directory, folder),
      },
    ];
  });
}

/** Memory namespaces are their own index; the project hash keeps them apart. */
export function memoryNamespace(directory: string): string {
  return `proj-${slug(basename(resolve(directory)))}-${pathHash(directory)}`;
}
