// Shell reads are not tool calls the plugin can hook per file, so a bash
// command is parsed conservatively: every simple command's literal arguments
// are treated as file references, and only arguments that resolve to an
// existing regular file are returned. Variables, globs, and redirection
// targets are skipped rather than guessed at.

import { stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

const WRAPPERS = new Set([
  "sudo",
  "env",
  "command",
  "time",
  "nice",
  "nohup",
  "timeout",
]);

const MAX_CANDIDATES = 24;
const MAX_FILES = 8;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** A single-letter short option; its value, if any, is the next token. */
const SHORT_FLAG = /^-[A-Za-z]$/;

/** Splits a shell command into simple commands, one token list each. */
export function shellCommands(command: string): string[][] {
  return tokenize(substituteCommands(command));
}

/**
 * Inlines `$(...)` and backtick substitutions as commands that run before the
 * outer one. A substitution is a real command, so a file it reads is a
 * reference; leaving it inside a token would hide it. Single-quoted text is
 * literal and is copied verbatim.
 */
function substituteCommands(command: string): string {
  const bodies: string[] = [];
  let outer = "";
  let index = 0;

  while (index < command.length) {
    const char = command[index] ?? "";

    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      const stop = end === -1 ? command.length : end + 1;
      outer += command.slice(index, stop);
      index = stop;
      continue;
    }

    if (char === "$" && command[index + 1] === "(") {
      const end = matchParen(command, index + 1);
      bodies.push(command.slice(index + 2, end));
      outer += " ";
      index = end + 1;
      continue;
    }

    if (char === "`") {
      const end = matchBacktick(command, index);
      bodies.push(command.slice(index + 1, end));
      outer += " ";
      index = end + 1;
      continue;
    }

    outer += char;
    index += 1;
  }

  // Substitutions expand before the command they belong to runs.
  return bodies.length === 0 ? outer : `${bodies.join(" ; ")} ; ${outer}`;
}

/** Index of the `)` that closes the `(` at `open`, or end of input. */
function matchParen(command: string, open: number): number {
  let depth = 0;
  let quote: "'" | '"' | null = null;

  for (let index = open; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return command.length;
}

/** Index of the backtick that closes the one at `open`, or end of input. */
function matchBacktick(command: string, open: number): number {
  for (let index = open + 1; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "`") return index;
  }

  return command.length;
}

/** One token stream; `quote` and `escaped` persist across characters. */
interface TokenState {
  readonly commands: string[][];
  current: string[];
  token: string;
  hasToken: boolean;
  quote: "'" | '"' | null;
  escaped: boolean;
  skipNext: boolean;
}

function tokenize(command: string): string[][] {
  const state: TokenState = {
    commands: [],
    current: [],
    token: "",
    hasToken: false,
    quote: null,
    escaped: false,
    skipNext: false,
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (state.escaped) {
      appendChar(state, char);
      continue;
    }
    if (char === "\\" && state.quote !== "'") {
      state.escaped = true;
      continue;
    }
    if (state.quote !== null) {
      readQuoted(state, char);
      continue;
    }
    if (char === "'" || char === '"') {
      state.quote = char;
      state.hasToken = true;
      continue;
    }
    if (char === " " || char === "\t" || char === "\r") {
      flushToken(state);
      continue;
    }
    if (isCommandBreak(char)) {
      flushCommand(state);
      continue;
    }
    index = readSpecial(state, command, index, char);
  }

  flushCommand(state);
  return state.commands;
}

/** Newline, `;`, `|`, `&`, or a subshell boundary ends the current command. */
function isCommandBreak(char: string): boolean {
  return char === "\n" || char === ";" || char === "|" || char === "&" || char === ")";
}

function appendChar(state: TokenState, char: string): void {
  state.token += char;
  state.hasToken = true;
}

function readQuoted(state: TokenState, char: string): void {
  if (char === state.quote) {
    state.quote = null;
    return;
  }
  appendChar(state, char);
}

/**
 * Handles the characters that are not plain text and returns the index the
 * loop should continue from, which only changes when a comment is skipped.
 */
function readSpecial(
  state: TokenState,
  command: string,
  index: number,
  char: string,
): number {
  // A subshell starts a new scope; `(cd dir && cat a)` resolves against `dir`.
  if (char === "(" && !state.hasToken) {
    flushCommand(state);
    return index;
  }
  if (char === "<" || char === ">") {
    readRedirection(state);
    return index;
  }
  if (char === "#" && !state.hasToken) return skipComment(command, index);

  appendChar(state, char);
  return index;
}

/** The target of a redirection is not read, so the next token is dropped. */
function readRedirection(state: TokenState): void {
  // A leading file descriptor (`2>`) belongs to the redirection, not to an
  // argument.
  if (/^\d$/.test(state.token)) {
    state.token = "";
    state.hasToken = false;
  }
  flushToken(state);
  state.skipNext = true;
}

