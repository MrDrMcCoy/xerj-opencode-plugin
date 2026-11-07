// Structural analysis through tree-sitter.
//
// The grammar pack is downloaded and verified by `GrammarManager`; this module
// owns the parser cache and the two derived reports: function complexity and
// structural duplicate groups. It reads only project files, never the index,
// and is used only when `analysis.treeSitter.enabled` is true.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Language, Node, Parser, Tree } from "web-tree-sitter";
import type { Logger } from "../log.ts";
import type { TreeSitterOptions } from "../config.ts";
import { listProjectFiles, readProjectFile } from "./walk.ts";
import { GrammarManager } from "./grammar.ts";

export interface ParsedFunction {
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly nodes: number;
  readonly hash: string;
}

export interface ComplexityRow extends ParsedFunction {
  readonly lines: number;
}

export interface DuplicateGroup {
  readonly hash: string;
  readonly nodes: number;
  readonly members: ReadonlyArray<ParsedFunction>;
}

export interface TreeSitterReport {
  readonly files: number;
  readonly functions: ReadonlyArray<ComplexityRow>;
  readonly duplicates: ReadonlyArray<DuplicateGroup>;
}

/** Extensions that identify a grammar the pack ships. */
export const LANGUAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".rb": "ruby",
  ".php": "php",
  ".kt": "kotlin",
  ".lua": "lua",
  ".sh": "bash",
  ".bash": "bash",
  ".json": "json",
};

/** Languages present in a file list, in sorted order. */
export function languagesForFiles(files: ReadonlyArray<string>): string[] {
  const found = new Set<string>();
  for (const file of files) {
    const dot = file.lastIndexOf(".");
    const language = dot === -1 ? undefined : LANGUAGE_EXTENSIONS[file.slice(dot)];
    if (language !== undefined) found.add(language);
  }
  return [...found].sort();
}

/** Extension list for one language, used to make the walk cheap. */
export function extensionsFor(languages: ReadonlyArray<string>): string[] {
  return Object.entries(LANGUAGE_EXTENSIONS)
    .filter(([, language]) => languages.includes(language))
    .map(([extension]) => extension);
}

const FUNCTION_NODES = new Set([
  "function_declaration",
  "function_expression",
  "generator_function_declaration",
  "method_definition",
  "arrow_function",
]);

interface Runtime {
  readonly parser: Parser;
}

export interface TreeSitterServiceOptions {
  readonly projectRoot: string;
  readonly grammarRoot: string;
  readonly config: TreeSitterOptions;
  readonly logger: Logger;
  readonly grammar?: GrammarManager;
  /** Tests inject a parser; production loads web-tree-sitter lazily. */
  readonly parseSource?: (
    source: string,
    language: string,
  ) => Promise<ReadonlyArray<Omit<ParsedFunction, "path">> | null>;
}

export class TreeSitterService {
  private readonly options: TreeSitterOptions & {
    readonly projectRoot: string;
    readonly maxParseBytes: number;
  };
  private readonly logger: Logger;
  private readonly grammar: GrammarManager;
  private readonly parse: (source: string, language: string) => Promise<
    ReadonlyArray<Omit<ParsedFunction, "path">> | null
  >;
  private parserRuntime: Promise<RuntimeModule | null> | null = null;
  private readonly runtimes = new Map<string, Runtime>();

  constructor(options: TreeSitterServiceOptions) {
    this.options = {
      enabled: options.config.enabled,
      languages: options.config.languages,
      maxParseBytes: options.config.maxParseBytes,
      projectRoot: options.projectRoot,
    };
    this.logger = options.logger;
    this.grammar =
      options.grammar ??
      new GrammarManager({ root: options.grammarRoot, logger: options.logger });
    this.parse = options.parseSource ?? ((source, language) =>
      this.parseWithRuntime(source, language));
  }

  /** Parses the project, or the one file named by `path`. */
  async report(input: {
    readonly path?: string;
    readonly top?: number;
    readonly minNodes?: number;
    readonly signal?: AbortSignal;
  }): Promise<TreeSitterReport> {
    if (!this.options.enabled) {
      throw new Error("analysis.treeSitter.enabled is off");
    }
    let files: string[];
    if (input.path !== undefined) {
      files = [input.path];
    } else {
      files = await listProjectFiles(this.options.projectRoot, {
        signal: input.signal,
        maxFiles: 2_000,
      });
    }
    const present = languagesForFiles(files);
    const wanted =
      this.options.languages.length > 0
        ? this.options.languages.filter((language) => present.includes(language))
        : present;
    if (wanted.length === 0) {
      throw new Error("no files match a grammar this build supports");
    }
    const wantedExtensions = new Set(extensionsFor(wanted));
    const selected =
      input.path !== undefined
        ? files
        : files.filter((file) => {
            const dot = file.lastIndexOf(".");
            return dot !== -1 && wantedExtensions.has(file.slice(dot));
          });
    const wasm = await this.grammar.ensure(wanted);
    if (wasm === null) {
      throw new Error(
        "the tree-sitter grammar pack is not installed and could not be downloaded",
      );
    }

    const functions: ParsedFunction[] = [];
    for (const path of selected) {
      if (input.signal?.aborted) break;
      const source = await readProjectFile(
        this.options.projectRoot,
        path,
        this.options.maxParseBytes,
      );
      if (source === null) continue;
      const dot = path.lastIndexOf(".");
      const language = dot === -1 ? undefined : LANGUAGE_EXTENSIONS[path.slice(dot)];
      if (language === undefined || !wanted.includes(language)) continue;
      const parsed = await this.parse(source, language).catch((error: unknown) => {
        this.logger.debug("tree-sitter could not parse a file", {
          path,
          error: String(error),
        });
        return null;
      });
      if (parsed === null) continue;
      for (const entry of parsed) functions.push({ ...entry, path });
    }

    return summarize(functions, {
      top: input.top ?? 20,
      minNodes: input.minNodes ?? 40,
    });
  }

