// Corpus service: keeps the project index current.
//
// Primary mode is `autoindex --watch --no-graph`, a resident process that gets
// one filesystem watch per indexed directory. It emits a run document per pass,
// which is where freshness and counts come from. If it keeps dying, the service
// falls back to periodic one-shot runs so the index still converges.

import { spawn, type ChildProcess } from "node:child_process";
import {
  applyCpuAffinity,
  applyPriority,
  type CpuSpec,
  type Priority,
} from "../node/priority.ts";
import { existsSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Config } from "../config.ts";
import type { KeyValueStorage, Logger } from "../log.ts";
import { isPathInside } from "../paths.ts";
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
  /** CPU and I/O priority for index processes; omitted leaves them alone. */
  readonly priority?: Priority;
  /** CPU set for index processes; null or omitted leaves affinity alone. */
  readonly cpus?: CpuSpec | null;
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
// A one-shot pass that overlaps another pass on the same state dir fails its
// flock instead, with a different message but the same meaning.
const CONTENTION_IN_USE = "already in use by another process";
const CONTENTION_RETRY_MS = 5_000;
// The journal records the node URL it was built against. After the node moves
// to another port every pass is refused until the plan is rebuilt in place.
const JOURNAL_REBIND_MARKER = "current run has";
// A watcher that survives this long is watching, even before its first run
// document lands: an initial pass over a large corpus takes minutes, and the
// status would otherwise read "starting" the whole time.
const WATCH_SETTLE_MS = 3_000;
// Project-local storage forces one-shot passes; without a recursive watcher the
// only refresh left is polling, and 15 minutes is too slow to be useful.
const LOCAL_POLL_MS = 30_000;
// One inotify watch per directory. The Linux default user limit is 8192, and
// dependency trees are already excluded, so this cap leaves room for other
// processes. A tree over the cap falls back to polling.
const MAX_LOCAL_WATCH_DIRS = 1_024;
const LOCAL_RESCAN_MS = 1_000;

// One watcher per state directory per process, whether it is the engine's
// resident `--watch` or the plugin's own directory watchers. The same plugin
// loads once for every open location, and two watchers cannot share one
// journal, so the first one owns it and the rest report that they share it.
const RESIDENT_WATCHERS = new Set<string>();

// Directories whose contents cannot change a corpus: VCS metadata, the
// project state dir, dependency trees, and build output.
const LOCAL_WATCH_SKIP = new Set([
  ".git",
  ".xerj",
  "node_modules",
  "dist",
  "build",
  "target",
  "vendor",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".next",
  ".turbo",
]);

/**
 * Lists directories worth watching under `root`, or null when the tree is too
 * large for one watch each. Hidden and generated directories are skipped for
 * the same reason the corpus skips them: their contents never reach it.
 */
/**
 * Both contention phrasings the engine emits: a resident `--watch` refused with
 * "already owns", or a one-shot flock refused with "already in use".
 */
function isContention(stderr: string): boolean {
  return stderr.includes(CONTENTION_MARKER) || stderr.includes(CONTENTION_IN_USE);
}

/** The journal belongs to another root, URL or prefix and wants `--fresh`. */
function isJournalRebind(stderr: string): boolean {
  return stderr.includes("journal at") && stderr.includes(JOURNAL_REBIND_MARKER);
}

