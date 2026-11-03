// Shell reads are not tool calls the plugin can hook per file, so a bash
// command is parsed conservatively: only commands that print file contents
// count, and only literal paths are used. Anything with a variable, glob, or
// redirection target is ignored rather than guessed at.

import { basename, isAbsolute, resolve } from "node:path";

const READ_COMMANDS = new Set([
  "cat",
  "bat",
  "batcat",
  "head",
  "tail",
  "less",
  "more",
  "nl",
  "tac",
  "sed",
]);

const WRAPPERS = new Set([
  "sudo",
  "env",
  "command",
  "time",
  "nice",
  "nohup",
  "timeout",
]);
const MAX_PATHS = 8;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const NUMERIC = /^\d+$/;

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

/** Literal file paths a command chain reads, resolved against its cwd. */
export function shellReadPaths(command: string, cwd: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  let currentCwd = resolve(cwd);

  for (const tokens of shellCommands(command)) {
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index] ?? "";
      const name = basename(token);
      if (
        WRAPPERS.has(name) ||
        NUMERIC.test(token) ||
        token.startsWith("-") ||
        ASSIGNMENT.test(token)
      ) {
        index += 1;
        continue;
      }
      break;
    }

    const name = basename(tokens[index] ?? "");
    index += 1;

    if (name === "cd") {
      const target = tokens[index];
      if (target !== undefined && isLiteral(target)) {
        currentCwd = isAbsolute(target)
          ? resolve(target)
          : resolve(currentCwd, target);
      }
      continue;
    }

    if (!READ_COMMANDS.has(name)) continue;
    if (name === "sed" && hasInPlace(tokens)) continue;

    let sedScriptSkipped = false;
    for (const argument of tokens.slice(index)) {
      if (
        argument === "" ||
        argument.startsWith("-") ||
        argument.startsWith("+")
      ) {
        continue;
      }
      if (name === "sed" && !sedScriptSkipped) {
        sedScriptSkipped = true;
        continue;
      }
      if ((name === "head" || name === "tail") && NUMERIC.test(argument)) continue;
      if (!isLiteral(argument)) continue;

      const absolute = isAbsolute(argument)
        ? resolve(argument)
        : resolve(currentCwd, argument);
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      paths.push(absolute);
      if (paths.length >= MAX_PATHS) return paths;
    }
  }

  return paths;
}

function hasInPlace(tokens: ReadonlyArray<string>): boolean {
  return tokens.some(
    (token) =>
      token === "--in-place" ||
      token.startsWith("-i") ||
      token.startsWith("--in-place="),
  );
}

/** Variables, globs, and tilde expansion need a shell to resolve. */
function isLiteral(value: string): boolean {
  if (value === "-" || value.startsWith("~")) return false;
  return !/[$*?[\]{}]/.test(value);
}
