// Structural search through `ast-grep`, when the user has it.
//
// The plugin does not ship a parser, so this is the one analysis feature that
// depends on an external binary. It is read-only by construction: the command
// it runs is `run`, never `run --rewrite`, and the pattern is passed as an
// argument rather than through a shell.

import { spawn } from "node:child_process";

export interface AstMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface AstSearchOptions {
  readonly root: string;
  readonly pattern: string;
  /** Grammar name ast-grep knows: ts, tsx, js, python, rust, go, and more. */
  readonly lang: string;
  readonly glob?: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
  /** Probe and run injected by tests; defaults to the real binary. */
  readonly probe?: () => Promise<boolean>;
  readonly run?: (args: ReadonlyArray<string>, signal?: AbortSignal) => Promise<string | null>;
}

const DEFAULT_LIMIT = 50;
const BINARY = "ast-grep";

/** True when `ast-grep` answers a version request. */
export async function hasAstGrep(root: string): Promise<boolean> {
  const output = await runBinary(BINARY, ["--version"], root);
  return output !== null;
}

/** One ast-grep invocation; null when the binary is missing or the run fails. */
function runBinary(
  command: string,
  args: ReadonlyArray<string>,
  root: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out : err.length > 0 ? null : out));
  });
}

/** Parses ast-grep's `--json=stream` output, one JSON object per line. */
export function parseAstOutput(raw: string, limit = DEFAULT_LIMIT): AstMatch[] {
  const matches: AstMatch[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith("{")) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;

    const record = parsed as {
      file?: unknown;
      text?: unknown;
      range?: { start?: { line?: unknown } };
    };
    const path = typeof record.file === "string" ? record.file : null;
    if (path === null) continue;

    const lineNumber = record.range?.start?.line;
    const text = typeof record.text === "string" ? record.text : "";
    matches.push({
      path: path.replace(/^\.\//, ""),
      // ast-grep reports a zero-based line.
      line: typeof lineNumber === "number" ? lineNumber + 1 : 0,
      text: text.split("\n")[0]?.slice(0, 200) ?? "",
    });
    if (matches.length >= limit) break;
  }
  return matches;
}

export async function searchAst(
  options: AstSearchOptions,
): Promise<{ available: boolean; matches: AstMatch[] }> {
  const probe = options.probe ?? (() => hasAstGrep(options.root));
  if (!(await probe())) return { available: false, matches: [] };

  const limit = options.limit ?? DEFAULT_LIMIT;
  const args = [
    "run",
    "--pattern",
    options.pattern,
    "--lang",
    options.lang,
    "--json=stream",
  ];
  if (options.glob !== undefined && options.glob.length > 0) {
    args.push("--glob", options.glob);
  }

  const run =
    options.run ??
    ((commandArgs: ReadonlyArray<string>, signal?: AbortSignal) =>
      runBinary(BINARY, commandArgs, options.root, signal));

  const raw = await run(args, options.signal);
  if (raw === null) return { available: true, matches: [] };
  return { available: true, matches: parseAstOutput(raw, limit) };
}
