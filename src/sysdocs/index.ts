// System documentation corpus: every resolvable man and info page on this
// machine, indexed once and kept current.
//
// The corpus is its own index (`<prefix>-docs`) so a project's own tree stays
// separate. Two things make a full sweep practical:
//   - `body` is plain `text`, not `semantic_text`, so nothing is embedded. A
//     machine holds thousands of pages, and embedding them with the local model
//     costs hours; keyword search over man pages is what a caller wants anyway.
//   - A manifest of path, mtime, size, and document id is written after each
//     run, so an unchanged page is skipped and a page that disappeared is
//     deleted from the index.

import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Logger } from "../log.ts";
import { NodeRequestError, type XerjClient } from "../node/client.ts";
import {
  dedupePages,
  formatSysdoc,
  manPageName,
  planIngest,
  stripRoff,
  truncate,
  type ManifestEntry,
  type SysdocPage,
} from "./extract.ts";

/** Directories `man` searches when MANPATH does not override them. */
const DEFAULT_MAN_DIRS = ["/usr/local/share/man", "/usr/share/man"];
/** Directories `info` searches by default. */
const DEFAULT_INFO_DIRS = ["/usr/local/share/info", "/usr/share/info"];

/** Pages per bulk request; the client sends one request per batch. */
const BATCH_SIZE = 100;
/** Manifest name inside the plugin state directory. */
const MANIFEST_FILE = "sysdocs-manifest.json";

export interface SysdocOptions {
  readonly client: XerjClient;
  readonly prefix: string;
  /** Where the manifest lives; it is plugin state, never project content. */
  readonly stateDir: string;
  readonly logger: Logger;
  /** Pages to index in one run, newest paths first by directory order. */
  readonly maxDocs?: number;
  /** Bytes kept per page; man pages are long, and the head answers most questions. */
  readonly maxBytesPerDoc?: number;
  readonly manDirs?: ReadonlyArray<string>;
  readonly infoDirs?: ReadonlyArray<string>;
}

export interface SysdocSummary {
  readonly discovered: number;
  readonly indexed: number;
  readonly skipped: number;
  readonly pruned: number;
  readonly failed: number;
  readonly bytes: number;
  readonly source: "man" | "info" | "both" | "none";
}

/**
 * Man and info pages this machine resolves. `MANPATH` and `INFOPATH` win when
 * set; otherwise the standard directories are scanned. A missing directory is
 * skipped, because not every system has them.
 */
export async function discoverPages(
  options: Pick<SysdocOptions, "manDirs" | "infoDirs">,
): Promise<SysdocPage[]> {
  const manDirs =
    options.manDirs ??
    splitPath(process.env.MANPATH) ??
    DEFAULT_MAN_DIRS;
  const infoDirs =
    options.infoDirs ??
    splitPath(process.env.INFOPATH) ??
    DEFAULT_INFO_DIRS;

  const pages: SysdocPage[] = [];
  for (const root of manDirs) pages.push(...(await scanMan(root)));

  // An `INFOPATH` that points at an empty tree is common (a package manager
  // sets one); the system roots are still worth reading. An explicit list from
  // config is honoured as given, so a caller can index exactly one tree.
  let infoPages: SysdocPage[] = [];
  for (const root of infoDirs) infoPages.push(...(await scanInfo(root)));
  if (infoPages.length === 0 && options.infoDirs === undefined) {
    for (const root of DEFAULT_INFO_DIRS) infoPages.push(...(await scanInfo(root)));
  }
  pages.push(...infoPages);

  return dedupePages(pages);
}

export class SysdocIndexer {
  private mapped = false;

  constructor(private readonly options: SysdocOptions) {}

  /** One full reconcile: ingest what changed, skip what did not, prune what left. */
  async run(): Promise<SysdocSummary> {
    const maxDocs = this.options.maxDocs ?? 5_000;
    const discovered = await discoverPages(this.options);
    const limited = discovered.slice(0, maxDocs);
    const manifest = await this.readManifest();
    const plan = planIngest(limited, manifest);
    if (plan.ingest.length > 0) await this.ensureMapping();

    const next: Record<string, ManifestEntry> = { ...manifest };
    let indexed = 0;
    let failed = 0;
    let bytes = 0;
    let pruned = 0;

    // Prune first: a page that vanished must not survive a failed ingest.
    if (plan.prune.length > 0) {
      for (let start = 0; start < plan.prune.length; start += BATCH_SIZE) {
        const ids = plan.prune.slice(start, start + BATCH_SIZE);
        await this.options.client.bulkDelete(this.indexName(), ids).catch((error: unknown) => {
          this.options.logger.warn("could not prune system docs", String(error));
        });
      }
      pruned = plan.prune.length;
    }

    for (const page of plan.ingest) {
      const text = await this.extract(page);
      if (text === null) {
        failed += 1;
        continue;
      }

      const document = formatSysdoc(page, text);
      const id = documentId(page);
      try {
        await this.options.client.bulk(this.indexName(), [
          {
            id,
            source: {
              path: document.path,
              abs_path: document.absPath,
              title: document.title,
              body: document.body,
              source: document.source,
              mtime: page.mtime,
            },
          },
        ]);
        next[page.path] = {
          id,
          mtime: page.mtime,
          size: page.size,
          source: page.source,
        };
        indexed += 1;
        bytes += Buffer.byteLength(document.body, "utf8");
      } catch (error) {
        failed += 1;
        this.options.logger.debug("system doc ingest failed", String(error));
      }
    }

    // Drop manifest rows whose documents were pruned or failed for good.
    for (const path of Object.keys(next)) {
      if (!discovered.some((page) => page.path === path)) delete next[path];
    }
    await this.writeManifest(next);

    const sources = new Set(limited.map((page) => page.source));
    return {
      discovered: discovered.length,
      indexed,
      skipped: plan.skipped,
      pruned,
      failed,
      bytes,
      source:
        sources.size === 0
          ? "none"
          : sources.size === 2
            ? "both"
            : (sources.values().next().value ?? "none"),
    };
  }

