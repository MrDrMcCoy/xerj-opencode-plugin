// Hidden documents: autoindex skips hidden files and directories, so text under
// `.agents`, `.github`, or any other dot-directory never reaches the project
// corpus. This scanner walks configured folders and indexes text through
// `_bulk` into `<prefix>-hidden-docs`.
//
// The index is separate from the autoindex corpus so deletions can be
// reconciled by id. It is still matched by the project prefix, so search and
// citations use the same paths relative to the project root.

import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type { Logger } from "../log.ts";
import { NodeRequestError, type XerjClient } from "../node/client.ts";
import type { DocumentRoot } from "../paths.ts";
import { isSecretPath, isTextPath } from "../remote/spool.ts";

export interface HiddenIndexOptions {
  readonly client: XerjClient;
  readonly projectRoot: string;
  readonly prefix: string;
  readonly roots: ReadonlyArray<DocumentRoot>;
  readonly maxBytes: number;
  readonly logger: Logger;
  readonly onChange?: () => void;
}

export interface HiddenSnapshot {
  readonly docs: number;
  readonly lastRunAt: number | null;
  readonly error: string | null;
}

interface HiddenFile {
  readonly id: string;
  readonly path: string;
  readonly absolute: string;
  readonly body: string;
  readonly mtime: number;
}

const SKIP_DIRS = new Set([
  ".git",
  ".xerj",
  "node_modules",
  "dist",
  "target",
  "vendor",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".next",
  ".turbo",
  ".idea",
  "secrets",
]);

const MAX_FILES = 2_000;
const MAX_INDEXED_DOCS = 5_000;
const BATCH_SIZE = 50;
const DEBOUNCE_MS = 1_500;
const FALLBACK_POLL_MS = 30_000;

export class HiddenIndex {
  readonly index: string;

  private readonly watchers: FSWatcher[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private queued = false;
  private mapped = false;
  private state: HiddenSnapshot = { docs: 0, lastRunAt: null, error: null };

  constructor(private readonly options: HiddenIndexOptions) {
    this.index = `${options.prefix}-hidden-docs`;
  }

  snapshot(): HiddenSnapshot {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.options.roots.length === 0) return;

    await this.run();
    this.watchRoots();
  }

  async stop(): Promise<void> {
    for (const watcher of this.watchers) watcher.close();
    this.watchers.length = 0;

    if (this.interval) clearInterval(this.interval);
    if (this.timer) clearTimeout(this.timer);
    this.interval = null;
    this.timer = null;
  }

  async reindex(): Promise<void> {
    await this.run();
  }

  private watchRoots(): void {
    for (const root of this.options.roots) {
      try {
        const watcher = watch(root.directory, { recursive: true }, () =>
          this.schedule(),
        );
        watcher.on("error", (error) => {
          this.options.logger.debug(
            `hidden watch failed for ${root.label}; polling instead`,
            String(error),
          );
          this.useFallback();
        });
        this.watchers.push(watcher);
      } catch (error) {
        this.options.logger.debug(
          `hidden watch unavailable for ${root.label}; polling instead`,
          String(error),
        );
        this.useFallback();
      }
    }
  }

  private useFallback(): void {
    if (this.interval) return;
    this.interval = setInterval(() => void this.run(), FALLBACK_POLL_MS);
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, DEBOUNCE_MS);
  }

  private async run(): Promise<void> {
    if (this.running) {
      this.queued = true;
      return;
    }

    this.running = true;
    try {
      await this.ensureMapping();
      const files = await this.scan();
      await this.upload(files);
      await this.removeStale(new Set(files.map((file) => file.id)));

      this.state = { docs: files.length, lastRunAt: Date.now(), error: null };
      this.options.onChange?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state = { ...this.state, lastRunAt: Date.now(), error: message };
      this.options.logger.warn("hidden document indexing failed", message);
    } finally {
      this.running = false;
      if (this.queued) {
        this.queued = false;
        void this.run();
      }
    }
  }

  private async ensureMapping(): Promise<void> {
    if (this.mapped) return;

    try {
      await this.options.client.put(
        `/${this.index}`,
        {
          mappings: {
            properties: {
              body: { type: "semantic_text" },
              title: { type: "keyword" },
              path: { type: "keyword" },
              abs_path: { type: "keyword" },
              mtime: { type: "date" },
              hidden: { type: "boolean" },
            },
          },
        },
        "could not create the hidden index",
      );
    } catch (error) {
      // The index survives restarts; 400/409 mean it already exists.
      if (
        !(error instanceof NodeRequestError) ||
        (error.status !== 400 && error.status !== 409)
      ) {
        throw error;
      }
    }

    this.mapped = true;
  }

  private async scan(): Promise<HiddenFile[]> {
    const files: HiddenFile[] = [];
    const root = resolve(this.options.projectRoot);

    for (const documentRoot of this.options.roots) {
      await this.walk(documentRoot.directory, root, files);
      if (files.length >= MAX_FILES) {
        this.options.logger.warn(
          `hidden indexing stopped at ${MAX_FILES} files; ` +
            "raise the limit only if the tree is small",
        );
        break;
      }
    }

    return files;
  }

  private async walk(
    directory: string,
    projectRoot: string,
    files: HiddenFile[],
  ): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );

    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;

      const absolute = join(directory, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await this.walk(absolute, projectRoot, files);
        continue;
      }

      if (!entry.isFile() || !isTextPath(entry.name) || isSecretPath(entry.name)) {
        continue;
      }

      const info = await stat(absolute).catch(() => null);
      if (!info || info.size === 0 || info.size > this.options.maxBytes) {
        continue;
      }

      const raw = await readFile(absolute, "utf8").catch(() => null);
      if (raw === null || raw.includes("\u0000")) continue;

      const path = relative(projectRoot, absolute).split(sep).join("/");
      files.push({
        id: createHash("sha256").update(path).digest("hex").slice(0, 24),
        path,
        absolute,
        body: raw,
        mtime: info.mtimeMs,
      });
    }
  }

  private async upload(files: ReadonlyArray<HiddenFile>): Promise<void> {
    for (let index = 0; index < files.length; index += BATCH_SIZE) {
      const batch = files.slice(index, index + BATCH_SIZE);
      await this.options.client.bulk(
        this.index,
        batch.map((file) => ({
          id: file.id,
          source: {
            body: file.body,
            title: basename(file.path),
            path: file.path,
            abs_path: file.absolute,
            mtime: new Date(file.mtime).toISOString(),
            hidden: true,
          },
        })),
      );
    }
  }

  private async removeStale(current: ReadonlySet<string>): Promise<void> {
    const existing = await this.existingIds();
    const stale = existing.filter((id) => !current.has(id));
    if (stale.length > 0) await this.options.client.bulkDelete(this.index, stale);
  }

  private async existingIds(): Promise<string[]> {
    try {
      const response = await this.options.client.search(this.index, {
        size: MAX_INDEXED_DOCS,
        _source: ["path"],
        query: { match_all: {} },
      });

      if (!isRecord(response)) return [];
      const hits = response.hits;
      if (!isRecord(hits) || !Array.isArray(hits.hits)) return [];

      return hits.hits.flatMap((hit): string[] =>
        isRecord(hit) && typeof hit._id === "string" ? [hit._id] : [],
      );
    } catch (error) {
      if (error instanceof NodeRequestError && error.status === 404) return [];
      throw error;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
