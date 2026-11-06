// What a project actually uses, from its manifests and its files. Detection is
// deliberately conservative: a technology is reported when a manifest names it
// or when a file extension proves the language is present. Guessing from prose
// would produce a documentation crawl of things the project never imports.

import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { detectGpuStacks, gpuPackages } from "./gpu.ts";

export type TechKind = "language" | "framework" | "cloud";

export interface TechRef {
  /** Stable key, also the docs-source id when one exists. */
  readonly id: string;
  readonly kind: TechKind;
  /** Version the project declares, without the range operator. */
  readonly used: string | null;
  /** Where the declaration came from, for the report. */
  readonly evidence: string;
}

/** Extension to language id. Only extensions that identify one language. */
const EXTENSIONS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".rb": "ruby",
  ".php": "php",
  ".java": "java",
  ".kt": "kotlin",
  ".cs": "csharp",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".lua": "lua",
  ".ex": "elixir",
  ".exs": "elixir",
  ".scala": "scala",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".tf": "terraform",
  ".sql": "sql",
};

/** Directories that hold vendored code, not the project's own. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".xerj",
  "target",
  "dist",
  "build",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
]);

/** Package prefixes that mean a cloud or platform API. */
const CLOUD_PATTERNS: ReadonlyArray<{ readonly id: string; readonly test: RegExp }> = [
  { id: "aws", test: /^(@aws-sdk\/|aws-sdk$|aws-cdk-lib$|@cdktf\/provider-aws$)/ },
  { id: "gcp", test: /^(@google-cloud\/|google-cloud-|firebase$|firebase-admin$)/ },
  { id: "azure", test: /^(@azure\/|azure-)/ },
  { id: "cloudflare", test: /^(wrangler$|@cloudflare\/)/ },
  { id: "supabase", test: /^(@supabase\/|supabase$)/ },
  { id: "vercel", test: /^(vercel$|@vercel\/)/ },
  { id: "stripe", test: /^stripe$/ },
  { id: "twilio", test: /^twilio$/ },
  { id: "openai", test: /^(openai$|@anthropic-ai\/)/ },
  { id: "docker", test: /^(dockerode$|@docker\/)/ },
];

/** Dependency names that are themselves the technology, not a cloud API. */
const FRAMEWORK_IDS = new Set([
  "react",
  "vue",
  "svelte",
  "next",
  "nuxt",
  "express",
  "fastify",
  "koa",
  "hono",
  "solid-js",
  "angular",
  "ember-source",
  "electron",
  "tauri",
  "django",
  "flask",
  "fastapi",
  "rails",
  "actix-web",
  "axum",
  "gin",
  "vapor",
  "spring",
  "vite",
  "webpack",
  "rollup",
  "esbuild",
  "tailwindcss",
  "prisma",
  "vitest",
  "jest",
  "playwright",
  "pytest",
  "deno",
  "bun",
  "sqlalchemy",
  "zod",
  "axios",
  "drizzle-orm",
  "typeorm",
  "sequelize",
]);

/** Strips a semver range to the version a project is written against. */
export function usedVersion(range: string): string | null {
  const match = /\d+(?:\.\d+){0,2}/.exec(range);
  return match?.[0] ?? null;
}

/** Parses a `package.json` body into its declared dependencies. */
export function packageDependencies(text: string): Array<{ name: string; version: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];

  const record = parsed as Record<string, unknown>;
  const sections = ["dependencies", "devDependencies", "peerDependencies"];
  const found: Array<{ name: string; version: string }> = [];

  for (const section of sections) {
    const deps = record[section];
    if (typeof deps !== "object" || deps === null) continue;
    for (const [name, version] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof version !== "string") continue;
      found.push({ name, version });
    }
  }

  return found;
}

/** Requirement lines from `requirements.txt`; extras and markers dropped. */
export function pythonRequirements(text: string): Array<{ name: string; version: string }> {
  const found: Array<{ name: string; version: string }> = [];

  for (const raw of text.split("\n")) {
    const line = raw.split("#")[0]?.trim() ?? "";
    if (line.length === 0 || line.startsWith("-")) continue;

    const match = /^([A-Za-z0-9_.-]+)\s*(?:\[[^\]]*\])?\s*(?:([=<>!~]=?)\s*([^\s;,]+))?/.exec(line);
    if (match?.[1] === undefined) continue;
    // `django>=4.2,<5` states a range: the lower bound is what the project runs.
    found.push({ name: match[1].toLowerCase(), version: usedVersion(match[3] ?? "") ?? "" });
  }

  return found;
}

/** `[dependencies]` and `[dev-dependencies]` from a `Cargo.toml`. */
export function cargoDependencies(text: string): Array<{ name: string; version: string }> {
  const found: Array<{ name: string; version: string }> = [];
  let inDeps = false;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inDeps = /^\[(dev-|build-)?dependencies\]$/.test(line);
      continue;
    }
    if (!inDeps || line.startsWith("#") || line.length === 0) continue;

    const simple = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"/.exec(line);
    if (simple?.[1] !== undefined) {
      found.push({ name: simple[1], version: simple[2] ?? "" });
      continue;
    }
    const table = /^([A-Za-z0-9_-]+)\s*=\s*\{/.exec(line);
    if (table?.[1] === undefined) continue;
    const version = /version\s*=\s*"([^"]+)"/.exec(line);
    found.push({ name: table[1], version: version?.[1] ?? "" });
  }

  return found;
}

