// Finding documentation for a technology the source table does not know. Eager
// mode asks the host's web search when one is configured, keeps the result so a
// later run does not search again, and gives up quietly when no search provider
// exists.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../log.ts";

const CACHE_FILE = "prjdocs-discovered.json";

export interface SearchResultLike {
  readonly url: string;
  readonly title?: string;
}

/** The host's search surface: query in, results out. */
export interface SearchSurface {
  query(input: { query: string }): Promise<{ data: { results?: ReadonlyArray<SearchResultLike> } }>;
}

export interface DiscoverOptions {
  readonly search: SearchSurface | undefined;
  readonly stateDir: string;
  readonly logger: Logger;
  readonly maxQueries?: number;
}

/** URLs that look like a technology's own documentation, not an article. */
const DOC_HOST = /(^|\.)(docs?|developer|reference|learn|api)\.[a-z0-9.-]+$/i;
const REJECT_HOST = /(medium\.com|dev\.to|stackoverflow\.com|reddit\.com|youtube\.com|wikipedia\.org|npmjs\.com|pypi\.org|github\.com\/[^/]+\/[^/]+\/issues)/i;

/** Cached discovery results, keyed by technology id. */
export async function readDiscovered(stateDir: string): Promise<Record<string, string>> {
  const text = await readFile(join(stateDir, CACHE_FILE), "utf8").catch(() => null);
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

export async function writeDiscovered(
  stateDir: string,
  discovered: Record<string, string>,
): Promise<void> {
  await mkdir(stateDir, { recursive: true }).catch(() => {});
  await writeFile(join(stateDir, CACHE_FILE), JSON.stringify(discovered), "utf8").catch(
    () => {},
  );
}

/**
 * Documentation entry URL for one technology, from the cache or from a search.
 * Returns null when there is no search surface, no useful result, or the query
 * budget is spent.
 */
export class DocsDiscovery {
  private queries = 0;

  constructor(
    private readonly options: DiscoverOptions,
    private readonly cache: Record<string, string>,
  ) {}

  /** The cached URL for a technology, if a previous run found one. */
  cached(id: string): string | null {
    return this.cache[id] ?? null;
  }

  async find(id: string): Promise<string | null> {
    const known = this.cache[id];
    if (known !== undefined) return known;

    const search = this.options.search;
    if (search === undefined) return null;
    if (this.queries >= (this.options.maxQueries ?? 12)) return null;

    this.queries += 1;
    const response = await search
      .query({ query: `${id} official documentation` })
      .catch((error: unknown) => {
        this.options.logger.debug("docs search failed", `${id}: ${String(error)}`);
        return null;
      });
    if (response === null) return null;

    const url = pickOfficial(id, response.data.results ?? []);
    if (url === null) {
      this.options.logger.debug("no official docs found by search", id);
      return null;
    }

    this.cache[id] = url;
    return url;
  }

  snapshot(): Record<string, string> {
    return { ...this.cache };
  }
}

/** The best search result: a documentation host that mentions the technology. */
export function pickOfficial(
  id: string,
  results: ReadonlyArray<SearchResultLike>,
): string | null {
  const clean = id.toLowerCase().replace(/^@[^/]+\//, "").replace(/^[^/]+\//, "");
  const scored = results
    .map((result) => ({ result, score: scoreResult(clean, result) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  return scored[0]?.result.url ?? null;
}

function scoreResult(id: string, result: SearchResultLike): number {
  let host = "";
  try {
    host = new URL(result.url).hostname;
  } catch {
    return 0;
  }
  if (REJECT_HOST.test(result.url)) return 0;

  const haystack = `${result.title ?? ""} ${result.url}`.toLowerCase();
  if (!haystack.includes(id)) return 0;

  // A `docs.` or `developer.` host is almost always the official reference.
  return DOC_HOST.test(host) ? 3 : 1;
}
