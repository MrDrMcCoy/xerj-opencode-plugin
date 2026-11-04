// Filesystem layout and stable names. Pure so the tests can pin the naming
// without touching disk: index prefixes are the only identity XERJ keeps
// between runs, and one wrong character means a second copy of the corpus.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface Environment {
  readonly XDG_DATA_HOME?: string;
  readonly LOCALAPPDATA?: string;
  readonly HOME?: string;
}

export function environmentFrom(env: Readonly<Record<string, string | undefined>>): Environment {
  return {
    XDG_DATA_HOME: env.XDG_DATA_HOME,
    LOCALAPPDATA: env.LOCALAPPDATA,
    HOME: env.HOME,
  };
}

/**
 * True when a directory is too broad to index: the home directory itself or a
 * filesystem root. Indexing it walks every cache, download and trash folder and
 * costs minutes of I/O for results nobody asked for.
 */
export function isOverbroadRoot(
  directory: string,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): boolean {
  const resolved = resolve(directory);
  const root = platform === "win32" ? resolve(resolved, sep) : "/";
  return resolved === root || resolved === resolve(home);
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

/**
 * One node directory per project. Each project gets its own XERJ process, data
 * dir and port, so shutting a project down cannot disturb another one.
 */
export function projectNodeDir(root: string, prefix: string): string {
  return join(root, "nodes", prefix);
}

export function nodeDataDir(nodeDir: string): string {
  return join(nodeDir, "data");
}

export function nodeLogPath(nodeDir: string): string {
  return join(nodeDir, "node.log");
}

export function nodePidPath(nodeDir: string): string {
  return join(nodeDir, "node.pid");
}

export function nodePortPath(nodeDir: string): string {
  return join(nodeDir, "port");
}

/** Heartbeats from every OpenCode process using this project's node. */
export function nodeClientsDir(nodeDir: string): string {
  return join(nodeDir, "clients");
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

/** True when `child` is strictly below `parent`, not equal to it. */
export function isPathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/** True when the first path segment below `parent` is a dot-directory. */
export function isHiddenPathInside(parent: string, child: string): boolean {
  if (!isPathInside(parent, child)) return false;
  const first = relative(resolve(parent), resolve(child)).split(sep)[0] ?? "";
  return first.startsWith(".");
}

/** Resolves a configured path against the project unless it is absolute. */
export function projectPath(projectRoot: string, value: string): string {
  const trimmed = value.trim();
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(join(projectRoot, trimmed));
}

export interface ResolvedStorageRoot {
  readonly root: string;
  /** Set when a configured path inside the project was refused as visible. */
  readonly rejected: string | null;
}

/**
 * Per-project storage lives in `.xerj` unless configured elsewhere. A path
 * inside the project is accepted only under a dot-directory: a visible engine
 * data dir would be indexed by the watcher, which feeds its own writes back
 * into the next pass forever.
 */
export function resolveStorageRoot(
  projectRoot: string,
  configured: string | null,
): ResolvedStorageRoot {
  if (configured === null || configured.trim().length === 0) {
    return { root: projectStateDir(projectRoot), rejected: null };
  }

  const root = projectPath(projectRoot, configured);
  // Equal to the project root is the worst case: engine data would sit beside
  // the sources and the watcher would index its own writes.
  const isProjectRoot = resolve(root) === resolve(projectRoot);
  const visibleInside = isPathInside(projectRoot, root) &&
    !isHiddenPathInside(projectRoot, root);
  if (isProjectRoot || visibleInside) {
    return { root: projectStateDir(projectRoot), rejected: root };
  }

  return { root, rejected: null };
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
 * Storage key for one plugin instance: a project can be loaded more than once
 * in one server (the repo and a subdirectory), and those instances must not
 * overwrite each other's counters or warnings.
 */
export function scopedStorageKey(
  kind: string,
  prefix: string,
  location: string,
): string {
  return `${kind}:${prefix}:${pathHash(location, 6)}`;
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
