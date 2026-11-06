// A bounded crawler for official documentation. It follows links only within
// the site it started on, only to HTML pages, and only up to a page budget, so a
// documentation site cannot turn one command into an unbounded download.

import type { Logger } from "../log.ts";

export interface CrawlOptions {
  readonly entry: string;
  readonly maxPages: number;
  readonly maxBytes?: number;
  readonly fetchImpl?: typeof fetch;
  readonly logger: Logger;
  readonly signal?: AbortSignal;
  /** Extra seconds between requests, to stay a polite client. */
  readonly delayMs?: number;
}

export interface CrawledPage {
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly bytes: number;
}

const DEFAULT_MAX_BYTES = 2_000_000;
const MAX_DEPTH = 2;
const REQUEST_TIMEOUT_MS = 15_000;

/** Crawls one documentation site, breadth first, from its entry URL. */
export async function crawlDocs(options: CrawlOptions): Promise<CrawledPage[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const delayMs = options.delayMs ?? 0;
  const origin = originOf(options.entry);
  if (origin === null) return [];

  const queue: Array<{ url: string; depth: number }> = [
    { url: options.entry, depth: 0 },
  ];
  const seen = new Set<string>();
  const pages: CrawledPage[] = [];

  while (queue.length > 0 && pages.length < options.maxPages) {
    const next = queue.shift();
    if (next === undefined) break;
    if (seen.has(next.url)) continue;
    seen.add(next.url);

    if (delayMs > 0 && pages.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const response = await fetchImpl(next.url, {
      headers: { "user-agent": "xerj-opencode-plugin (documentation indexer)" },
      signal: mergedSignal(options.signal, REQUEST_TIMEOUT_MS),
    }).catch((error: unknown) => {
      options.logger.debug("docs fetch failed", `${next.url}: ${String(error)}`);
      return null;
    });
    if (response === null || !response.ok) continue;

    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("text/html")) continue;

    const html = await response.text().catch(() => "");
    if (html.length === 0 || html.length > maxBytes) continue;

    const page = extractPage(next.url, html);
    if (page !== null) pages.push(page);

    if (next.depth >= MAX_DEPTH) continue;
    for (const link of linksIn(html)) {
      const url = absolute(link, next.url);
      if (url === null || seen.has(url)) continue;
      if (originOf(url) !== origin) continue;
      if (!looksLikeDocs(url)) continue;
      queue.push({ url, depth: next.depth + 1 });
    }
  }

  return pages;
}

/** Body text and title from an HTML document, with scripts and styles removed. */
export function extractPage(url: string, html: string): CrawledPage | null {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const headingMatch = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);

  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|pre|section)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (stripped.length < 200) return null;

  const title = decode(titleMatch?.[1] ?? headingMatch?.[1] ?? url).trim();
  return { url, title: title.length > 0 ? title : url, body: stripped, bytes: stripped.length };
}

/** Same-site anchor targets, in document order. */
export function linksIn(html: string): string[] {
  const links: string[] = [];
  const pattern = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi;

  for (const match of html.matchAll(pattern)) {
    const href = match[1];
    if (href === undefined) continue;
    if (/^(mailto:|javascript:|tel:)/i.test(href)) continue;
    links.push(href);
  }

  return links;
}

/** Resolves a link against its page, dropping fragments and queries. */
export function absolute(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    url.hash = "";
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Skips assets and downloads; a documentation read wants pages. */
function looksLikeDocs(url: string): boolean {
  return !/\.(png|jpe?g|gif|svg|webp|ico|css|js|json|xml|zip|gz|tgz|pdf|woff2?|ttf|mp4|webm)$/i.test(
    url,
  );
}

function mergedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (signal === undefined) return timeout;
  return AbortSignal.any([signal, timeout]);
}

function decode(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