/** `require` lines from a `go.mod`. */
export function goDependencies(text: string): Array<{ name: string; version: string }> {
  const found: Array<{ name: string; version: string }> = [];
  let inBlock = false;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("require (")) {
      inBlock = true;
      continue;
    }
    if (inBlock && line.startsWith(")")) {
      inBlock = false;
      continue;
    }

    const match = inBlock
      ? /^([^\s]+)\s+v?([^\s]+)/.exec(line)
      : /^require\s+([^\s]+)\s+v?([^\s]+)/.exec(line);
    if (match?.[1] !== undefined) {
      found.push({ name: match[1].toLowerCase(), version: match[2] ?? "" });
    }
  }

  return found;
}

/** One tech per manifest entry, cloud APIs classified by their package prefix. */
export function classifyDependencies(
  dependencies: ReadonlyArray<{ name: string; version: string }>,
  evidence: string,
  includeUnknown = false,
): TechRef[] {
  const refs: TechRef[] = [];
  const seen = new Set<string>();

  for (const dependency of dependencies) {
    const id = dependencyId(dependency.name);
    if (id === null) {
      // An unknown package is worth a search only when the caller asked for it;
      // its id is the package name with any scope removed.
      if (!includeUnknown) continue;
      const bare = dependency.name.replace(/^@[^/]+\//, "");
      if (bare.length < 3 || seen.has(bare)) continue;
      seen.add(bare);
      refs.push({
        id: bare,
        kind: "framework",
        used: usedVersion(dependency.version),
        evidence,
      });
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    refs.push({
      id,
      kind: CLOUD_PATTERNS.some((pattern) => pattern.test.test(dependency.name))
        ? "cloud"
        : "framework",
      used: usedVersion(dependency.version),
      evidence,
    });
  }

  return refs;
}

/** The technology a dependency name denotes, or null when it names none. */
function dependencyId(name: string): string | null {
  const cloud = CLOUD_PATTERNS.find((pattern) => pattern.test.test(name));
  if (cloud !== undefined) return cloud.id;
  // `cupy`, `pycuda`, `ash`, and their kin name a GPU toolchain directly.
  const gpu = gpuPackages().find((pattern) => pattern.test.test(name));
  if (gpu !== undefined) return gpu.id;
  if (FRAMEWORK_IDS.has(name)) return name;
  // Scoped equivalents: `@angular/core`, `@sveltejs/kit`.
  const scoped = /^@([^/]+)\//.exec(name)?.[1];
  if (scoped !== undefined && FRAMEWORK_IDS.has(scoped)) return scoped;
  return null;
}

export interface ScanOptions {
  /** Files whose extensions prove a language is present. */
  readonly extensions?: IngestedFiles;
  readonly readManifest?: (path: string) => Promise<string | null>;
  /** Directories to skip while walking. */
  readonly maxFiles?: number;
  /**
   * Report dependencies that match no known technology, so eager mode can
   * search for their documentation. Off by default: a conservative scan is
   * what the ordinary command reports.
   */
  readonly includeUnknown?: boolean;
}

/** File names and extension counts, collected in one walk. */
export interface IngestedFiles {
  readonly names: ReadonlyArray<string>;
  readonly extensionCounts: Readonly<Record<string, number>>;
}

/**
 * Walks the project once, recording top-level manifest names and how many files
 * each extension accounts for. Vendored directories are skipped: a dependency's
 * own sources say nothing about what the project uses directly.
 */
async function scanProject(
  projectRoot: string,
  maxFiles = 20_000,
): Promise<IngestedFiles> {
  const names: string[] = [];
  const extensionCounts: Record<string, number> = {};
  let seen = 0;
  const pending: Array<{ dir: string; depth: number }> = [{ dir: projectRoot, depth: 0 }];

  while (pending.length > 0 && seen < maxFiles) {
    const next = pending.pop();
    if (next === undefined) break;

    const entries = await readdir(next.dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (seen >= maxFiles) break;
      seen += 1;

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".xerj")) continue;
        // Deep trees are walked, but only a few levels: a project's own
        // manifests live at the root or one level down (a monorepo package).
        if (next.depth < 4) pending.push({ dir: join(next.dir, entry.name), depth: next.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;

      names.push(next.depth === 0 ? entry.name : join(next.dir, entry.name));
      const extension = extname(entry.name).toLowerCase();
      if (extension.length > 0) {
        extensionCounts[extension] = (extensionCounts[extension] ?? 0) + 1;
      }
    }
  }

  return { names, extensionCounts };
}

/** Files that pin the runtime version directly. */
const VERSION_FILES: Readonly<Record<string, string>> = {
  ".nvmrc": "node",
  ".node-version": "node",
  ".python-version": "python",
  ".tool-versions": "asdf",
  "rust-toolchain.toml": "rust",
  "rust-toolchain": "rust",
};

/**
 * Runtime versions from the files that pin them, plus `engines`, `go`, and
 * `requires-python`. A project that says `.nvmrc` 20 uses Node 20 regardless of
 * the newest release, and its documentation belongs at 20.
 */
export function runtimeVersions(
  files: Readonly<Record<string, string>>,
): Array<{ id: string; version: string }> {
  const found: Array<{ id: string; version: string }> = [];
  const add = (id: string, raw: string | undefined): void => {
    if (raw === undefined) return;
    const version = /\d+(?:\.\d+){0,2}/.exec(raw.trim())?.[0];
    if (version !== undefined) found.push({ id, version });
  };

  for (const [name, id] of Object.entries(VERSION_FILES)) {
    const text = files[name];
    if (text === undefined) continue;

    if (id === "asdf") {
      // `.tool-versions` holds one `tool version` pair per line.
      for (const line of text.split("\n")) {
        const match = /^(nodejs|node|python|rust|go|deno|bun)\s+(\S+)/.exec(line.trim());
        if (match?.[1] === undefined) continue;
        add(ASDF_NAMES[match[1]] ?? match[1], match[2]);
      }
      continue;
    }
    if (id === "rust" && name.endsWith(".toml")) {
      add("rust", /channel\s*=\s*"([^"]+)"/.exec(text)?.[1]);
      continue;
    }
    add(id, text.split("\n")[0]);
  }

  const packageJson = files["package.json"];
  if (packageJson !== undefined) {
    try {
      const parsed: unknown = JSON.parse(packageJson);
      const engines =
        typeof parsed === "object" && parsed !== null
          ? (parsed as { engines?: Record<string, unknown> }).engines
          : undefined;
      if (typeof engines?.node === "string") add("node", engines.node);
      if (typeof engines?.bun === "string") add("bun", engines.bun);
    } catch {
      // A malformed manifest is handled by the dependency parser.
    }
  }

  const goMod = files["go.mod"];
  if (goMod !== undefined) add("go", /^go\s+(\S+)/m.exec(goMod)?.[1]);

  const pyproject = files["pyproject.toml"];
  if (pyproject !== undefined) {
    add("python", /requires-python\s*=\s*"([^"]+)"/.exec(pyproject)?.[1]);
  }

  return found;
}

