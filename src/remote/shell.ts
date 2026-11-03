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