  private indexName(): string {
    return `${this.options.prefix}-docs`;
  }

  /**
   * `body` is plain text on purpose. These pages are thousands of long
   * documents; declaring them `semantic_text` would embed every one of them,
   * which costs hours with the local model and buys little on reference prose.
   */
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
              path: { type: "keyword" },
              abs_path: { type: "keyword" },
              source: { type: "keyword" },
              mtime: { type: "date" },
            },
          },
        },
        "could not create the system docs index",
      );
      this.mapped = true;
    } catch (error) {
      // The index survives restarts; 400/409 mean it already exists.
      if (
        !(error instanceof NodeRequestError) ||
        (error.status !== 400 && error.status !== 409)
      ) {
        this.options.logger.warn("could not create the system docs index", String(error));
      }
      this.mapped = true;
    }
  }

  /** Page text as searchable prose, or null when it cannot be decoded. */
  private async extract(page: SysdocPage): Promise<string | null> {
    const raw = await readFile(page.path).catch(() => null);
    if (raw === null) return null;

    let text: Buffer | string = raw;
    if (page.path.endsWith(".gz")) {
      try {
        text = gunzipSync(raw);
      } catch {
        return null;
      }
    } else if (!page.path.endsWith(".info") && page.source === "info") {
      // Compressed formats other than gzip are skipped rather than guessed at.
      return null;
    }

    const decoded = stripRoff(text.toString("utf8"));
    return truncate(decoded, this.options.maxBytesPerDoc ?? 65_536);
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
      // A corrupt manifest is not worth failing a run over: everything is
      // re-ingested once and the file is rewritten.
      return {};
    }
  }

  private async writeManifest(manifest: Record<string, ManifestEntry>): Promise<void> {
    await mkdir(this.options.stateDir, { recursive: true }).catch(() => {});
    await writeFile(this.manifestPath(), JSON.stringify(manifest), "utf8").catch(
      (error: unknown) => {
        this.options.logger.debug("could not write the system docs manifest", String(error));
      },
    );
  }

  private manifestPath(): string {
    return join(this.options.stateDir, MANIFEST_FILE);
  }
}

function documentId(page: SysdocPage): string {
  return createHash("sha256").update(page.path).digest("hex").slice(0, 32);
}

/** A PATH-style list, or null when the variable is unset or empty. */
function splitPath(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  const parts = value.split(":").filter((part) => part.length > 0);
  return parts.length > 0 ? parts : null;
}

async function scanMan(root: string): Promise<SysdocPage[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const pages: SysdocPage[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    if (!/^man[1-9]/.test(entry.name)) continue;

    const dir = join(root, entry.name);
    const files = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const file of files.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!file.isFile()) continue;
      const path = join(dir, file.name);
      const named = manPageName(path);
      if (named === null) continue;

      const info = await stat(path).catch(() => null);
      if (info === null) continue;
      pages.push({
        path,
        name: named.name,
        section: named.section,
        source: "man",
        mtime: info.mtimeMs,
        size: info.size,
      });
    }
  }

  return pages;
}

async function scanInfo(root: string): Promise<SysdocPage[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const pages: SysdocPage[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile()) continue;
    if (!/\.info(\.gz)?$/.test(entry.name)) continue;

    const path = join(root, entry.name);
    const info = await stat(path).catch(() => null);
    if (info === null) continue;

    pages.push({
      path,
      // `automake-1.17.info-2.gz` is a split part of one manual: the name is
      // the manual, so the parts dedupe to the first one found.
      name: entry.name.replace(/\.info(-\d+)?(\.gz)?$/, ""),
      section: "",
      source: "info",
      mtime: info.mtimeMs,
      size: info.size,
    });
  }

  return pages;
}