export function listWatchableDirectories(
  root: string,
  max = MAX_LOCAL_WATCH_DIRS,
): string[] | null {
  const dirs: string[] = [];
  const pending = [root];

  while (pending.length > 0) {
    const dir = pending.pop()!;
    dirs.push(dir);
    if (dirs.length > max) return null;

    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".") || LOCAL_WATCH_SKIP.has(entry.name)) continue;
        pending.push(join(dir, entry.name));
      }
    } catch {
      // An unreadable directory cannot contribute files either.
    }
  }

  return dirs;
}

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
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly watchers = new Map<string, FSWatcher>();
  private rescanTimer: ReturnType<typeof setTimeout> | null = null;
  private localWatch = false;
  // Set once by a refused pass; the next spawn adds `--fresh` and clears it.
  private freshNext = false;
  private lastSpawnFresh = false;
  private ownsLocalWatch = false;
  private polling = false;
  private onceRunning = false;
  private pendingRun = false;
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

    // `--watch` refuses a state dir inside the watched tree, and the default
    // storage root is `<project>/.xerj`. In that layout the plugin watches the
    // tree itself and runs one-shot passes, which keeps all project data in
    // the project without feeding journal writes back into the next pass.
    const stateInsideProject =
      isPathInside(this.options.projectRoot, this.options.stateRoot) ||
      isPathInside(this.options.projectRoot, this.layout.stateDir);

    // Graph mode cannot use the engine's resident watcher, so a graph project
    // always refreshes through the plugin's own directory watcher. That is the
    // same route a state dir inside the project already takes.
    const graphMode = this.options.config.index.graph;

    if (this.options.config.index.watch && !stateInsideProject && !graphMode) {
      this.spawn(true);
      return;
    }

    // Watch before the first pass, not after: a full index can take minutes,
    // and an edit that lands behind the scan would otherwise wait for the
    // periodic fallback. Only one instance may own the watcher; the rest poll
    // for ownership so they can take over when the owner stops.
    if (this.options.config.index.watch) {
      if (!this.claimLocalWatch()) {
        this.state = "shared";
        this.startPeriodic();
        return;
      }
      this.startLocalWatch();
    }
    await this.runOnce();
    this.startPeriodic();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    this.closeLocalWatch();
    await this.stopChild();
    this.state = "idle";
  }

  /** Forces a pass by restarting the watcher, or running once in periodic mode. */
  async reindex(): Promise<void> {
    if (this.state === "disabled" || this.stopped) return;

    this.restarts = 0;
    this.lastError = null;

    if (
      !this.options.config.index.watch ||
      this.localWatch ||
      this.polling ||
      this.state === "shared"
    ) {
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

    const fresh = this.freshNext;
    this.freshNext = false;
    this.lastSpawnFresh = fresh;
    const args = autoindexArgs({
      layout: this.layout,
      nodeUrl: this.options.nodeUrl,
      config: this.options.config,
      watch,
      fresh,
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
      if (watch) RESIDENT_WATCHERS.delete(watcherKey);
      this.fail(error);
      return null;
    }

    this.child = child;
    this.spawning = false;
    this.lastStderr = "";
    this.spawnedAt = Date.now();
    if (watch) this.state = "starting";

    // Indexing is background work: keep it below the editor's own processes.
    if (this.options.priority !== undefined) {
      void applyPriority({
        pid: child.pid,
        priority: this.options.priority,
        logger: this.options.logger,
      });
    }
    if (this.options.cpus !== null && this.options.cpus !== undefined) {
      void applyCpuAffinity({
        pid: child.pid,
        spec: this.options.cpus,
        logger: this.options.logger,
      });
    }

    this.attachOutput(child);
    child.once("close", (code, signal) => {
      this.child = null;
      // A one-shot run must not release the local watcher's ownership: it
      // shares the same key but did not claim it.
      if (watch) RESIDENT_WATCHERS.delete(watcherKey);
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
    if (isContention(this.lastStderr)) {
      this.state = "starting";
      this.lastError = null;
      this.options.logger.debug("autoindex watcher journal is owned elsewhere; retrying");
      this.options.onChange?.();
      setTimeout(() => this.spawn(true), CONTENTION_RETRY_MS);
      return;
    }

    if (this.rebindJournal()) {
      this.state = "starting";
      this.spawn(true);
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

  /**
   * Arms a `--fresh` pass when the engine refused the journal because it was
   * built against another node URL (the node moved ports). Once per refusal:
   * a pass that is refused even with `--fresh` is a real failure.
   */
  private rebindJournal(): boolean {
    if (!isJournalRebind(this.lastStderr) || this.lastSpawnFresh) return false;
    this.freshNext = true;
    this.lastError = null;
    this.options.logger.info("autoindex journal is bound to another node; rebuilding the plan");
    return true;
  }

  private handleOnceExit(code: number | null): void {
    const meaning = exitMeaning(code);
    if (meaning === "ok" || meaning === "junk") {
      // The engine replays the previous run document when a pass finds nothing
      // to do, so its `started` timestamp can be far in the past. Freshness
      // means "when did we last scan", so stamp the pass completion time.
      if (this.lastRun) {
        this.lastRun = { ...this.lastRun, at: Date.now() };
        void this.persist(this.lastRun);
      }
      this.state = this.options.config.index.watch ? "watching" : "idle";
      this.options.onChange?.();
      return;
    }

    // A concurrent pass holds the state-dir flock. That resolves on its own,
    // so retry quietly instead of counting a failure or raising an error.
    if (isContention(this.lastStderr)) {
      this.options.logger.debug("autoindex state is busy; retrying");
      setTimeout(() => void this.runOnce(), CONTENTION_RETRY_MS);
      return;
    }

    if (this.rebindJournal()) {
      this.pendingRun = true;
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

    // Filesystem events arrive in bursts. Keep at most one pass running and
    // one queued, so a large edit does not start a dozen autoindex processes.
    if (this.onceRunning) {
      this.pendingRun = true;
      return;
    }

    this.onceRunning = true;
    const sharedBeforePass = this.state === "shared";
    if (this.state !== "watching") this.state = "starting";
    const child = this.spawn(false);
    if (child) {
      await new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));
    }
    this.onceRunning = false;
    // The close event ran `handleOnceExit`, which may have set an error.
    if (this.lastRun && this.lastError === null) {
      // A shared instance keeps its marker so the takeover loop keeps running.
      if (!(sharedBeforePass && !this.localWatch)) {
        this.state = this.options.config.index.watch ? "watching" : "idle";
      }
    }

    if (this.pendingRun && !this.stopped) {
      this.pendingRun = false;
      void this.runOnce();
    }
  }

  private startPeriodic(): void {
    this.clearTimer();
    // A shared instance retries ownership often enough to take over; a polling
    // fallback needs the same short period to notice changes.
    const local = this.polling || this.state === "shared";
    const period = local ? LOCAL_POLL_MS : this.options.config.index.periodicMs;
    this.timer = setInterval(() => this.tick(), period);
  }

  private tick(): void {
    if (this.stopped) return;

    if (this.state === "shared" && this.options.config.index.watch) {
      if (!this.claimLocalWatch()) return;
      this.startLocalWatch();
      this.startPeriodic();
      void this.runOnce();
      return;
    }

    void this.runOnce();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * Watches the project when the engine's own `--watch` cannot be used.
   *
   * `fs.watch(root, {recursive:true})` is a no-op on Linux, so this watches
   * every directory instead. A new directory is picked up by its parent's
   * watcher and added on the next rescan.
   */
  private claimLocalWatch(): boolean {
    const key = this.layout.stateDir;
    if (RESIDENT_WATCHERS.has(key)) return false;
    RESIDENT_WATCHERS.add(key);
    this.ownsLocalWatch = true;
    return true;
  }

  private startLocalWatch(): void {
    const dirs = listWatchableDirectories(this.options.projectRoot);
    if (dirs === null) {
      this.options.logger.warn(
        `project has more than ${MAX_LOCAL_WATCH_DIRS} directories; polling instead`,
      );
      this.useFallback();
      return;
    }

    for (const dir of dirs) this.addDirectoryWatch(dir);
    this.localWatch = true;
    this.polling = false;
    this.state = this.lastRun ? "watching" : "starting";
    this.options.onChange?.();
  }

  private addDirectoryWatch(dir: string): void {
    if (this.watchers.has(dir) || this.stopped) return;
    try {
      const watcher = watch(dir, { persistent: false }, (_event, file) => {
        if (file === null || !this.shouldIgnoreLocal(join(dir, String(file)))) {
          this.scheduleRun();
          this.scheduleRescan();
        }
      });
      watcher.on("error", () => {
        watcher.close();
        this.watchers.delete(dir);
        if (this.watchers.size === 0) this.useFallback();
      });
      this.watchers.set(dir, watcher);
    } catch (error) {
      this.options.logger.warn("local corpus watch unavailable; polling instead", String(error));
      this.useFallback();
    }
  }

  /** Adds watchers for directories created since the last scan. */
  private scheduleRescan(): void {
    if (this.rescanTimer || this.stopped) return;
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      if (!this.localWatch) return;
      const dirs = listWatchableDirectories(this.options.projectRoot);
      if (dirs === null) return;
      const live = new Set(dirs);
      for (const [dir, watcher] of this.watchers) {
        if (live.has(dir) && existsSync(dir)) continue;
        watcher.close();
        this.watchers.delete(dir);
      }
      for (const dir of dirs) this.addDirectoryWatch(dir);
    }, LOCAL_RESCAN_MS);
  }

  private shouldIgnoreLocal(file: string): boolean {
    const absolute = resolve(this.options.projectRoot, file);
    if (!isPathInside(this.options.projectRoot, absolute)) return true;
    if (isPathInside(this.options.stateRoot, absolute)) return true;
    if (isPathInside(this.layout.stateDir, absolute)) return true;

    return relative(this.options.projectRoot, absolute)
      .split(sep)
      .some((segment) => LOCAL_WATCH_SKIP.has(segment) || segment.startsWith("."));
  }

  private scheduleRun(): void {
    if (this.stopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const delay = Math.max(200, this.options.config.index.debounceMs);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.runOnce();
    }, delay);
  }

  private useFallback(): void {
    this.closeLocalWatch();
    this.localWatch = false;
    // A 30 s one-shot pass replaces the events we cannot receive.
    this.polling = true;
    this.state = "idle";
    if (this.timer) this.startPeriodic();
    this.options.onChange?.();
  }

  private closeLocalWatch(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    if (this.ownsLocalWatch) {
      RESIDENT_WATCHERS.delete(this.layout.stateDir);
      this.ownsLocalWatch = false;
    }
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
      this.rescanTimer = null;
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
