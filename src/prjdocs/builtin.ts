// Documentation that always belongs in the corpus, whatever the project uses:
// XERJ's own docs and recipes, and the Elasticsearch API reference for the
// version this node emulates. A project reading XERJ's API needs both to answer
// questions about the engine it is talking to.

import type { Logger } from "../log.ts";
import { extractPlain, type CrawledPage } from "./crawl.ts";
import type { HostRateLimiter } from "./ratelimit.ts";
import { DEFAULT_DOCS_USER_AGENT } from "./user-agent.ts";

const REPO = "xerj-org/xerj";
const REPO_BRANCH = "main";
const TREE_API = `https://api.github.com/repos/${REPO}/git/trees/${REPO_BRANCH}?recursive=1`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${REPO_BRANCH}`;
const BLOB_BASE = `https://github.com/${REPO}/blob/${REPO_BRANCH}`;

const ES_DEFAULT_VERSION = "8.13";

/**
 * Chapter entry points for the API reference. `index.html` alone surfaces the
 * guide's overview and release notes; these are the chapters a project asking
 * about the API actually reads.
 */
const ES_SEEDS = [
  "rest-apis.html",
  "query-dsl.html",
  "mapping.html",
  "analysis.html",
  "search-analyze.html",
  "documents-indices.html",
  "index-modules.html",
  "api-conventions.html",
  "text.html",
  "keyword.html",
  "setup.html",
];
const REQUEST_TIMEOUT_MS = 15_000;
const CONCURRENCY = 6;

export interface BuiltinOptions {
  readonly logger: Logger;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  /** Markdown files to take from the XERJ repository. */
  readonly xerjMaxPages?: number;
  /** Pages to take from the Elasticsearch reference. */
  readonly maxPages?: number;
  /**
   * Crawl the whole guide, not only the API chapters. Release notes, migration
   * guides, and deprecated-API pages stay out: they describe versions other
   * than the one in use.
   */
  readonly eager?: boolean;
  /** Deadline for one page request. */
  readonly requestTimeoutMs?: number;
  /** `User-Agent` sent with every request. */
  readonly userAgent?: string;
  /** Per-host spacing shared by every crawl in one run. */
  readonly limiter?: HostRateLimiter;
}

/** Guide chapters that are about history rather than the current API. */
const EXCLUDED_CHAPTERS =
  /(release-notes|release-highlights|whats-new|migrat|breaking-change|removed-feature|deprecat|changelog|upgrade)/i;

/** One always-on documentation source and the pages it yields. */
export interface BuiltinSource {
  readonly tech: string;
  readonly version: string;
  readonly url: string;
  readonly collect: () => Promise<CrawledPage[]>;
}

/**
 * XERJ's own documentation: every markdown file under `docs/`, including the
 * recipes. Fetched from the repository rather than a rendered site so a page is
 * the source text, with no navigation to strip.
 */
export function xerjDocsSource(options: BuiltinOptions): BuiltinSource {
  return {
    tech: "xerj",
    version: REPO_BRANCH,
    url: `${BLOB_BASE}/docs/README.md`,
    collect: () => fetchRepoDocs(options),
  };
}

/** Where the Elasticsearch reference for a wire version lives. */
export function elasticsearchDocsSource(
  version: string,
  options: BuiltinOptions,
): BuiltinSource {
  const branch = elasticsearchBranch(version);
  return {
    tech: "elasticsearch",
    version: branch,
    url: `https://www.elastic.co/guide/en/elasticsearch/reference/${branch}/index.html`,
    collect: () => fetchElasticsearchDocs(branch, options),
  };
}

/** `8.13.0` becomes the `8.13` docs branch: patches share one reference. */
export function elasticsearchBranch(wireVersion: string): string {
  const match = /^(\d+)\.(\d+)/.exec(wireVersion);
  if (match?.[1] === undefined || match[2] === undefined) return ES_DEFAULT_VERSION;
  return `${match[1]}.${match[2]}`;
}

/** The two sources a run always includes, in the order they should be indexed. */
export function builtinSources(
  elasticsearchVersion: string,
  options: BuiltinOptions,
): BuiltinSource[] {
  return [xerjDocsSource(options), elasticsearchDocsSource(elasticsearchVersion, options)];
}

/** Markdown paths under `docs/`, shallow paths first so the overview lands early. */
export async function listRepoDocs(options: BuiltinOptions): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  await options.limiter?.wait(TREE_API);
  const response = await fetchImpl(TREE_API, {
    headers: { "user-agent": options.userAgent ?? DEFAULT_DOCS_USER_AGENT },
    signal: mergeSignal(
      options.signal,
      options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    ),
  });
  if (!response.ok) {
    options.logger.debug("could not list XERJ docs", `status ${response.status}`);
    return [];
  }

  const body: unknown = await response.json().catch(() => null);
  const tree = isRecord(body) ? body.tree : undefined;
  if (!Array.isArray(tree)) return [];

  const paths = tree.flatMap((entry): string[] => {
    if (!isRecord(entry) || entry.type !== "blob") return [];
    const path = entry.path;
    if (typeof path !== "string") return [];
    if (!path.startsWith("docs/") || !path.endsWith(".md")) return [];
    return [path];
  });

  return paths.sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth !== 0 ? depth : left.localeCompare(right);
  });
}

