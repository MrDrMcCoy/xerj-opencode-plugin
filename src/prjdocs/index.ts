// Project documentation corpus: official docs for the languages, frameworks,
// and cloud APIs a project references, at the versions it uses and the latest
// known ones.
//
// Two properties matter. First, every page carries the version it came from, so
// a run prunes pages for a version the project no longer uses. Second, the same
// manifest trick as the system docs corpus keeps repeat runs cheap: a page
// whose URL and body hash are unchanged is skipped.

import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "../log.ts";
import type { XerjClient } from "../node/client.ts";
import { readManifest, writeManifest } from "../manifest.ts";
import { crawlDocs, type CrawledPage } from "./crawl.ts";
import {
  DocsDiscovery,
  readDiscovered,
  writeDiscovered,
  type SearchSurface,
} from "./discover.ts";
import { PageJudge, projectTerms } from "./relevance.ts";
import { builtinSources, type BuiltinSource } from "./builtin.ts";
import { detectTech, type TechRef } from "./detect.ts";
import { docsTargets, maxPagesFor, type DocsTarget } from "./sources.ts";

const MANIFEST_FILE = "prjdocs-manifest.json";
const BUILTIN_FILE = "prjdocs-builtin.json";
const BATCH_SIZE = 50;

export interface PrjdocsOptions {
  readonly client: XerjClient;
  readonly prefix: string;
  readonly projectRoot: string;
  readonly stateDir: string;
  readonly logger: Logger;
  /** Pages per documentation source, overriding the table. */
  readonly maxPages?: number;
  /** Targets to crawl this run, in total. */
  readonly maxTargets?: number;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  /** Resolves the latest release of a technology; null when unknown. */
  readonly latestVersion?: (ref: TechRef) => Promise<string | null>;
  /** Eager mode: no depth cap, any text page, model-judged relevance. */
  readonly eager?: EagerOptions;
  /**
   * Elasticsearch wire version to pull docs for; the node reports it and the
   * docs branch follows it. Omitted means "always include the defaults".
   */
  readonly builtin?: BuiltinOptions;
}

export interface BuiltinOptions {
  /** False skips XERJ's own docs and the Elasticsearch reference. */
  readonly enabled: boolean;
  /** Wire version from the node banner, e.g. `8.13.0`. */
  readonly elasticsearchVersion: string;
  /** Markdown files taken from the XERJ repository. */
  readonly xerjPages: number;
  /** Pages taken from the Elasticsearch reference. */
  readonly elasticsearchPages: number;
  /**
   * Days a builtin source stays current. A crawl of the whole reference takes
   * minutes, so it runs on this window instead of on every command; 0 always
   * refreshes.
   */
  readonly refreshDays: number;
  /** Crawl the whole Elasticsearch guide, minus its history chapters. */
  readonly eager?: boolean;
}

export interface EagerOptions {
  readonly maxPages: number;
  readonly maxDepth: number;
  /** Stateless model call; when absent the heuristic judges every page. */
  readonly generate?: (prompt: string) => Promise<string>;
  /** Search surface for technologies the source table does not know. */
  readonly search?: SearchSurface;
  /** Total model judgements per run. */
  readonly maxModelCalls?: number;
  /** Search queries per run. */
  readonly maxQueries?: number;
}

export interface PrjdocsSummary {
  readonly techs: ReadonlyArray<string>;
  readonly targets: number;
  readonly pages: number;
  readonly indexed: number;
  readonly skipped: number;
  readonly pruned: number;
  readonly failed: number;
  readonly bytes: number;
  /** Technologies with no known documentation source. */
  readonly unsupported: ReadonlyArray<string>;
}

interface ManifestEntry {
  readonly id: string;
  readonly version: string;
  readonly tech: string;
  readonly hash: string;
}

/** One run: detect, crawl the resolvable targets, then reconcile the corpus. */
export class PrjdocsIndexer {
  private mapped = false;

  constructor(private readonly options: PrjdocsOptions) {}

