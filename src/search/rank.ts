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
  // License boilerplate matches almost any English prompt and never answers
  // a question about the code.
  "license",
  "license.md",
  "license.txt",
  "copying",
  "notice",
]);

// Share of the prompt's content terms a passage must carry to be injected.
const COVERAGE_RATIO = 0.6;
const MIN_TERM_LENGTH = 3;
const MAX_TERMS = 16;

// Function words and conversational filler. A prompt reduced to nothing by
// this list is a directive, not a question about the corpus.
const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "these", "those", "from",
  "into", "onto", "over", "under", "about", "after", "before", "when",
  "where", "which", "what", "why", "how", "who", "whom", "does", "did",
  "doing", "done", "have", "has", "had", "are", "was", "were", "been",
  "being", "will", "would", "should", "could", "can", "may", "might",
  "must", "shall", "you", "your", "yours", "our", "ours", "its", "their",
  "them", "they", "she", "him", "his", "her", "hers", "not", "but", "yet",
  "nor", "too", "very", "just", "also", "then", "than", "there", "here",
  "all", "any", "some", "each", "every", "both", "few", "more", "most",
  "other", "such", "only", "own", "same", "out", "off", "now", "again",
  "please", "thanks", "thank", "okay", "yes", "sure", "continue",
  "proceed", "ahead", "make", "let", "lets", "get", "give", "need",
  "want", "like", "know", "think", "see", "look", "try", "use", "using",
  "way", "ways", "thing", "things", "something", "anything", "nothing",
  "one", "ones", "still", "ever", "never", "always", "really", "well",
  "much", "many", "lot", "able", "instead", "rather", "while", "until",
  "since", "because", "though", "although", "whether", "either",
  "neither", "else", "otherwise", "thus", "hence", "therefore",
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

/**
 * Drops generated files the query does not name. Injection shares one small
 * budget across a whole turn, and a lockfile passage matches on dependency
 * names that have nothing to do with the question, so it can crowd out the
 * source that answers it. Tool searches keep them: the caller asked directly.
 */
export function dropGenerated(
  hits: ReadonlyArray<ParsedHit>,
  query: string,
): ParsedHit[] {
  const named = query.toLowerCase();

  return hits.filter((hit) => {
    if (hit.path === null) return true;
    if (!isGeneratedPath(hit.path)) return true;
    const basename = hit.path.toLowerCase().split("/").pop() ?? "";
    return named.includes(basename);
  });
}

/** The prompt's distinctive terms, lowercased, deduped, in prompt order. */
export function contentTerms(query: string): string[] {
  const tokens = query.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  const terms: string[] = [];

  for (const token of tokens) {
    if (token.length < MIN_TERM_LENGTH || STOPWORDS.has(token)) continue;
    if (terms.includes(token)) continue;
    terms.push(token);
    if (terms.length === MAX_TERMS) break;
  }

  return terms;
}

/**
 * Keeps only passages that carry most of the prompt's content terms, in the
 * text or the path. RRF has no absolute scale and the lexical embedder scores
 * everything between 0.6 and 0.8, so a prompt like "push to github, I will
 * handle npm" otherwise injects a lockfile passage at full budget. Injection
 * is the only caller: a tool search returns whatever the caller asked for.
 */
export function dropUncovered(
  hits: ReadonlyArray<ParsedHit>,
  query: string,
): ParsedHit[] {
  const terms = contentTerms(query);
  if (terms.length === 0) return [];
  const required = Math.ceil(terms.length * COVERAGE_RATIO);

  return hits.filter((hit) => {
    const haystack = `${hit.path ?? ""}\n${hit.text}`.toLowerCase();
    let covered = 0;
    for (const term of terms) {
      if (haystack.includes(term)) covered += 1;
    }
    return covered >= required;
  });
}
