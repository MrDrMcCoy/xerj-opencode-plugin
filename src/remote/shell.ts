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

function tokenize(command: string): string[][] {
  const commands: string[][] = [];
  let current: string[] = [];
  let token = "";
  let hasToken = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let skipNext = false;

  const flushToken = (): void => {
    if (!hasToken) return;
    if (!skipNext) current.push(token);
    skipNext = false;
    token = "";
    hasToken = false;
  };

  const flushCommand = (): void => {
    flushToken();
    if (current.length > 0) commands.push(current);
    current = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";

    if (escaped) {
      token += char;
      hasToken = true;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote !== null) {
      if (char === quote) quote = null;
      else {
        token += char;
        hasToken = true;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      hasToken = true;
      continue;
    }

    if (char === " " || char === "\t" || char === "\r") {
      flushToken();
      continue;
    }

    if (char === "\n" || char === ";" || char === "|" || char === "&") {
      flushCommand();
      continue;
    }

    // A subshell starts a new command scope; treat the parens as separators so
    // `(cd dir && cat a)` resolves against `dir`. A closing paren ends the
    // current token, which may sit right against it (`cat a)`).
    if (char === ")") {
      flushCommand();
      continue;
    }

    if (char === "(" && !hasToken) {
      flushCommand();
      continue;
    }

    if (char === "<" || char === ">") {
      // The target of a redirection is not read, so drop the next token. A
      // leading file descriptor (`2>`) is part of the redirection, not an
      // argument.
      if (/^\d$/.test(token)) {
        token = "";
        hasToken = false;
      }
      flushToken();
      skipNext = true;
      continue;
    }

    if (char === "#" && !hasToken) {
      while (index + 1 < command.length && command[index + 1] !== "\n") {
        index += 1;
      }
      continue;
    }

    token += char;
    hasToken = true;
  }

  flushCommand();
  return commands;
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

/** Literal path-shaped arguments, in command order, deduped and capped. */
function candidatesFrom(command: string, base: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  let currentCwd = base;

  const add = (value: string): void => {
    if (!isLiteral(value)) return;

    const absolute = isAbsolute(value)
      ? resolve(value)
      : resolve(currentCwd, value);
    if (seen.has(absolute)) return;

    seen.add(absolute);
    found.push(absolute);
  };

  for (const tokens of shellCommands(command)) {
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

    const word = tokens[index] ?? "";
    index += 1;

    // An executable referenced by path (`./scripts/gen.sh`) is a file too.
    if (word.includes("/")) add(word);

    if (word === "cd") {
      const target = tokens[index];
      if (target !== undefined && isLiteral(target)) {
        currentCwd = isAbsolute(target)
          ? resolve(target)
          : resolve(currentCwd, target);
      }
      continue;
    }

    // `xargs -a list` reads arguments (paths) from a file, so that file is a
    // reference. Arguments xargs receives on stdin cannot be known here.
    if (basename(word) === "xargs") {
      for (let cursor = index; cursor < tokens.length; cursor += 1) {
        const argument = tokens[cursor] ?? "";
        if (argument === "-a" || argument === "--arg-file") {
          const value = tokens[cursor + 1];
          if (value !== undefined) {
            add(value);
            cursor += 1;
          }
        } else if (argument.startsWith("--arg-file=")) {
          add(argument.slice("--arg-file=".length));
        }
      }
      continue;
    }

    let afterShortFlag = false;
    for (const argument of tokens.slice(index)) {
      if (afterShortFlag) {
        afterShortFlag = false;
        continue;
      }

      if (argument.startsWith("-")) {
        afterShortFlag = SHORT_FLAG.test(argument);
        continue;
      }
      if (argument.startsWith("+")) continue;

      add(argument);
      if (found.length >= MAX_CANDIDATES) return found;
    }
  }

  return found;
}

/** Variables, globs, and tilde expansion need a shell to resolve. */
function isLiteral(value: string): boolean {
  if (value === "-" || value.startsWith("~")) return false;
  return !/[$*?[\]{}]/.test(value);
}