  async run(): Promise<PrjdocsSummary> {
    const techs = await detectTech(this.options.projectRoot, {
      includeUnknown: this.options.eager !== undefined,
    });
    const targets: DocsTarget[] = [];
    const unsupported: string[] = [];
    const eager = this.options.eager;

    // Eager mode searches for docs of technologies the table does not know and
    // remembers what it found, so the search happens once per technology.
    const discovery =
      eager === undefined
        ? null
        : new DocsDiscovery(
            {
              search: eager.search,
              stateDir: this.options.stateDir,
              logger: this.options.logger,
              maxQueries: eager.maxQueries,
            },
            await readDiscovered(this.options.stateDir),
          );

    const terms = projectTerms(techs.map((ref) => `${ref.id} ${ref.evidence}`));

    // XERJ's own docs and the Elasticsearch API are part of every run: a project
    // asking how the engine behaves needs both, whatever its dependencies are.
    // Off unless the caller asks: the command turns this on from configuration,
    // and a library call should not reach the network uninvited.
    const builtins: BuiltinSource[] =
      this.options.builtin?.enabled === true
        ? builtinSources(
            this.options.builtin?.elasticsearchVersion ?? "8.13",
            {
              logger: this.options.logger,
              fetchImpl: this.options.fetchImpl,
              signal: this.options.signal,
              xerjMaxPages: this.options.builtin?.xerjPages,
              maxPages: this.options.builtin?.elasticsearchPages,
              eager: this.options.builtin?.eager,
            },
          )
        : [];

    for (const source of builtins) {
      targets.push({
        id: source.tech,
        url: source.url,
        version: source.version,
        collect: source.collect,
      });
    }

    for (const ref of techs.slice(0, this.options.maxTargets ?? 40)) {
      const resolve = this.options.latestVersion;
      const latest =
        resolve === undefined ? null : await resolve(ref).catch(() => null);
      let found = docsTargets(ref, latest);
      if (found.length === 0 && discovery !== null) {
        const url = await discovery.find(ref.id);
        if (url !== null) {
          found = [{ id: ref.id, url, version: ref.used ?? "latest" }];
        }
      }
      if (found.length === 0) {
        unsupported.push(ref.id);
        continue;
      }
      targets.push(...found);
    }

    const manifest = await this.readManifest();
    const builtinState = await this.readBuiltinState();
    const refreshed: Record<string, { at: number; version: string }> = { ...builtinState };
    const desired = new Map<string, ManifestEntry>();
    let indexed = 0;
    let pages = 0;
    let failed = 0;
    let bytes = 0;

    if (targets.length > 0) await this.ensureMapping();

    // A builtin source that ran inside its window is kept as it is: its pages
    // stay in the desired set so the prune pass leaves them alone.
    const refreshWindowMs = (this.options.builtin?.refreshDays ?? 7) * 86_400_000;
    const skippedBuiltins = new Set<string>();

    if (builtinState !== undefined) {
      for (const source of builtins) {
        const previous = builtinState[source.tech];
        if (previous === undefined || refreshWindowMs <= 0) continue;
        const fresh = Date.now() - previous.at < refreshWindowMs;
        if (!fresh || previous.version !== source.version) continue;

        skippedBuiltins.add(source.tech);
        for (const [url, entry] of Object.entries(manifest)) {
          if (entry.tech === source.tech) desired.set(url, entry);
        }
      }
    }

    for (const target of targets) {
      if (skippedBuiltins.has(target.id) && target.collect !== undefined) continue;

      // One judge per target: its cache and call budget belong to that site.
      const judge =
        eager === undefined
          ? undefined
          : new PageJudge(
              { tech: target.id, version: target.version, terms },
              {
                generate: eager.generate,
                maxModelCalls: eager.maxModelCalls,
                logger: this.options.logger,
              },
            );

      // A source that hands over its pages skips the crawler and the judge: the
      // repository tree and the API reference are relevant by construction.
      const crawled =
        target.collect !== undefined
          ? await target.collect().catch((error: unknown) => {
              this.options.logger.debug("could not fetch builtin docs", String(error));
              return [] as CrawledPage[];
            })
          : await this.crawlTarget(target, judge, eager);

      if (crawled.length === 0) failed += 1;
      pages += crawled.length;

      const fresh = crawled.filter((page) => {
        const id = documentId(page.url);
        const hash = bodyHash(page.body);
        const previous = manifest[page.url];
        if (previous !== undefined && previous.hash === hash) {
          desired.set(page.url, previous);
          return false;
        }
        desired.set(page.url, { id, version: target.version, tech: target.id, hash });
        return true;
      });

      for (let start = 0; start < fresh.length; start += BATCH_SIZE) {
        const batch = fresh.slice(start, start + BATCH_SIZE);
        const actions = batch.map((page) => {
          const entry = desired.get(page.url);
          return {
            id: entry?.id ?? documentId(page.url),
            source: {
              url: page.url,
              title: page.title,
              body: page.body,
              tech: target.id,
              version: target.version,
              fetched_at: new Date().toISOString(),
            },
          };
        });

        try {
          await this.options.client.bulk(this.indexName(), actions);
          indexed += actions.length;
          bytes += batch.reduce((total, page) => total + page.bytes, 0);
        } catch (error) {
          failed += 1;
          this.options.logger.warn("could not index project docs", String(error));
        }
      }
    }

    // Anything not re-seen this run belongs to a version the project no longer
    // uses, or to a page that moved: its document goes.
    const stale = Object.entries(manifest)
      .filter(([url]) => !desired.has(url))
      .map(([, entry]) => entry.id);
    let pruned = 0;
    for (let start = 0; start < stale.length; start += BATCH_SIZE) {
      const ids = stale.slice(start, start + BATCH_SIZE);
      await this.options.client.bulkDelete(this.indexName(), ids).catch((error: unknown) => {
        this.options.logger.warn("could not prune project docs", String(error));
      });
      pruned += ids.length;
    }

    const kept: Record<string, ManifestEntry> = {};
    for (const [url, entry] of desired) kept[url] = entry;
    await this.writeManifest(kept);
    if (discovery !== null) {
      await writeDiscovered(this.options.stateDir, discovery.snapshot());
    }

    // Record when each builtin source was last refreshed, so the next run can
    // skip a crawl that would only re-download the same pages.
    for (const source of builtins) {
      if (skippedBuiltins.has(source.tech)) continue;
      if (targets.some((target) => target.id === source.tech)) {
        refreshed[source.tech] = { at: Date.now(), version: source.version };
      }
    }
    await this.writeBuiltinState(refreshed);

    return {
      techs: techs.map((ref) => `${ref.id}${ref.used === null ? "" : `@${ref.used}`}`),
      targets: targets.length,
      pages,
      indexed,
      skipped: pages - indexed,
      pruned,
      failed,
      bytes,
      unsupported,
    };
  }

