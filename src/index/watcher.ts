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

export type CorpusState = "disabled" | "starting" | "watching" | "idle" | "error";

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
  readonly dataRoot: string;
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

  constructor(private readonly options: CorpusServiceOptions) {
    this.layout = corpusLayout(options.projectRoot, options.prefix, options.dataRoot);
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
    return {
      state: this.state,
      lastRun: this.lastRun,
      restarts: this.restarts,
      runs: this.runs,
      failures: this.failures,
      lastError: this.lastError,
    };
  }

  private spawn(watch: boolean): ChildProcess | null {
    if (this.stopped || this.spawning) return null;
    this.spawning = true;

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
      this.fail(error);
      return null;
    }

    this.child = child;
    this.spawning = false;
    if (watch) this.state = "starting";

    this.attachOutput(child);
    child.once("close", (code, signal) => {
      this.child = null;
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
      if (stderr.length > 0) {
        this.options.logger.debug("autoindex stderr", stderr.join("").slice(-2000));
      }
    });
  }

  private handleWatchExit(code: number | null, signal: NodeJS.Signals | null): void {
    const meaning = exitMeaning(code);

    // A clean exit from `--watch` is unexpected; it should stay resident.
    if (meaning === "decision") {
      this.state = "idle";
      this.lastError = "autoindex needs a decision: the estimate exceeds the configured limits";
      this.options.logger.warn(this.lastError);
      this.options.onChange?.();
      return;
    }

    if (signal) {
      this.state = "idle";
      return;
    }

    this.failures += 1;
    this.lastError = `autoindex watcher exited (${code ?? "signal"})`;
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
