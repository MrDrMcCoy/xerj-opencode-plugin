// Corpus service: keeps the project index current.
//
// Primary mode is `autoindex --watch --no-graph`, a resident process that gets
// one filesystem watch per indexed directory. It emits a run document per pass,
// which is where freshness and counts come from. If it keeps dying, the service
// falls back to periodic one-shot runs so the index still converges.

import { spawn, type ChildProcess } from "node:child_process";
import type { Config } from "../config.ts";
import type { KeyValueStorage, Logger } from "../log.ts";
import {
  autoindexArgs,
  corpusLayout,
  ensureIgnoreFile,
  exitMeaning,
  parseRunDocument,
  type CorpusRun,
  type CorpusLayout,
} from "./corpus.ts";

export type CorpusState =
  | "disabled"
  | "starting"
  | "watching"
  | "shared"
  | "idle"
  | "error";

export interface CorpusSnapshot {
  readonly state: CorpusState;
  readonly lastRun: CorpusRun | null;
  readonly restarts: number;
  readonly runs: number;
  readonly failures: number;
  readonly lastError: string | null;
}

export interface CorpusServiceOptions {
  readonly binaryPath: string;
  readonly nodeUrl: string;
  readonly projectRoot: string;
  readonly prefix: string;
  /** Directory holding the engine data; the journal lives under it. */
  readonly stateRoot: string;
  readonly config: Config;
  readonly storage: KeyValueStorage;
  readonly logger: Logger;
  readonly onChange?: () => void;
  readonly onRun?: (run: CorpusRun) => void;
}

const STORAGE_KEY = "index/lastRun";
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000] as const;
const MAX_RESTARTS = 5;
const STOP_GRACE_MS = 3_000;
const STDERR_TAIL_LINES = 20;
// The engine refuses a second watcher for the same journal and says so.
const CONTENTION_MARKER = "already owns";
const CONTENTION_RETRY_MS = 5_000;
// A watcher that survives this long is watching, even before its first run
// document lands: an initial pass over a large corpus takes minutes, and the
// status would otherwise read "starting" the whole time.
const WATCH_SETTLE_MS = 3_000;

// One watcher per state directory per process. The same plugin loads once for
// every open location, and two `--watch` processes cannot share one journal,
// so the first one owns it and the rest report that they share it.
const RESIDENT_WATCHERS = new Set<string>();

export class CorpusService {
  readonly layout: CorpusLayout;

  private readonly storageKey: string;
  private state: CorpusState;
  private lastRun: CorpusRun | null = null;
  private restarts = 0;
  private runs = 0;
  private failures = 0;
  private lastError: string | null = null;
  private child: ChildProcess | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private spawning = false;
  private lastStderr = "";
  private spawnedAt = 0;

  constructor(private readonly options: CorpusServiceOptions) {
    this.layout = corpusLayout(
      options.projectRoot,
      options.prefix,
      options.stateRoot,
    );
    this.storageKey = `${STORAGE_KEY}:${options.prefix}`;
    this.state = options.config.index.auto ? "starting" : "disabled";
  }