async function fetchRepoDocs(options: BuiltinOptions): Promise<CrawledPage[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const limit = options.xerjMaxPages ?? 200;
  const paths = (await listRepoDocs(options)).slice(0, limit);
  const pages: CrawledPage[] = [];

  // Six at a time: the files are small, and a serial run over ~180 pages wastes
  // most of the time waiting on the network.
  for (let start = 0; start < paths.length; start += CONCURRENCY) {
    const batch = paths.slice(start, start + CONCURRENCY);
    const fetched = await Promise.all(
      batch.map((path) => fetchRepoPage(path, options)),
    );
    for (const page of fetched) if (page !== null) pages.push(page);
  }

  options.logger.debug("fetched XERJ docs", { pages: pages.length, of: paths.length });
  return pages;
}

async function fetchRepoPage(
  path: string,
  options: BuiltinOptions,
): Promise<CrawledPage | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  if (options.signal?.aborted === true) return null;

  await options.limiter?.wait(`${RAW_BASE}/${path}`);
  const response = await fetchImpl(`${RAW_BASE}/${path}`, {
    headers: { "user-agent": options.userAgent ?? DEFAULT_DOCS_USER_AGENT },
    signal: mergeSignal(
      options.signal,
      options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    ),
  }).catch(() => null);
  if (response === null || !response.ok) return null;

  const markdown = await response.text().catch(() => "");
  if (markdown.length === 0) return null;

  const page = extractPlain(`${BLOB_BASE}/${path}`, markdown, true);
  if (page === null) return null;

  return { ...page, title: titleOf(path, markdown, page.title) };
}

/**
 * The Elasticsearch reference is a rendered site whose `rest-apis.html` links
 * every API chapter. One breadth-first crawl from it spreads the budget across
 * fifty chapter summaries and reaches few actual endpoints, so each chapter is
 * crawled on its own with a share of the budget.
 */
async function fetchElasticsearchDocs(
  branch: string,
  options: BuiltinOptions,
): Promise<CrawledPage[]> {
  // Imported here so the builtin module does not pull the crawler into tests
  // that only need the URL helpers.
  const { crawlDocs } = await import("./crawl.ts");

  const total = options.maxPages ?? 2500;
  const base = `https://www.elastic.co/guide/en/elasticsearch/reference/${branch}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const collected = new Map<string, CrawledPage>();

  const chapters = await chapterUrls(base, fetchImpl, options);
  // Eager mode roams the whole guide; the history chapters are no part of the
  // API a project is written against.
  const keep = (url: string): boolean =>
    options.eager !== true || !EXCLUDED_CHAPTERS.test(url);
  const perChapter = Math.max(5, Math.floor(total / Math.max(1, chapters.length)));

  // Four chapters at a time: enough to keep the network busy without turning a
  // documentation crawl into a load test.
  for (let start = 0; start < chapters.length; start += 4) {
    if (collected.size >= total || options.signal?.aborted === true) break;

    const batch = chapters.slice(start, start + 4).filter(keep);
    const results = await Promise.all(
      batch.map((entry) =>
        crawlDocs({
          entry,
          maxPages: perChapter,
          maxDepth: options.eager === true ? 4 : 3,
          anyText: true,
          urlPrefix: `${base}/`,
          urlFilter: keep,
          logger: options.logger,
          fetchImpl: options.fetchImpl,
          limiter: options.limiter,
          userAgent: options.userAgent,
          signal: options.signal,
          requestTimeoutMs: options.requestTimeoutMs,
          judge: async (page) =>
            /elasticsearch/i.test(`${page.title} ${page.body.slice(0, 2_000)}`),
        }).catch(() => [] as CrawledPage[]),
      ),
    );

    for (const pages of results) {
      for (const page of pages) {
        if (collected.size >= total) break;
        if (!collected.has(page.url)) collected.set(page.url, page);
      }
    }
  }

  options.logger.debug("fetched the elasticsearch reference", {
    pages: collected.size,
    chapters: chapters.length,
  });
  return [...collected.values()];
}

/** The chapter indexes `rest-apis.html` links, falling back to the known list. */
async function chapterUrls(
  base: string,
  fetchImpl: typeof fetch,
  options: BuiltinOptions,
): Promise<string[]> {
  const { absolute, linksIn } = await import("./crawl.ts");

  // Eager mode takes its chapters from the guide's own index, which covers the
  // concepts chapters as well as the API groups.
  const listing = options.eager === true ? "index.html" : "rest-apis.html";
  await options.limiter?.wait(`${base}/${listing}`);
  const response = await fetchImpl(`${base}/${listing}`, {
    headers: { "user-agent": options.userAgent ?? DEFAULT_DOCS_USER_AGENT },
    signal: mergeSignal(
      options.signal,
      options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    ),
  }).catch(() => null);

  const found: string[] = [];
  if (response !== null && response.ok) {
    const html = await response.text().catch(() => "");
    for (const href of linksIn(html)) {
      const url = absolute(href, `${base}/${listing}`);
      if (url === null || !url.startsWith(`${base}/`)) continue;
      if (!url.endsWith(".html")) continue;
      if (found.includes(url)) continue;
      found.push(url);
    }
  }

  if (found.length === 0) {
    return ES_SEEDS.map((seed) => `${base}/${seed}`);
  }
  if (options.eager === true) {
    return [base + "/index.html", ...found.filter((url) => !EXCLUDED_CHAPTERS.test(url))];
  }
  // `rest-apis.html` itself first: it summarizes every API group.
  return [`${base}/rest-apis.html`, ...found.filter((url) => !url.endsWith("rest-apis.html"))];
}

/** The first markdown heading, else the file name. */
function titleOf(path: string, markdown: string, fallback: string): string {
  const heading = /^#{1,3}\s+(.+)$/m.exec(markdown)?.[1];
  if (heading !== undefined) return `${heading.trim()} (${path.replace(/^docs\//, "")})`;
  return `${path.replace(/^docs\//, "")} · ${fallback}`.slice(0, 160);
}

function mergeSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