  private async parseWithRuntime(
    source: string,
    language: string,
  ): Promise<ReadonlyArray<Omit<ParsedFunction, "path">> | null> {
    const runtime = await this.runtimeFor(language);
    if (runtime === null) return null;
    const tree: Tree | null = runtime.parser.parse(source);
    if (tree === null) return null;
    try {
      return functionsIn(tree.rootNode);
    } finally {
      tree.delete();
    }
  }

  private async runtimeFor(language: string): Promise<Runtime | null> {
    const cached = this.runtimes.get(language);
    if (cached !== undefined) return cached;
    const module = await this.loadRuntime();
    if (module === null) return null;
    const wasm = await this.grammar.ensure([language]);
    const path = wasm?.get(language);
    if (path === undefined) return null;
    const languageObject = await module.Language.load(path);
    const parser = new module.Parser();
    parser.setLanguage(languageObject);
    const runtime = { parser };
    this.runtimes.set(language, runtime);
    return runtime;
  }

  private async loadRuntime(): Promise<RuntimeModule | null> {
    if (this.parserRuntime !== null) return this.parserRuntime;
    const pending = (async (): Promise<RuntimeModule | null> => {
      try {
        const module = (await import("web-tree-sitter")) as unknown as RuntimeModule;
        const require = createRequire(import.meta.url);
        const runtimeWasm = require.resolve("web-tree-sitter/tree-sitter.wasm");
        await module.Parser.init({
          locateFile: (file: string) => (file.endsWith(".wasm") ? runtimeWasm : file),
        });
        return module;
      } catch (error) {
        this.logger.warn("tree-sitter runtime is unavailable", String(error));
        return null;
      }
    })();
    this.parserRuntime = pending;
    return pending;
  }
}

interface RuntimeModule {
  readonly Parser: typeof Parser & { init(options?: { locateFile?: (file: string) => string }): Promise<void> };
  readonly Language: { load(path: string): Promise<Language> };
}

/** Walks one parsed tree into function records. */
export function functionsIn(
  root: Node,
): ReadonlyArray<Omit<ParsedFunction, "path">> {
  const found: Array<Omit<ParsedFunction, "path">> = [];
  const visit = (node: Node): void => {
    if (FUNCTION_NODES.has(node.type)) {
      const name = nameOf(node);
      if (name !== null) {
        found.push({
          name,
          kind: node.type,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          nodes: namedNodes(node),
          hash: structuralHash(node),
        });
      }
    }
    for (let index = 0; index < node.namedChildCount; index += 1) {
      const child = node.namedChild(index);
      if (child !== null) visit(child);
    }
  };
  visit(root);
  return found;
}

function nameOf(node: Node): string | null {
  const own = node.childForFieldName("name");
  if (own !== null && own.text.length > 0) return own.text;
  if (node.type === "arrow_function" || node.type === "function_expression") {
    const parent = node.parent;
    if (parent !== null) {
      const name = parent.childForFieldName("name");
      if (name !== null && name.text.length > 0) return name.text;
    }
  }
  return null;
}

function namedNodes(node: Node): number {
  let count = 0;
  const visit = (current: Node): void => {
    count += 1;
    for (let index = 0; index < current.namedChildCount; index += 1) {
      const child = current.namedChild(index);
      if (child !== null) visit(child);
    }
  };
  visit(node);
  return count;
}

/** Structure only: node types, not identifiers or literals. */
function structuralHash(node: Node): string {
  const types: string[] = [];
  const walk = (current: Node): void => {
    types.push(current.type);
    for (let index = 0; index < current.namedChildCount; index += 1) {
      const child = current.namedChild(index);
      if (child !== null) walk(child);
    }
  };
  walk(node);
  return createHash("sha256").update(types.join("/")).digest("hex").slice(0, 16);
}

/** Sorts complexity and groups repeated structures. */
export function summarize(
  functions: ReadonlyArray<ParsedFunction>,
  options: { readonly top: number; readonly minNodes: number },
): TreeSitterReport {
  const rows: ComplexityRow[] = functions
    .map((entry) => ({ ...entry, lines: entry.endLine - entry.startLine + 1 }))
    .sort((left, right) => right.nodes - left.nodes || left.path.localeCompare(right.path));

  const groups = new Map<string, ParsedFunction[]>();
  for (const entry of functions) {
    if (entry.nodes < options.minNodes) continue;
    const group = groups.get(entry.hash) ?? [];
    group.push(entry);
    groups.set(entry.hash, group);
  }
  const duplicates: DuplicateGroup[] = [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([hash, members]) => ({
      hash,
      nodes: Math.min(...members.map((member) => member.nodes)),
      members: [...members].sort((left, right) =>
        left.path.localeCompare(right.path) || left.startLine - right.startLine,
      ),
    }))
    .sort((left, right) => right.members.length - left.members.length || right.nodes - left.nodes);

  return {
    files: new Set(functions.map((entry) => entry.path)).size,
    functions: rows.slice(0, Math.max(1, options.top)),
    duplicates: duplicates.slice(0, 20),
  };
}