/** Returns the index of the last character before the line ends. */
function skipComment(command: string, index: number): number {
  let at = index;
  while (at + 1 < command.length && command[at + 1] !== "\n") at += 1;
  return at;
}

function flushToken(state: TokenState): void {
  if (!state.hasToken) return;
  if (!state.skipNext) state.current.push(state.token);
  state.skipNext = false;
  state.token = "";
  state.hasToken = false;
}

function flushCommand(state: TokenState): void {
  flushToken(state);
  if (state.current.length > 0) state.commands.push(state.current);
  state.current = [];
}

/**
 * Existing files a command chain references, resolved against its cwd. Every
 * literal argument is a candidate, so `grep pattern file.md` and
 * `./scripts/gen.sh` count the same as `cat file.md`; the stat call, not a
 * command whitelist, decides what is real.
 */
export async function shellReadPaths(
  command: string,
  cwd: string,
): Promise<string[]> {
  const base = resolve(cwd);
  const found = candidatesFrom(command, base);

  const files: string[] = [];
  const seen = new Set<string>();

  for (const candidate of found) {
    const info = await stat(candidate).catch(() => null);
    if (!info?.isFile()) continue;
    if (seen.has(candidate)) continue;

    seen.add(candidate);
    files.push(candidate);
    if (files.length >= MAX_FILES) break;
  }

  return files;
}

/** Accumulates candidates while `cd` moves the working directory. */
interface CandidateScan {
  readonly found: string[];
  readonly seen: Set<string>;
  cwd: string;
}

/** Literal path-shaped arguments, in command order, deduped and capped. */
function candidatesFrom(command: string, base: string): string[] {
  const scan: CandidateScan = { found: [], seen: new Set(), cwd: base };

  for (const tokens of shellCommands(command)) {
    const start = commandWordIndex(tokens);
    const word = tokens[start] ?? "";

    // An executable referenced by path (`./scripts/gen.sh`) is a file too.
    if (word.includes("/")) addCandidate(scan, word);

    if (word === "cd") {
      scan.cwd = cdTarget(scan.cwd, tokens[start + 1]);
      continue;
    }

    // `xargs -a list` reads arguments (paths) from a file, so that file is a
    // reference. Arguments xargs receives on stdin cannot be known here.
    if (basename(word) === "xargs") {
      addXargsFiles(scan, tokens, start + 1);
      continue;
    }

    addArguments(scan, tokens, start + 1);
    if (scan.found.length >= MAX_CANDIDATES) return scan.found;
  }

  return scan.found;
}

/** Skips wrappers, flags, and `VAR=value` prefixes to find the command word. */
function commandWordIndex(tokens: ReadonlyArray<string>): number {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (
      WRAPPERS.has(basename(token)) ||
      token.startsWith("-") ||
      ASSIGNMENT.test(token)
    ) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

function addCandidate(scan: CandidateScan, value: string): void {
  if (!isLiteral(value)) return;

  const absolute = isAbsolute(value) ? resolve(value) : resolve(scan.cwd, value);
  if (scan.seen.has(absolute)) return;

  scan.seen.add(absolute);
  scan.found.push(absolute);
}

/** The directory a `cd` moves to, or the current one when it cannot be known. */
function cdTarget(cwd: string, target: string | undefined): string {
  if (target === undefined || !isLiteral(target)) return cwd;
  return isAbsolute(target) ? resolve(target) : resolve(cwd, target);
}

function addXargsFiles(
  scan: CandidateScan,
  tokens: ReadonlyArray<string>,
  from: number,
): void {
  for (let cursor = from; cursor < tokens.length; cursor += 1) {
    const argument = tokens[cursor] ?? "";
    if (argument === "-a" || argument === "--arg-file") {
      const value = tokens[cursor + 1];
      if (value !== undefined) {
        addCandidate(scan, value);
        cursor += 1;
      }
      continue;
    }
    if (argument.startsWith("--arg-file=")) {
      addCandidate(scan, argument.slice("--arg-file=".length));
    }
  }
}

/** Every literal argument; a short flag's value is skipped, not indexed. */
function addArguments(
  scan: CandidateScan,
  tokens: ReadonlyArray<string>,
  from: number,
): void {
  let afterShortFlag = false;
  for (let cursor = from; cursor < tokens.length; cursor += 1) {
    const argument = tokens[cursor] ?? "";
    if (afterShortFlag) {
      afterShortFlag = false;
      continue;
    }
    if (argument.startsWith("-")) {
      afterShortFlag = SHORT_FLAG.test(argument);
      continue;
    }
    if (argument.startsWith("+")) continue;

    addCandidate(scan, argument);
    if (scan.found.length >= MAX_CANDIDATES) return;
  }
}

/** Variables, globs, and tilde expansion need a shell to resolve. */
function isLiteral(value: string): boolean {
  if (value === "-" || value.startsWith("~")) return false;
  return !/[$*?[\]{}]/.test(value);
}
