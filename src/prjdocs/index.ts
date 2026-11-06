// Project documentation corpus: official docs for the languages, frameworks,
// and cloud APIs a project references, at the versions it uses and the latest
// known ones.
//
// Two properties matter. First, every page carries the version it came from, so
// a run prunes pages for a version the project no longer uses. Second, the same
// manifest trick as the system docs corpus keeps repeat runs cheap: a page
// whose URL and body hash are unchanged is skipped.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../log.ts";
import type { XerjClient } from "../node/client.ts";
import { crawlDocs, type CrawledPage } from "./crawl.ts";
import {
  DocsDiscovery,
  readDiscovered,
  writeDiscovered,
  type SearchSurface,
} from "./discover.ts";
import { PageJudge, projectTerms } from "./relevance.ts";
import { detectTech, type TechRef } from "./detect.ts";
import { docsTargets, maxPagesFor, type DocsTarget } from "./sources.ts";

const MANIFEST_FILE = "prjdocs-manifest.json";
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
    const desired = new Map<string, ManifestEntry>();
    let indexed = 0;
    let pages = 0;
    let failed = 0;
    let bytes = 0;

    if (targets.length > 0) await this.ensureMapping();

    for (const target of targets) {
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

      const crawled = await crawlDocs({
        entry: target.url,
        maxPages: eager?.maxPages ?? this.options.maxPages ?? maxPagesFor(target.id),
        maxDepth: eager?.maxDepth,
        anyText: eager !== undefined,
        judge:
          judge === undefined
            ? undefined
            // The entry page is the site's own root, so it is always kept: it
            // seeds the crawl even when its wording matches nothing.
            : async (page) =>
                page.url === target.url ||
                (await judge.judge(page.url, page.title, page.body)).relevant,
        logger: this.options.logger,
        fetchImpl: this.options.fetchImpl,
        signal: this.options.signal,
      }).catch((error: unknown) => {
        this.options.logger.debug("docs crawl failed", String(error));
        return [] as CrawledPage[];
      });

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

  private async readManifest(): Promise<Record<string, ManifestEntry>> {
    const text = await readFile(this.manifestPath(), "utf8").catch(() => null);
    if (text === null) return {};

    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, ManifestEntry>)
        : {};
    } catch {
      return {};
    }
  }

  private async writeManifest(manifest: Record<string, ManifestEntry>): Promise<void> {
    await mkdir(this.options.stateDir, { recursive: true }).catch(() => {});
    await writeFile(this.manifestPath(), JSON.stringify(manifest), "utf8").catch(
      (error: unknown) => {
        this.options.logger.debug("could not write the project docs manifest", String(error));
      },
    );
  }

  private manifestPath(): string {
    return join(this.options.stateDir, MANIFEST_FILE);
  }
}

export function documentId(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

export function bodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}