  /**
   * One target is one site or a set of component guides. A toolkit source
   * names its components, so each is crawled on its own with a share of the
   * budget and the pages are merged by URL.
   */
  private async crawlTarget(
    target: DocsTarget,
    judge: PageJudge | undefined,
    eager: { maxPages: number; maxDepth: number } | undefined,
  ): Promise<CrawledPage[]> {
    const budget = eager?.maxPages ?? this.options.maxPages ?? maxPagesFor(target.id);
    const seeds = target.seeds ?? [];
    // A component guide needs enough pages to reach its API pages; a share
    // below eight only fetches a guide's front page.
    const perSeed = seeds.length === 0 ? budget : Math.max(8, Math.floor(budget / seeds.length));

    const crawlOne = async (
      entry: string,
      prefix: string | undefined,
      maxPages: number,
    ): Promise<CrawledPage[]> =>
      crawlDocs({
        entry,
        maxPages,
        maxDepth: eager?.maxDepth,
        maxBytes: target.maxBytes,
        urlPrefix: prefix,
        anyText: eager !== undefined,
        judge:
          judge === undefined
            ? undefined
            // The entry page is the site's own root, so it is always kept: it
            // seeds the crawl even when its wording matches nothing.
            : async (page) =>
                page.url === entry ||
                (await judge.judge(page.url, page.title, page.body)).relevant,
        logger: this.options.logger,
        fetchImpl: this.options.fetchImpl,
        signal: this.options.signal,
      }).catch((error: unknown) => {
        this.options.logger.debug("docs crawl failed", String(error));
        return [] as CrawledPage[];
      });

    if (seeds.length === 0) {
      return crawlOne(target.url, target.urlPrefix, budget);
    }

    // The entry page carries the site's own overview and links, so it is a seed
    // as well; a source that already lists it is not crawled twice.
    const all = seeds.some((seed) => seed.url === target.url)
      ? seeds
      : [{ url: target.url, prefix: target.urlPrefix }, ...seeds];

    // Four seeds at a time: one vendor host serves every component guide, and
    // seventeen simultaneous crawls of it are answered with empty pages.
    const collected = new Map<string, CrawledPage>();
    const results: CrawledPage[][] = [];
    for (let start = 0; start < all.length; start += 4) {
      const batch = all.slice(start, start + 4);
      results.push(...(await Promise.all(
        batch.map((seed) => crawlOne(seed.url, seed.prefix, perSeed)),
      )));
    }
    for (const pages of results) {
      for (const page of pages) {
        if (collected.size >= budget) break;
        if (!collected.has(page.url)) collected.set(page.url, page);
      }
    }
    return [...collected.values()];
  }

  private indexName(): string {
    return `${this.options.prefix}-docs`;
  }

  /** Plain `text`, like the system docs: embedding whole doc sites costs hours. */
  private async ensureMapping(): Promise<void> {
    if (this.mapped) return;

    try {
      await this.options.client.put(
        `/${this.indexName()}`,
        {
          mappings: {
            properties: {
              body: { type: "text" },
              title: { type: "keyword" },
              url: { type: "keyword" },
              tech: { type: "keyword" },
              version: { type: "keyword" },
              fetched_at: { type: "date" },
            },
          },
        },
        "could not create the project docs index",
      );
    } catch (error) {
      // The index survives restarts, so an existing one is the normal case.
      this.options.logger.debug("project docs index already present", String(error));
    }
    this.mapped = true;
  }

  private readBuiltinState(): Promise<Record<string, { at: number; version: string }>> {
    return readManifest(this.builtinPath());
  }

  private writeBuiltinState(
    state: Record<string, { at: number; version: string }>,
  ): Promise<void> {
    return writeManifest(this.builtinPath(), state, this.options.logger);
  }

  private builtinPath(): string {
    return join(this.options.stateDir, BUILTIN_FILE);
  }

  private readManifest(): Promise<Record<string, ManifestEntry>> {
    return readManifest(this.manifestPath());
  }

  private writeManifest(manifest: Record<string, ManifestEntry>): Promise<void> {
    return writeManifest(this.manifestPath(), manifest, this.options.logger);
  }

  private manifestPath(): string {
    return join(this.options.stateDir, MANIFEST_FILE);
  }
}

function documentId(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

function bodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}
