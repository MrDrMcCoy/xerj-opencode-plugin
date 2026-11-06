// Import edges and cycles, without a parser.
//
// The engine already splits files into sections and symbols, but it does not
// record which file imports which. A small set of specifier shapes covers the
// languages this plugin sees, and the result is an approximation stated as one:
// a specifier that does not resolve to a project file is counted, not guessed
// at.

import { posix } from "node:path";
import { listProjectFiles, readProjectFile } from "./walk.ts";

export interface ImportEdge {
  readonly from: string;
  readonly to: string;
  readonly specifier: string;
}

export interface ImportScan {
  readonly files: number;
  readonly edges: ReadonlyArray<ImportEdge>;
  readonly unresolved: number;
}

const SCANNED = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".vue", ".svelte"];
const RESOLVE_ORDER = [
  ".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx", ".cjs",
  ".py", ".go", ".rs", ".vue", ".svelte", ".json",
];

const JS_FROM = /\bfrom\s+["']([^"']+)["']/g;
const JS_REQUIRE = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
const JS_DYNAMIC = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const PY_FROM = /^\s*from\s+([\w.]+)\s+import\b/gm;
const PY_IMPORT = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;
const GO_STRING = /^\s*(?:[\w.]+\s+)?"([^"]+)"/gm;
const RS_USE = /^\s*use\s+([\w:{}*, ]+);/gm;

/** Every specifier a file names. Package names are included; resolution decides. */
export function specifiersIn(path: string, text: string): string[] {
  const found = new Set<string>();
  const extension = path.slice(path.lastIndexOf("."));

  if ([".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"].includes(extension)) {
    for (const pattern of [JS_FROM, JS_REQUIRE, JS_DYNAMIC]) {
      for (const match of text.matchAll(pattern)) {
        if (match[1] !== undefined) found.add(match[1]);
      }
    }
  }

  if (extension === ".py") {
    for (const match of text.matchAll(PY_FROM)) {
      if (match[1] !== undefined) found.add(`py:${match[1]}`);
    }
    for (const match of text.matchAll(PY_IMPORT)) {
      // `import a, b` is legal; take the first module of each clause.
      for (const part of (match[1] ?? "").split(",")) {
        const module = part.trim().split(" ")[0];
        if (module !== undefined && module.length > 0) found.add(`py:${module}`);
      }
    }
  }

  if (extension === ".go") {
    for (const match of text.matchAll(GO_STRING)) {
      const value = match[1];
      // Go imports have no dots-to-slash transform and never start with "./".
      if (value !== undefined && (value.includes(".") || value.includes("/"))) {
        found.add(`go:${value}`);
      }
    }
  }

  if (extension === ".rs") {
    for (const match of text.matchAll(RS_USE)) {
      const target = (match[1] ?? "").trim().split("::")[0];
      if (target === "crate" || target === "self" || target === "super") {
        found.add(`rs:${(match[1] ?? "").trim()}`);
      }
    }
  }

  return [...found];
}

/** The first candidate that exists as a project file, trying extensions too. */
function firstExisting(files: Set<string>, bases: string[]): string | null {
  for (const base of bases) {
    if (files.has(base)) return base;

    // `./a.js` in a TypeScript project names `a.ts`: a written extension is a
    // claim about the output, not about the file on disk.
    const written = RESOLVE_ORDER.find((extension) => base.endsWith(extension));
    const stem = written === undefined ? base : base.slice(0, -written.length);

    for (const extension of RESOLVE_ORDER) {
      if (files.has(`${stem}${extension}`)) return `${stem}${extension}`;
    }
    for (const extension of RESOLVE_ORDER) {
      const index = posix.join(stem, `index${extension}`);
      if (files.has(index)) return index;
    }
  }
  return null;
}

/** The project file a specifier names, or null when it names none. */
export function resolveSpecifier(
  from: string,
  specifier: string,
  files: Set<string>,
): string | null {
  const fromDir = posix.dirname(from);

  if (specifier.startsWith("py:")) {
    const module = specifier.slice(3).replace(/\./g, "/");
    return firstExisting(files, [`${module}.py`, `${module}/__init__`]);
  }

  if (specifier.startsWith("go:")) {
    const value = specifier.slice(3);
    // Only a same-module path resolves from file names alone; the module
    // prefix of an import path is stripped before the guess.
    return firstExisting(files, [value, value.replace(/^[^/]+\//, "")]);
  }

  if (specifier.startsWith("rs:")) {
    const value = specifier.slice(3);
    const segments = value.split("::").filter((part) => part.length > 0 && part !== "crate");
    // `use a::b::Type` names items after the module path; a capitalised tail
    // is an item, not a module.
    const base = segments.filter((part) => !/^[A-Z]/.test(part)).join("/");
    return firstExisting(files, [`src/${base}.rs`, `src/${base}/mod`, `${base}.rs`]);
  }

  if (!specifier.startsWith(".")) return null;
  return firstExisting(files, [posix.normalize(posix.join(fromDir, specifier))]);
}

export async function scanImports(
  root: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<ImportScan> {
  const files = await listProjectFiles(root, {
    signal: options.signal,
    extensions: SCANNED,
  });
  const known = new Set<string>(files);
  const edges: ImportEdge[] = [];
  let unresolved = 0;

  for (const path of files) {
    if (options.signal?.aborted) break;
    const text = await readProjectFile(root, path);
    if (text === null) continue;

    for (const specifier of specifiersIn(path, text)) {
      const target = resolveSpecifier(path, specifier, known);
      if (target === null) {
        unresolved += 1;
        continue;
      }
      if (target === path) continue;
      edges.push({ from: path, to: target, specifier });
    }
  }

  return { files: files.length, edges, unresolved };
}

/**
 * Cycles among project files, shortest first. A cycle is reported once, with
 * the path rotated so the lexicographically smallest member comes first.
 */
export function findCycles(
  edges: ReadonlyArray<ImportEdge>,
  limit = 20,
): string[][] {
  const graph = new Map<string, string[]>();
  for (const edge of edges) {
    const list = graph.get(edge.from) ?? [];
    list.push(edge.to);
    graph.set(edge.from, list);
  }

  const cycles: string[][] = [];
  const seen = new Set<string>();
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];

  function visit(node: string): void {
    if (cycles.length >= limit) return;
    const current = state.get(node);
    if (current === "done") return;
    if (current === "open") {
      const start = stack.indexOf(node);
      if (start !== -1) {
        const cycle = rotate([...stack.slice(start), node]);
        const key = cycle.join(">");
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      }
      return;
    }

    state.set(node, "open");
    stack.push(node);
    for (const next of graph.get(node) ?? []) visit(next);
    stack.pop();
    state.set(node, "done");
  }

  for (const node of [...graph.keys()].sort()) visit(node);
  return cycles.sort((left, right) => left.length - right.length);
}

/** Rotates a cycle so its smallest member leads, keeping the closing member. */
function rotate(cycle: string[]): string[] {
  const body = cycle.slice(0, -1);
  if (body.length === 0) return cycle;
  let best = 0;
  for (let index = 1; index < body.length; index += 1) {
    if ((body[index] ?? "") < (body[best] ?? "")) best = index;
  }
  const rotated = [...body.slice(best), ...body.slice(0, best)];
  return [...rotated, rotated[0] ?? ""];
}