  async start(): Promise<void> {
    if (this.state === "disabled") return;

    await this.restore();
    await ensureIgnoreFile(this.layout).catch(() => {});

    if (this.options.config.index.watch) {
      this.spawn(true);
    } else {
      await this.runOnce();
      this.startPeriodic();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    const child = this.child;
    this.child = null;
    if (!child) return;

    child.kill("SIGTERM");
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolvePromise();
      }, STOP_GRACE_MS);
      child.once("close", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });

    this.state = "idle";
  }

  /** Forces a pass by restarting the watcher, or running once in periodic mode. */
  async reindex(): Promise<void> {
    if (this.state === "disabled" || this.stopped) return;

    this.restarts = 0;
    this.lastError = null;

    if (!this.options.config.index.watch) {
      await this.runOnce();
      return;
    }

    if (this.child) {
      await this.stopChild();
    }
    this.spawn(true);
  }

  snapshot(): CorpusSnapshot {
    const settled =
      this.state === "starting" &&
      this.child !== null &&
      Date.now() - this.spawnedAt >= WATCH_SETTLE_MS;

    return {
      state: settled ? "watching" : this.state,
      lastRun: this.lastRun,
      restarts: this.restarts,
      runs: this.runs,
      failures: this.failures,
      lastError: this.lastError,
    };
  }

  private spawn(watch: boolean): ChildProcess | null {
    if (this.stopped || this.spawning) return null;

    const watcherKey = this.layout.stateDir;
    if (watch && RESIDENT_WATCHERS.has(watcherKey)) {
      this.state = "shared";
      this.lastError = null;
      this.options.logger.debug(
        "watching through the resident autoindex",
        watcherKey,
      );
      this.options.onChange?.();
      return null;
    }

    this.spawning = true;
    if (watch) RESIDENT_WATCHERS.add(watcherKey);

    const args = autoindexArgs({
      layout: this.layout,
      nodeUrl: this.options.nodeUrl,
      config: this.options.config,
      watch,
    });

    let child: ChildProcess;
    try {
      child = spawn(this.options.binaryPath, [...args], {
        cwd: this.options.projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, XERJ_DISABLE_FEEDBACK: "true" },
      });
    } catch (error) {
      this.spawning = false;
      RESIDENT_WATCHERS.delete(watcherKey);
      this.fail(error);
      return null;
    }

    this.child = child;
    this.spawning = false;
    this.lastStderr = "";
    this.spawnedAt = Date.now();
    if (watch) this.state = "starting";

    this.attachOutput(child);
    child.once("close", (code, signal) => {
      this.child = null;
      RESIDENT_WATCHERS.delete(watcherKey);
      if (this.stopped) return;

      if (watch) {
        this.handleWatchExit(code, signal);
      } else {
        this.handleOnceExit(code ?? null);
      }
    });

    return child;
  }

  private attachOutput(child: ChildProcess): void {
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const run = parseRunDocument(line);
        if (!run) continue;
        this.lastRun = run;
        this.runs += 1;
        this.restarts = 0;
        this.options.onRun?.(run);
        this.state = "watching";
        void this.persist(run);
        this.options.onChange?.();
      }
    });

    const stderr: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk.toString());
      if (stderr.length > STDERR_TAIL_LINES) stderr.shift();
    });

    child.once("close", () => {
      this.lastStderr = stderr.join("").slice(-2000);
      if (stderr.length > 0) {
        this.options.logger.debug("autoindex stderr", this.lastStderr);
      }
    });
  }

  private handleWatchExit(code: number | null, signal: NodeJS.Signals | null): void {
    const meaning = exitMeaning(code);

    // Our own stop() kills the child; that exit is not a crash.
    if (this.stopped) {
      this.state = "idle";
      return;
    }

    // Another process owns this journal, typically the plugin instance of a
    // server that is being replaced. Ownership frees when that process exits,
    // so wait it out instead of counting a failure or burning the restart
    // budget.
    if (this.lastStderr.includes(CONTENTION_MARKER)) {
      this.state = "starting";
      this.lastError = null;
      this.options.logger.debug("autoindex watcher journal is owned elsewhere; retrying");
      this.options.onChange?.();
      setTimeout(() => this.spawn(true), CONTENTION_RETRY_MS);
      return;
    }

    // A clean exit from `--watch` is unexpected; it should stay resident.
    if (meaning === "decision") {
      this.state = "idle";
      this.lastError = "autoindex needs a decision: the estimate exceeds the configured limits";
      this.options.logger.warn(this.lastError);
      this.options.onChange?.();
      return;
    }

    this.failures += 1;
    this.lastError = `autoindex watcher exited (${code ?? signal ?? "signal"})`;
    this.options.logger.warn(this.lastError);

    if (this.restarts >= MAX_RESTARTS) {
      this.options.logger.warn("falling back to periodic indexing");
      this.startPeriodic();
      void this.runOnce();
      return;
    }

    const delay = BACKOFF_MS[Math.min(this.restarts, BACKOFF_MS.length - 1)] ?? 30_000;
    this.restarts += 1;
    this.state = "starting";
    this.options.onChange?.();
    setTimeout(() => this.spawn(true), delay);
  }

  private handleOnceExit(code: number | null): void {
    const meaning = exitMeaning(code);
    if (meaning === "ok" || meaning === "junk") {
      this.state = "idle";
      return;
    }

    this.failures += 1;
    this.state = "error";
    this.lastError =
      meaning === "decision"
        ? "autoindex needs a decision: the estimate exceeds the configured limits"
        : `autoindex exited ${code ?? "signal"}`;
    this.options.logger.warn(this.lastError);
    this.options.onChange?.();
  }

  private async runOnce(): Promise<void> {
    if (this.stopped) return;
    const child = this.spawn(false);
    if (!child) return;

    await new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));
    if (this.lastRun) this.state = "idle";
  }

  private startPeriodic(): void {
    this.clearTimer();
    const period = this.options.config.index.periodicMs;
    this.timer = setInterval(() => void this.runOnce(), period);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;

    child.kill("SIGTERM");
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolvePromise();
      }, STOP_GRACE_MS);
      child.once("close", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }

  private async restore(): Promise<void> {
    const stored = await this.options.storage.get(this.storageKey).catch(() => undefined);
    if (typeof stored !== "object" || stored === null) return;

    const record = stored as Record<string, unknown>;
    if (typeof record.at !== "number") return;

    this.lastRun = {
      at: record.at,
      generation: typeof record.generation === "number" ? record.generation : null,
      files: typeof record.files === "number" ? record.files : null,
      records: typeof record.records === "number" ? record.records : null,
      junk: typeof record.junk === "number" ? record.junk : null,
      reason: typeof record.reason === "string" ? record.reason : null,
    };
  }

  private async persist(run: CorpusRun): Promise<void> {
    await this.options.storage.set(this.storageKey, run as never).catch(() => {});
  }

  private fail(error: unknown): void {
    this.failures += 1;
    this.state = "error";
    this.lastError = error instanceof Error ? error.message : String(error);
    this.options.logger.error("could not start autoindex", this.lastError);
    this.options.onChange?.();
  }
}