const ASDF_NAMES: Record<string, string> = {
  nodejs: "node",
  node: "node",
  python: "python",
  rust: "rust",
  go: "go",
  deno: "deno",
  bun: "bun",
};

/** Manifests this module knows how to read, by file name. */
const MANIFESTS = {
  "package.json": (text: string) => packageDependencies(text),
  "requirements.txt": (text: string) => pythonRequirements(text),
  "Cargo.toml": (text: string) => cargoDependencies(text),
  "go.mod": (text: string) => goDependencies(text),
} as const;

/** Every technology the project references, deduplicated by id. */
export async function detectTech(
  projectRoot: string,
  options: ScanOptions = {},
): Promise<TechRef[]> {
  const files = options.extensions ?? (await scanProject(projectRoot, options.maxFiles));
  const read =
    options.readManifest ??
    (async (path: string): Promise<string | null> =>
      readFile(path, "utf8").catch(() => null));

  const refs = new Map<string, TechRef>();
  const add = (ref: TechRef): void => {
    const existing = refs.get(ref.id);
    if (existing === undefined) {
      refs.set(ref.id, ref);
      return;
    }
    // A declared version wins over one inferred from a file extension.
    if (existing.used === null && ref.used !== null) refs.set(ref.id, ref);
  };

  for (const [file, parse] of Object.entries(MANIFESTS)) {
    const match = files.names.find((name) => basename(name) === file);
    if (match === undefined) continue;
    const text = await read(match.startsWith("/") ? match : join(projectRoot, match));
    if (text === null) continue;
    for (const ref of classifyDependencies(parse(text), file, options.includeUnknown === true)) {
      add(ref);
    }
  }

  // Runtime pins first: they name the version, which a file extension cannot.
  const pinned: Record<string, string> = {};
  for (const name of [...Object.keys(VERSION_FILES), "package.json", "go.mod", "pyproject.toml"]) {
    const match = files.names.find((candidate) => basename(candidate) === name);
    if (match === undefined) continue;
    const text = await read(match.startsWith("/") ? match : join(projectRoot, match));
    if (text !== null) pinned[name] = text;
  }
  for (const { id, version } of runtimeVersions(pinned)) {
    add({ id, kind: "language", used: version, evidence: "runtime version" });
  }

  // GPU toolchains are proved by headers and build files, not by extension
  // alone, so they get their own pass over a bounded set of files.
  for (const ref of await detectGpuStacks(files, read, projectRoot)) {
    add(ref);
  }

  for (const [extension, count] of Object.entries(files.extensionCounts)) {
    const id = EXTENSIONS[extension];
    if (id === undefined || count === 0) continue;
    add({ id, kind: "language", used: null, evidence: `${count} ${extension} files` });
  }

  return [...refs.values()].sort((left, right) => left.id.localeCompare(right.id));
}
