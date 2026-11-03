// Ranking adjustments applied after fusion. Generated files match on common
// words and crowd out the source they came from, so they are demoted rather
// than dropped: a query that names the file still has to find it.

import { sep } from "node:path";
import type { ParsedHit } from "./service.ts";

const GENERATED_WEIGHT = 0.35;

const GENERATED_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "composer.lock",
  "cargo.lock",
  "gemfile.lock",
  "poetry.lock",
  "pipfile.lock",
  "go.sum",
  "flake.lock",
]);

const GENERATED_DIRS = ["dist/", "build/", "vendor/", "coverage/"];
const MINIFIED_SUFFIXES = [".min.js", ".min.css", ".map"];

/** True when the path looks generated rather than authored. */
export function isGeneratedPath(path: string): boolean {
  const normalized = path.split(sep).join("/").toLowerCase();
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);

  if (GENERATED_NAMES.has(name)) return true;
  if (MINIFIED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  return GENERATED_DIRS.some(
    (dir) => normalized.startsWith(dir) || normalized.includes(`/${dir}`),
  );
}

/**
 * Re-ranks fused hits so generated files sit below authored ones. A query that
 * names the file wins, because asking for `package-lock.json` must not demote
 * it.
 */
export function demoteGenerated(
  hits: ReadonlyArray<ParsedHit>,
  query: string,
): ParsedHit[] {
  const named = query.toLowerCase();

  return hits
    .map((hit) => {
      if (hit.path === null) return hit;
      if (!isGeneratedPath(hit.path)) return hit;
      const basename = hit.path.toLowerCase().split("/").pop() ?? "";
      if (named.includes(basename)) return hit;
      return { ...hit, score: hit.score * GENERATED_WEIGHT };
    })
    .sort((left, right) => right.score - left.score);
}
