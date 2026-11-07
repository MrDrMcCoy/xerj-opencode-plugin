// Command output service: the store, the runner, and the corpus in one place,
// with a debounced ingest and the sweep that enforces the two caps.

import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";
import type { XerjClient } from "../node/client.ts";
import { CmdCorpus, type CmdHit } from "./corpus.ts";
import { runCommand } from "./runner.ts";
import { CmdStore, type CmdEntry, type CmdRead, type CmdResult } from "./store.ts";

export interface CmdServiceOptions {
  readonly config: Config["cmd"];
  /** The project's storage root (`.xerj`); the log directory is `cmd/`. */
  readonly storageRoot: string;
  /** `<project prefix>-cmd-docs`. */
  readonly indexName: string;
  readonly projectRoot: string;
  readonly getClient: () => XerjClient | null;
  readonly logger: Logger;
  readonly onBusy?: (busy: boolean) => void;
  readonly signal?: AbortSignal;
}

const INGEST_DEBOUNCE_MS = 1_500;
const SWEEP_PERIOD_MS = 60 * 60_000;

export class CmdService {
  private readonly store: CmdStore;
  private readonly options: CmdServiceOptions;
  private corpus: CmdCorpus | null = null;
  private client: XerjClient | null = null;
  private ingestTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private ingesting = false;
  private stopped = false;

  constructor(options: CmdServiceOptions) {
    this.options = options;
    this.store = new CmdStore({
      directory: join(options.storageRoot, "cmd"),
      maxBytes: options.config.maxBytes,
      maxIndexBytes: options.config.maxIndexBytes,
      maxFileBytes: options.config.maxFileBytes,
      logger: options.logger,
    });
  }

  get path(): string {
    return this.store.path;
  }

  /** A restarted node answers on a new address; the corpus follows it. */
  setClient(client: XerjClient): void {
    this.client = client;
    this.corpus = null;
  }

  get enabled(): boolean {
    return this.options.config.enabled;
  }

  async start(): Promise<void> {
    await this.store.init();
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_PERIOD_MS);
    this.sweepTimer.unref?.();
    // Files that vanished while the plugin was down must leave the index too.
    const gone = await this.store.reconcile();
    await this.prune(gone);
  }

  stop(): void {
    this.stopped = true;
    if (this.ingestTimer !== null) clearTimeout(this.ingestTimer);
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.ingestTimer = null;
    this.sweepTimer = null;
  }

  /** One foreground command, written to a pair; returns the receipt. */
  async run(
    command: string,
    options: {
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<CmdResult> {
    const result = await runCommand({
      command,
      cwd: this.options.projectRoot,
      timeoutMs: options.timeoutMs ?? this.options.config.timeoutMs,
      maxBytes: this.options.config.maxCommandBytes,
      store: this.store,
      logger: this.options.logger,
      signal: options.signal,
    });
    this.queueIngest();
    return result;
  }

  /** A host bash/shell result the plugin did not run itself. */
  async mirror(
    command: string,
    text: string,
    options: { readonly truncated: boolean },
  ): Promise<CmdEntry | null> {
    if (text.trim().length === 0) return null;
    const entry = await this.store.record(command, text, {
      source: "host",
      truncated: options.truncated,
    });
    if (entry !== null) this.queueIngest();
    return entry;
  }

  /** Copies a file the agent wrote outside the wrapper into a pair. */
  async ingest(path: string, command?: string): Promise<CmdEntry | null> {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(this.options.projectRoot, path);
    const root = resolve(this.options.projectRoot);
    if (absolute !== root && !absolute.startsWith(root + sep)) return null;
    // Read the resolved path, not the caller's string: a relative path is
    // relative to the project root here, while `readFile` would resolve it
    // against the server's working directory.
    const info = await readFile(absolute, "utf8").catch(() => null);
    if (info === null) return null;
    if (Buffer.byteLength(info, "utf8") > this.options.config.maxFileBytes) return null;

    const label = command?.trim().length ? command : `> ${relative(root, absolute)}`;
    const entry = await this.store.record(label, info, {
      source: "ingest",
      truncated: false,
    });
    if (entry !== null) this.queueIngest();
    return entry;
  }

  list(limit: number, filter?: string): CmdEntry[] {
    return this.store.list(limit, filter);
  }

  show(stem: string, start?: number, end?: number): Promise<CmdRead | null> {
    return this.store.read(stem, start, end);
  }

  entry(stem: string): CmdEntry | null {
    return this.store.get(stem);
  }

  async search(
    query: string,
    options: { readonly stem?: string; readonly k: number; readonly signal?: AbortSignal },
  ): Promise<CmdHit[]> {
    const corpus = this.corpusFor();
    if (corpus === null) return [];
    return corpus.search(query, options);
  }

  /** Indexes pending pairs and enforces both caps. */
  async reindex(): Promise<{ windows: number; files: number }> {
    const corpus = this.corpusFor();
    if (corpus === null) return { windows: 0, files: 0 };
    return corpus.run();
  }

  async sweep(): Promise<void> {
    const corpus = this.corpusFor();
    const indexBytes = corpus === null ? 0 : await corpus.indexBytes();
    const removed = await this.store.sweep(indexBytes);
    await this.prune(removed);
  }

  private async prune(entries: ReadonlyArray<CmdEntry>): Promise<void> {
    const corpus = this.corpusFor();
    if (corpus === null || entries.length === 0) return;
    await corpus.prune(entries);
  }

  private corpusFor(): CmdCorpus | null {
    if (this.corpus !== null) return this.corpus;
    const client = this.client ?? this.options.getClient();
    if (client === null) return null;
    this.corpus = new CmdCorpus({
      client,
      indexName: this.options.indexName,
      store: this.store,
      logger: this.options.logger,
      windowLines: this.options.config.windowLines,
      windowBytes: this.options.config.windowBytes,
      maxFileBytes: this.options.config.maxFileBytes,
      signal: this.options.signal,
    });
    return this.corpus;
  }

  private queueIngest(): void {
    if (this.stopped) return;
    if (this.ingestTimer !== null) clearTimeout(this.ingestTimer);
    this.ingestTimer = setTimeout(() => {
      this.ingestTimer = null;
      void this.ingestNow();
    }, INGEST_DEBOUNCE_MS);
    this.ingestTimer.unref?.();
  }

  private async ingestNow(): Promise<void> {
    if (this.stopped || this.ingesting) return;
    const corpus = this.corpusFor();
    if (corpus === null) return;

    this.ingesting = true;
    this.options.onBusy?.(true);
    try {
      await corpus.run();
      await this.sweep();
    } catch (error) {
      this.options.logger.warn("could not index command output", String(error));
    } finally {
      this.ingesting = false;
      this.options.onBusy?.(false);
    }
  }
}
