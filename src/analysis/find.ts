// Regex and glob search over the project tree.
//
// The engine answers "where is this concept" and has no regex query, so a
// literal or pattern search is a different tool. It reads the same tree the
// indexer reads, skips the same folders, ignores secret-shaped files, and
// refuses a code block that would take longer than a turn.

import { isSecretPath, isTextPath } from "../remote/spool.ts";
import { listProjectFiles, readProjectFile } from "./walk.ts";

export interface ContentMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface FindOptions {
  readonly pattern: string;
  /** Glob limiting the walk, for example `src/**` or `*.test.ts`. */
  readonly glob?: string;
  readonly ignoreCase?: boolean;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface FindResult {
  readonly matches: ReadonlyArray<ContentMatch>;
  readonly files: number;
  /** True when the match limit stopped the walk early. */
  readonly truncated: boolean;
}

const DEFAULT_LIMIT = 100;
const MAX_LINE = 200;

/** A glob as a regular expression: `**` spans folders, `*` stays inside one. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] ?? "";
    if (char === "*") {
      if (glob[index + 1] === "*") {
        // `**/` may match nothing at all, so `src/**/a.ts` also matches `src/a.ts`.
        if (glob[index + 2] === "/") {
          out += "(?:.*/)?";
          index += 2;
        } else {
          out += ".*";
          index += 1;
        }
        continue;
      }
      out += "[^/]*";
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^(?:${out})$`);
}

/** Project files matching a glob. */
export async function findPaths(
  root: string,
  glob: string,
  options: { readonly signal?: AbortSignal; readonly limit?: number } = {},
): Promise<string[]> {
  const matcher = globToRegExp(glob);
  const files = await listProjectFiles(root, { signal: options.signal });
  const matched = files.filter((path) => matcher.test(path) && !isSecretPath(path));
  return options.limit === undefined ? matched : matched.slice(0, options.limit);
}

export async function searchContent(root: string, options: FindOptions): Promise<FindResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const flags = options.ignoreCase === true ? "gim" : "gm";
  const expression = new RegExp(options.pattern, flags);
  const matcher = options.glob === undefined ? null : globToRegExp(options.glob);

  const files = await listProjectFiles(root, { signal: options.signal });
  const matches: ContentMatch[] = [];
  let scanned = 0;

  for (const path of files) {
    if (matches.length >= limit || options.signal?.aborted) break;
    if (matcher !== null && !matcher.test(path)) continue;
    if (!isTextPath(path) || isSecretPath(path)) continue;

    const text = await readProjectFile(root, path);
    if (text === null) continue;
    scanned += 1;

    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
      if (matches.length >= limit) break;
      // A fresh lastIndex per line keeps the global flag from leaking state.
      expression.lastIndex = 0;
      if (!expression.test(line)) continue;
      matches.push({
        path,
        line: index + 1,
        text: line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line.trimEnd(),
      });
    }
  }

  return { matches, files: scanned, truncated: matches.length >= limit };
}
