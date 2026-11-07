// The local telemetry store: append-only NDJSON under the XERJ data root.
//
// Nothing here opens a socket or sends anything anywhere. Records go into an
// in-memory queue that a timer drains, so no span ever waits on a write; a
// full queue drops the oldest record instead of delaying a turn. Appends are
// atomic under O_APPEND, and only the lock owner rewrites a file (rings) or
// prunes the store.

import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../log.ts";
import { redactClip } from "../redact.ts";
import {
  isOpType,
  ZERO_DWELL,
  type BootMarker,
  type JobView,
  type OpMeta,
  type OpRecord,
  type OpType,
  type SampleRecord,
  type ServiceState,
  type StateDwell,
  type UiRecord,
} from "./types.ts";

export interface TelemetryStoreOptions {
  /** `<data root>/telemetry`. */
  readonly directory: string;
  /** Project prefix, so one installation can be read per project. */
  readonly prefix: string;
  /** Stable per process; keys the boot marker and the rollup file. */
  readonly instance: string;
  readonly enabled: boolean;
  readonly maxBytes: number;
  readonly samplesPerType: number;
  readonly rotateBytes: number;
  readonly rotations: number;
  readonly flushMs: number;
  /** Characters of caller text kept in `meta`; 0 records none. */
  readonly maxText: number;
  readonly logger: Logger;
  /** Milliseconds since the process booted; the report's `session` window. */
  readonly bootMs: () => number;
}

export type ReportWindow = "session" | "day" | "all";
export type ReportSort = "count" | "p95" | "total" | "errors";

export interface ReportQuery {
  readonly op?: string;
  readonly window?: ReportWindow;
  readonly sort?: ReportSort;
  readonly limit?: number;
}

export interface OpSummary {
  readonly op: string;
  readonly count: number;
  readonly errors: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly totalMs: number;
  readonly idleP50: number;
  readonly busyP50: number;
}

export interface BootSummary {
  readonly at: number;
  readonly bootId: string;
  readonly bootMs: number;
  readonly readyMs: number | null;
  readonly indexedMs: number | null;
  readonly crashed: boolean;
}

export interface ProcessSummary {
  readonly cpuPct: number | null;
  readonly rssBytes: number | null;
  readonly peakRssBytes: number;
  readonly rssP50: number;
  readonly rssP95: number;
  readonly cpuBusy: number | null;
  readonly cpuReady: number | null;
  /** Resident-set change over the window, in MB per day. */
  readonly growthMbPerDay: number;
}

export interface TelemetryReport {
  readonly rows: ReadonlyArray<OpSummary>;
  readonly starts: ReadonlyArray<BootSummary>;
  readonly crashes: number;
  readonly restarts: number;
  readonly states: StateDwell;
  readonly process: ProcessSummary | null;
  readonly storeBytes: number;
  /** Date of the oldest record still on disk, or null when empty. */
  readonly historyStart: string | null;
}

/** What `xerj_telemetry` and the panel read; empty when telemetry is off. */
export const EMPTY_REPORT: TelemetryReport = {
  rows: [],
  starts: [],
  crashes: 0,
  restarts: 0,
  states: ZERO_DWELL,
  process: null,
  storeBytes: 0,
  historyStart: null,
};

const QUEUE_LIMIT = 5_000;
const UI_LEVELS = new Set(["debug", "info", "warn", "error"]);
const UI_MESSAGE_CHARS = 200;
const UI_DETAIL_CHARS = 1_500;
/** The UI ring's file name under `rings/`. */
export const UI_RING = "ui.sidebar";
const SWEEP_INTERVAL_MS = 10 * 60_000;
const SIZE_CACHE_MS = 60_000;
const STALE_LOCK_MS = 60_000;
/** Below this, a growth rate would be an extrapolation, not a measurement. */
const MIN_GROWTH_SPAN_MS = 60 * 60_000;
const MARKER_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const README = `XERJ telemetry

Every file here is local to this machine. Nothing in this store is sent
anywhere: the plugin has no network path for it, and setting
telemetry.enabled to false removes this directory on the next start.

ops.ndjson       every operation, chronological; rotates
ops.N.ndjson     older rotations, 1 is the newest
rings/           the last samples of one operation type
samples/         CPU and RSS of each XERJ process, one file per day
rollup/          per-day counters per plugin instance
state/           this process's boot marker
writer.lock      which instance may rewrite a file
`;

export class TelemetryStore {
  readonly enabled: boolean;

  private readonly queue: OpRecord[] = [];
  private readonly samples: SampleRecord[] = [];
  private readonly ui: UiRecord[] = [];
  private readonly ringQueue = new Map<string, OpRecord[]>();
  private readonly cache = new Map<string, { at: number; bytes: number }>();
  private rollup: RollupDelta = emptyRollup();
  private rollupDate = dayKey(Date.now());
  /** Cumulative today, so the panel reads the day and not one flush window. */
  private dayDwell: StateDwell = ZERO_DWELL;
  /** The state the service is in now; its interval is not closed yet. */
  private currentState: ServiceState = "starting";
  private opsBytes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private lastSweep = 0;
  private owner = false;
  private lockedAt = 0;
  private broken = false;
  private disabledReason: string | null = null;
  private drain: Promise<void> = Promise.resolve();
  private loadProvider: () => number = () => 0;
  private lastTransitionAt: number | null = null;
  /** Latest job list, for the `diagnose` snapshot. */
  private jobsProvider: () => ReadonlyArray<JobView> = () => [];

  private readonly startedAt = Date.now();

  constructor(private readonly options: TelemetryStoreOptions) {
    this.enabled = options.enabled;
  }

  get directory(): string {
    return this.options.directory;
  }

  private get opsPath(): string {
    return join(this.options.directory, "ops.ndjson");
  }

  private get markerPath(): string {
    return join(
      this.options.directory,
      "state",
      `boot-${this.options.instance}.json`,
    );
  }

  get disabled(): string | null {
    return this.disabledReason;
  }

  /** Jobs count at the start of each operation, so idle and busy split. */
  setLoadProvider(read: () => number): void {
    this.loadProvider = read;
  }

  setJobsProvider(read: () => ReadonlyArray<JobView>): void {
    this.jobsProvider = read;
  }

  jobs(): ReadonlyArray<JobView> {
    return this.jobsProvider();
  }

  async init(): Promise<void> {
    if (!this.enabled || this.broken) return;

    try {
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      const directory = this.options.directory;
      for (const name of ["rings", "samples", "rollup", "state"]) {
        await mkdir(join(directory, name), { recursive: true, mode: 0o700 });
      }
      await writeFile(join(directory, "README.txt"), README, { flag: "wx" })
        .catch(() => {});
      this.opsBytes = await fileSize(this.opsPath);
      this.owner = await this.claimWriter();
      this.timer = setInterval(() => void this.flush(), this.options.flushMs);
      this.timer.unref?.();
      this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
      this.sweepTimer.unref?.();
      void this.sweep();
    } catch (error) {
      this.fail("could not open the telemetry store", error);
    }
  }

  /**
   * Measures one operation. The body runs whether or not telemetry is on, and
   * a thrown error is recorded and rethrown unchanged.
   */
  async span<T>(
    op: OpType,
    body: () => Promise<T>,
    meta?: (result: T) => unknown,
  ): Promise<T> {
    const started = performance.now();
    try {
      const result = await body();
      this.record(op, performance.now() - started, true, meta?.(result));
      return result;
    } catch (error) {
      this.record(op, performance.now() - started, false, undefined, error);
      throw error;
    }
  }

  /** A completed operation; the only entry point into the queue. */
  record(
    op: OpType,
    ms: number,
    ok: boolean,
    meta?: unknown,
    error?: unknown,
  ): void {
    if (!this.enabled || this.broken || !isOpType(op)) return;

    const record: OpRecord = {
      at: Date.now(),
      op,
      // A negative or absurd duration is a clock artefact, not a measurement.
      ms: Number.isFinite(ms) ? Math.max(0, Math.min(ms, 86_400_000)) : 0,
      ok,
      load: this.loadProvider(),
      prefix: this.options.prefix,
      ...(this.metaFor(meta, error) ?? {}),
    };
    this.push(record);
  }

  /**
   * One line the UI half reported. It is not an operation: there is no
   * duration and no outcome, so it stays out of ops.ndjson and the rollup and
   * lands in its own ring. Text is clipped and redacted like every other
   * caller-supplied string.
   */
  noteUi(record: {
    readonly level?: unknown;
    readonly message?: unknown;
    readonly detail?: unknown;
  }): void {
    if (!this.enabled || this.broken) return;

    const level = UI_LEVELS.has(record.level as string)
      ? (record.level as UiRecord["level"])
      : "info";
    const message = redactClip(String(record.message ?? ""), UI_MESSAGE_CHARS).trim();
    if (message.length === 0) return;
    const detail =
      record.detail === undefined || record.detail === null
        ? undefined
        : redactClip(String(record.detail), UI_DETAIL_CHARS).trim();

    this.ui.push({
      at: Date.now(),
      level,
      message,
      prefix: this.options.prefix,
      instance: this.options.instance,
      ...(detail === undefined || detail.length === 0 ? {} : { detail }),
    });
    if (this.ui.length > QUEUE_LIMIT) this.ui.shift();
  }

  /** One CPU and RSS sample; the sampler owns the cadence. */
  sample(record: SampleRecord): void {
    if (!this.enabled || this.broken) return;
    this.samples.push({ prefix: this.options.prefix, ...record });
    if (this.samples.length > QUEUE_LIMIT) this.samples.shift();
  }

  /** One service-state transition; dwell time is summed from it. */
  noteState(
    from: ServiceState,
    to: ServiceState,
    at: number,
    detail: string | null = null,
  ): void {
    if (!this.enabled || this.broken || from === to) return;

    const dwell = this.todayDwell();
    const elapsed = Math.max(0, at - (this.lastTransitionAt ?? at));
    this.lastTransitionAt = at;
    this.currentState = to;
    this.dayDwell = addDwell(this.dayDwell, from, elapsed);
    this.rollup.states = addDwell(dwell, from, elapsed);
    this.record("lifecycle.state", 0, true, {
      from,
      to,
      reason: from === "starting" ? "startup" : "status",
      ...(detail === null ? {} : { detail }),
    });
  }

  /** Milliseconds spent in the given state today, as this process saw it. */
  dwellFor(state: ServiceState): number {
    return dwellValue(this.dayDwell, state) + this.pendingDwell(state);
  }

  /** The open interval of the current state, which no transition closed yet. */
  private pendingDwell(state: ServiceState): number {
    if (state !== this.currentState || this.lastTransitionAt === null) return 0;
    return Math.max(0, Date.now() - this.lastTransitionAt);
  }

  async flush(): Promise<void> {
    if (!this.enabled || this.broken) return;
    if (this.queue.length === 0 && this.samples.length === 0 && this.ui.length === 0) {
      if (Date.now() - this.lastSweep > SWEEP_INTERVAL_MS) await this.sweep();
      return;
    }

    // One drain at a time: a slow disk must not interleave two rotations.
    this.drain = this.drain
      .then(() => this.drainQueues())
      .catch((error: unknown) => this.fail("could not write telemetry", error));
    await this.drain;
  }

  async close(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.timer = null;
    this.sweepTimer = null;
    await this.flush().catch(() => {});
    await this.releaseWriter();
  }

  // -- boot markers ---------------------------------------------------------

  async writeMarker(phase: string): Promise<void> {
    if (!this.enabled || this.broken) return;
    const marker: BootMarker = {
      bootId: this.options.instance,
      pid: process.pid,
      prefix: this.options.prefix,
      at: this.startedAt,
      phase,
    };
    await writeFile(this.markerPath, JSON.stringify(marker), { mode: 0o600 })
      .catch(() => {});
  }

  async clearMarker(): Promise<void> {
    await rm(this.markerPath, { force: true }).catch(() => {});
  }

  /**
   * Removes this project's markers whose process is gone and returns the
   * newest one. A marker whose pid is alive belongs to another instance and is
   * left alone; another project's dead marker is removed without a report.
   */
  async takeCrashedBoot(): Promise<BootMarker | null> {
    const directory = join(this.options.directory, "state");
    const names = await readdir(directory).catch(() => [] as string[]);
    let crashed: BootMarker | null = null;

    for (const name of names) {
      if (!name.startsWith("boot-") || !name.endsWith(".json")) continue;
      const path = join(directory, name);
      const marker = await readMarker(path);
      if (marker === null) {
        await rm(path, { force: true }).catch(() => {});
        continue;
      }
      if (marker.pid === process.pid) continue;

      const stale = Date.now() - marker.at > MARKER_MAX_AGE_MS;
      if (isAlive(marker.pid) && !stale) continue;

      await rm(path, { force: true }).catch(() => {});
      if (marker.prefix !== this.options.prefix) continue;
      if (crashed === null || marker.at > crashed.at) crashed = marker;
    }

    return crashed;
  }

  // -- report ---------------------------------------------------------------

  async report(query: ReportQuery = {}): Promise<TelemetryReport> {
    if (!this.enabled) return EMPTY_REPORT;

    const since = this.windowStart(query.window ?? "day");
    const records: OpRecord[] = [];
    for (const path of await this.opsFiles()) {
      const text = await readFile(path, "utf8").catch(() => "");
      for (const line of text.split("\n")) {
        const record = parseOp(line);
        if (record === null || record.at < since) continue;
        if (!this.matchesPrefix(record, query.op)) continue;
        records.push(record);
      }
    }

    const rows = summarize(records, query.sort ?? "count").slice(
      0,
      Math.max(1, query.limit ?? 20),
    );
    const boots = await this.boots();
    const crashes = records.filter(
      (row) => row.op === "lifecycle.crash",
    ).length;
    const restarts = records.filter(
      (row) => row.op === "lifecycle.restart",
    ).length;

    return {
      rows,
      starts: boots,
      crashes,
      restarts,
      states: await this.dwellForWindow(since),
      process: await this.processSummary(since),
      storeBytes: await this.storeBytes(),
      historyStart: await this.historyStart(),
    };
  }

  // -- writing --------------------------------------------------------------

  private push(record: OpRecord): void {
    if (this.queue.length >= QUEUE_LIMIT) this.queue.shift();
    this.queue.push(record);

    const ring = this.ringQueue.get(record.op);
    if (ring === undefined) this.ringQueue.set(record.op, [record]);
    else ring.push(record);

    const day = dayKey(record.at);
    if (day !== this.rollupDate) {
      // A day boundary inside a queued burst: the finished day is written by
      // the next flush, and the new day starts at zero.
      this.rollupDate = day;
      this.rollup = emptyRollup();
    }
    this.bumpRollup(record);
  }

  private bumpRollup(record: OpRecord): void {
    const ops = this.rollup.ops;
    const entry =
      ops[record.op] ?? { count: 0, errors: 0, totalMs: 0, maxMs: 0 };
    ops[record.op] = {
      count: entry.count + 1,
      errors: entry.errors + (record.ok ? 0 : 1),
      totalMs: entry.totalMs + record.ms,
      maxMs: Math.max(entry.maxMs, record.ms),
    };
  }

  private async drainQueues(): Promise<void> {
    const records = this.queue.splice(0, this.queue.length);
    const samples = this.samples.splice(0, this.samples.length);
    const ui = this.ui.splice(0, this.ui.length);
    const rings = new Map(this.ringQueue);
    this.ringQueue.clear();
    const rollup = this.rollup;
    const date = this.rollupDate;
    this.rollup = emptyRollup();

    if (records.length > 0) {
      const text = records
        .map((record) => `${JSON.stringify(record)}\n`)
        .join("");
      await this.appendOps(text);
      await this.writeRollup(date, rollup);
    }

    for (const [op, entries] of rings) {
      await this.writeRing(op, entries);
    }

    if (ui.length > 0) {
      await this.writeRingLines(
        UI_RING,
        ui.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
      );
    }

    if (samples.length > 0 && this.owner) {
      const path = join(
        this.options.directory,
        "samples",
        `${dayKey(Date.now())}.ndjson`,
      );
      const text = samples
        .map((sample) => `${JSON.stringify(sample)}\n`)
        .join("");
      await appendFile(path, text, { mode: 0o600 }).catch((error: unknown) => {
        this.fail("could not write telemetry samples", error);
      });
    }
  }

  private async appendOps(text: string): Promise<void> {
    const bytes = Buffer.byteLength(text, "utf8");
    if (this.opsBytes > 0 && this.opsBytes + bytes > this.options.rotateBytes) {
      await this.rotateOps();
    }

    try {
      await appendFile(this.opsPath, text, { mode: 0o600 });
      this.opsBytes += bytes;
    } catch (error) {
      this.fail("could not append telemetry", error);
    }
  }

  private async rotateOps(): Promise<void> {
    const rotations = Math.max(1, this.options.rotations);
    await rm(`${this.opsPath}.${rotations}.ndjson`, { force: true }).catch(
      () => {},
    );
    for (let index = rotations - 1; index >= 1; index -= 1) {
      await rename(
        `${this.opsPath}.${index}.ndjson`,
        `${this.opsPath}.${index + 1}.ndjson`,
      ).catch(() => {});
    }
    await rename(this.opsPath, `${this.opsPath}.1.ndjson`).catch(() => {});
    this.opsBytes = 0;
  }

  private async writeRing(
    op: string,
    entries: ReadonlyArray<OpRecord>,
  ): Promise<void> {
    await this.writeRingLines(
      op,
      entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    );
  }

  /**
   * One bounded file of JSON lines. Only the owner rewrites a ring, so two
   * instances appending at once can never truncate each other's samples; a
   * non-owner appends and leaves the compaction to the owner's next flush.
   */
  private async writeRingLines(name: string, added: string): Promise<void> {
    const path = join(this.options.directory, "rings", `${name}.ndjson`);
    const limit = Math.max(1, this.options.samplesPerType);

    if (!this.owner) {
      await appendFile(path, added, { mode: 0o600 }).catch(() => {});
      return;
    }

    const existing = await readFile(path, "utf8").catch(() => "");
    const lines = `${existing}${added}`
      .split("\n")
      .filter((line) => line.length > 0);
    const kept = lines.slice(-limit);
    await writeFile(path, `${kept.join("\n")}\n`, { mode: 0o600 }).catch(
      () => {},
    );
  }

  private async writeRollup(date: string, rollup: RollupDelta): Promise<void> {
    if (
      Object.keys(rollup.ops).length === 0 &&
      dwellTotal(rollup.states) === 0
    ) {
      return;
    }

    const directory = join(this.options.directory, "rollup", date);
    await mkdir(directory, { recursive: true, mode: 0o700 }).catch(() => {});
    const path = join(directory, `${this.options.instance}.json`);
    const existing = await readJson<RollupDelta>(path);
    const merged = mergeRollup(existing, rollup);
    await writeFile(path, JSON.stringify(merged), { mode: 0o600 }).catch(
      () => {},
    );
  }

  // -- report helpers -------------------------------------------------------

  private async opsFiles(): Promise<string[]> {
    // Oldest first: the highest rotation number is the oldest file.
    const files: string[] = [];
    for (let index = this.options.rotations; index >= 1; index -= 1) {
      const path = `${this.opsPath}.${index}.ndjson`;
      if (await fileSize(path) > 0) files.push(path);
    }
    files.push(this.opsPath);
    return files;
  }

  private async boots(): Promise<BootSummary[]> {
    const byBoot = new Map<string, MutableBoot>();
    const crashed = new Set<string>();
    const records: OpRecord[] = [];

    for (const path of await this.opsFiles()) {
      const text = await readFile(path, "utf8").catch(() => "");
      for (const line of text.split("\n")) {
        const record = parseOp(line);
        if (record === null || !record.op.startsWith("lifecycle.")) continue;
        records.push(record);
        if (record.op === "lifecycle.crash") {
          const id =
            typeof record.meta?.bootId === "string" ? record.meta.bootId : "";
          if (id.length > 0) crashed.add(id);
        }
      }
    }

    for (const record of records) {
      const bootId =
        typeof record.meta?.bootId === "string" ? record.meta.bootId : null;
      if (bootId === null) continue;
      const at =
        typeof record.meta?.bootAt === "number"
          ? record.meta.bootAt
          : record.at;
      const current: MutableBoot = byBoot.get(bootId) ?? {
        at,
        bootId,
        bootMs: 0,
        readyMs: null,
        indexedMs: null,
        crashed: false,
      };
      if (record.op === "lifecycle.boot") current.bootMs = record.ms;
      if (record.op === "lifecycle.ready") current.readyMs = record.ms;
      if (record.op === "lifecycle.indexed") current.indexedMs = record.ms;
      byBoot.set(bootId, current);
    }

    return [...byBoot.values()]
      .map((entry) => ({
        at: entry.at,
        bootId: entry.bootId,
        bootMs: entry.bootMs,
        readyMs: entry.readyMs,
        indexedMs: entry.indexedMs,
        crashed: crashed.has(entry.bootId),
      }))
      .sort((left, right) => right.at - left.at)
      .slice(0, 10);
  }

  private async dwellForWindow(since: number): Promise<StateDwell> {
    const dates = await readdir(join(this.options.directory, "rollup")).catch(
      () => [] as string[],
    );

    // One instance per location, so only this one's rollups describe the day
    // this panel shows; summing a peer's would count the same wall time twice.
    const mine = `${this.options.instance}.json`;
    let total = ZERO_DWELL;
    for (const date of dates) {
      const dayStart = Date.parse(`${date}T00:00:00`);
      if (since > 0 && dayStart + 86_400_000 <= since) continue;
      const directory = join(this.options.directory, "rollup", date);
      const rollup = await readJson<RollupDelta>(join(directory, mine));
      if (rollup === null) continue;
      total = mergeDwell(total, rollup.states);
    }

    return mergeDwell(total, this.pendingDwellByState());
  }

  private pendingDwellByState(): StateDwell {
    const pending = this.pendingDwell(this.currentState);
    return addDwell(ZERO_DWELL, this.currentState, pending);
  }

  private async processSummary(since: number): Promise<ProcessSummary | null> {
    const directory = join(this.options.directory, "samples");
    const files = (await readdir(directory).catch(() => [] as string[]))
      .filter((name) => name.endsWith(".ndjson"))
      .sort();
    const samples: SampleRecord[] = [];

    for (const file of files) {
      const path = join(directory, file);
      const text = await readFile(path, "utf8").catch(() => "");
      for (const line of text.split("\n")) {
        const sample = parseSample(line);
        if (sample === null || sample.at < since) continue;
        samples.push(sample);
      }
    }
    if (samples.length === 0) return null;

    // Samples from another project's node share the store; keep this one's.
    const mine = samples.filter(
      (sample) => sample.prefix === undefined ||
        sample.prefix === this.options.prefix,
    );
    const node = mine.filter((sample) => sample.kind === "node");
    const pool = node.length > 0 ? node : mine;
    // Mixing pids compares a fresh node against a retired one; keep the pid of
    // the newest sample, which is the node that answers now.
    const currentPid = pool[pool.length - 1]?.pid;
    const series = pool.filter((sample) => sample.pid === currentPid);
    const rss = series.map((sample) => sample.rssBytes).sort((a, b) => a - b);
    const busy = series.filter(
      (sample) => sample.load > 0 && sample.cpuPct !== null,
    );
    const idle = series.filter(
      (sample) => sample.load === 0 && sample.cpuPct !== null,
    );
    const last = series[series.length - 1];

    return {
      cpuPct: last?.cpuPct ?? null,
      rssBytes: last?.rssBytes ?? null,
      peakRssBytes: rss[rss.length - 1] ?? 0,
      rssP50: percentile(rss, 50),
      rssP95: percentile(rss, 95),
      cpuBusy: mean(busy.map((sample) => sample.cpuPct ?? 0)),
      cpuReady: mean(idle.map((sample) => sample.cpuPct ?? 0)),
      growthMbPerDay: growth(series),
    };
  }

  private async historyStart(): Promise<string | null> {
    const dates = await readdir(join(this.options.directory, "rollup")).catch(
      () => [] as string[],
    );
    const days = dates
      .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
      .sort();
    return days[0] ?? null;
  }

  // -- size and sweep -------------------------------------------------------

  private async storeBytes(): Promise<number> {
    const cached = this.cache.get(this.options.directory);
    if (
      cached !== undefined &&
      Date.now() - cached.at < SIZE_CACHE_MS
    ) {
      return cached.bytes;
    }
    const bytes = await directoryBytes(this.options.directory);
    this.cache.set(this.options.directory, { at: Date.now(), bytes });
    return bytes;
  }

  private async sweep(): Promise<void> {
    if (!this.enabled || this.broken) return;
    this.lastSweep = Date.now();
    this.cache.delete(this.options.directory);

    const cap = this.options.maxBytes;
    if (cap <= 0) return;
    let bytes = await this.storeBytes();
    if (bytes <= cap) return;

    // Rotated ops first: the current file is the live log and is kept.
    const rotated = (
      await readdir(this.options.directory).catch(() => [] as string[])
    )
      .filter((name) => /^ops\.\d+\.ndjson$/.test(name))
      .sort((left, right) => rotationOf(right) - rotationOf(left));
    for (const name of rotated) {
      bytes -= await removeFile(join(this.options.directory, name));
      if (bytes <= cap) return this.refreshCache();
    }

    // Sample days next: they are the bulk of the store.
    const sampleDays = await dayFiles(
      join(this.options.directory, "samples"),
      ".ndjson",
    );
    for (const name of sampleDays) {
      bytes -= await removeFile(join(this.options.directory, "samples", name));
      if (bytes <= cap) return this.refreshCache();
    }

    const rollupDays = await dayDirs(join(this.options.directory, "rollup"));
    for (const name of rollupDays) {
      bytes -= await removeDirectory(
        join(this.options.directory, "rollup", name),
      );
      if (bytes <= cap) return this.refreshCache();
    }

    // Halve every ring, keeping the newest samples.
    const rings = join(this.options.directory, "rings");
    for (const name of await readdir(rings).catch(() => [] as string[])) {
      const path = join(rings, name);
      const size = await fileSize(path);
      const lines = (await readFile(path, "utf8").catch(() => "")).split("\n")
        .filter((line) => line.length > 0);
      const kept = lines.slice(-Math.max(1, Math.floor(lines.length / 2)));
      await writeFile(path, `${kept.join("\n")}\n`, {
        mode: 0o600,
      }).catch(() => {});
      bytes -= size - Buffer.byteLength(kept.join("\n"), "utf8");
      if (bytes <= cap) return this.refreshCache();
    }

    // The cap still binds: stop ring, sample, and rollup writes for this
    // session and keep only the ops log.
    this.options.logger.warn(
      "telemetry reached telemetry.maxBytes; keeping only the operation log",
      { maxBytes: cap },
    );
    this.broken = true;
    this.disabledReason = "store is over telemetry.maxBytes";
    this.refreshCache();
  }

  private refreshCache(): void {
    this.cache.delete(this.options.directory);
  }

  // -- plumbing -------------------------------------------------------------

  private metaFor(meta: unknown, error: unknown): { meta?: OpMeta } | null {
    const out: Record<string, string | number | boolean | null> = {};

    if (typeof meta === "object" && meta !== null) {
      const entries = Object.entries(meta as Record<string, unknown>);
      for (const [key, value] of entries) {
        if (!/^[a-z][a-z0-9_]{0,31}$/i.test(key)) continue;
        if (typeof value === "string") {
          out[key] = this.options.maxText > 0
            ? redactClip(value, this.options.maxText)
            : "";
        } else if (typeof value === "number" && Number.isFinite(value)) {
          out[key] = Math.round(value * 10) / 10;
        } else if (typeof value === "boolean" || value === null) {
          out[key] = value;
        }
      }
    }

    if (error !== undefined) {
      out.error = errorName(error);
      const status = httpStatus(error);
      if (status !== null) out.status = status;
    }

    return Object.keys(out).length === 0 ? null : { meta: out };
  }

  private matchesPrefix(record: OpRecord, op: string | undefined): boolean {
    if (op === undefined || op.length === 0) return true;
    if (op.endsWith(".")) return record.op.startsWith(op);
    return record.op === op || record.op.startsWith(`${op}.`);
  }

  private windowStart(window: ReportWindow): number {
    if (window === "session") return this.startedAt;
    if (window === "day") return startOfDay(Date.now());
    return 0;
  }

  private todayDwell(): StateDwell {
    const today = dayKey(Date.now());
    if (today !== this.rollupDate) {
      this.rollupDate = today;
      this.rollup = emptyRollup();
      this.dayDwell = ZERO_DWELL;
    }
    return this.rollup.states;
  }

  private async claimWriter(): Promise<boolean> {
    const lock = join(this.options.directory, "writer.lock");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await mkdir(lock);
        await writeFile(join(lock, "owner"), `${process.pid}\n`, {
          mode: 0o600,
        }).catch(() => {});
        this.lockedAt = Date.now();
        return true;
      } catch {
        const owner = await readOwner(lock);
        if (owner !== null && owner !== process.pid && isAlive(owner)) {
          return false;
        }
        if (owner === null) {
          const info = await stat(lock).catch(() => null);
          if (
            info !== null &&
            Date.now() - info.mtimeMs < STALE_LOCK_MS
          ) {
            return false;
          }
        }
        await rm(lock, { recursive: true, force: true }).catch(() => {});
      }
    }
    return false;
  }

  private async releaseWriter(): Promise<void> {
    if (!this.owner) return;
    await rm(join(this.options.directory, "writer.lock"), {
      recursive: true,
      force: true,
    }).catch(() => {});
    this.owner = false;
  }

  private fail(message: string, error: unknown): void {
    if (this.broken) return;
    this.broken = true;
    this.disabledReason = message;
    this.options.logger.warn(
      message,
      error instanceof Error ? error.message : String(error),
    );
    if (this.timer !== null) clearInterval(this.timer);
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.timer = null;
    this.sweepTimer = null;
  }
}

/** A boot summary while it is still being assembled from records. */
interface MutableBoot {
  at: number;
  bootId: string;
  bootMs: number;
  readyMs: number | null;
  indexedMs: number | null;
  crashed: boolean;
}

interface RollupDelta {
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  ops: Record<
    string,
    { count: number; errors: number; totalMs: number; maxMs: number }
  >;
  states: StateDwell;
}

function emptyRollup(): RollupDelta {
  return {
    count: 0,
    errors: 0,
    totalMs: 0,
    maxMs: 0,
    ops: {},
    states: ZERO_DWELL,
  };
}

function mergeRollup(
  existing: RollupDelta | null,
  delta: RollupDelta,
): RollupDelta {
  if (existing === null) return delta;

  const ops = { ...existing.ops };
  for (const [op, entry] of Object.entries(delta.ops)) {
    const prior = ops[op] ?? { count: 0, errors: 0, totalMs: 0, maxMs: 0 };
    ops[op] = {
      count: prior.count + entry.count,
      errors: prior.errors + entry.errors,
      totalMs: prior.totalMs + entry.totalMs,
      maxMs: Math.max(prior.maxMs, entry.maxMs),
    };
  }

  return {
    count: existing.count + delta.count,
    errors: existing.errors + delta.errors,
    totalMs: existing.totalMs + delta.totalMs,
    maxMs: Math.max(existing.maxMs, delta.maxMs),
    ops,
    states: mergeDwell(existing.states, delta.states),
  };
}

function mergeDwell(left: StateDwell, right: StateDwell): StateDwell {
  return {
    startingMs: left.startingMs + right.startingMs,
    readyMs: left.readyMs + right.readyMs,
    busyMs: left.busyMs + right.busyMs,
    degradedMs: left.degradedMs + right.degradedMs,
    stoppedMs: left.stoppedMs + right.stoppedMs,
  };
}

function addDwell(
  dwell: StateDwell,
  state: ServiceState,
  ms: number,
): StateDwell {
  switch (state) {
    case "starting":
      return { ...dwell, startingMs: dwell.startingMs + ms };
    case "ready":
      return { ...dwell, readyMs: dwell.readyMs + ms };
    case "busy":
      return { ...dwell, busyMs: dwell.busyMs + ms };
    case "degraded":
      return { ...dwell, degradedMs: dwell.degradedMs + ms };
    case "stopped":
      return { ...dwell, stoppedMs: dwell.stoppedMs + ms };
  }
}

function dwellValue(dwell: StateDwell, state: ServiceState): number {
  switch (state) {
    case "starting":
      return dwell.startingMs;
    case "ready":
      return dwell.readyMs;
    case "busy":
      return dwell.busyMs;
    case "degraded":
      return dwell.degradedMs;
    case "stopped":
      return dwell.stoppedMs;
  }
}

function dwellTotal(dwell: StateDwell): number {
  return (
    dwell.startingMs +
    dwell.readyMs +
    dwell.busyMs +
    dwell.degradedMs +
    dwell.stoppedMs
  );
}

function summarize(
  records: ReadonlyArray<OpRecord>,
  sort: ReportSort,
): OpSummary[] {
  const groups = new Map<string, OpRecord[]>();
  for (const record of records) {
    const group = groups.get(record.op);
    if (group === undefined) groups.set(record.op, [record]);
    else group.push(record);
  }

  const rows = [...groups.entries()].map(([op, entries]) => {
    const durations = entries.map((entry) => entry.ms).sort((a, b) => a - b);
    const idle = entries.filter((entry) => entry.load === 0);
    const busy = entries.filter((entry) => entry.load > 0);
    return {
      op,
      count: entries.length,
      errors: entries.filter((entry) => !entry.ok).length,
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      max: durations[durations.length - 1] ?? 0,
      totalMs: Math.round(durations.reduce((total, ms) => total + ms, 0)),
      idleP50: percentile(sortNumbers(idle.map((entry) => entry.ms)), 50),
      busyP50: percentile(sortNumbers(busy.map((entry) => entry.ms)), 50),
    };
  });

  rows.sort((left, right) => {
    switch (sort) {
      case "p95":
        return right.p95 - left.p95;
      case "total":
        return right.totalMs - left.totalMs;
      case "errors":
        return right.errors - left.errors;
      default:
        return right.count - left.count;
    }
  });
  return rows;
}

function sortNumbers(values: ReadonlyArray<number>): number[] {
  return [...values].sort((left, right) => left - right);
}

/** Nearest-rank percentile: no interpolation, so small sets stay readable. */
export function percentile(sorted: ReadonlyArray<number>, p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return Math.round(sorted[index] ?? 0);
}

function mean(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round((total / values.length) * 10) / 10;
}

/** Resident-set change over the sampled window, in MB per day. */
export function growth(samples: ReadonlyArray<SampleRecord>): number {
  if (samples.length < 2) return 0;
  const ordered = [...samples].sort((left, right) => left.at - right.at);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (first === undefined || last === undefined) return 0;

  // A two-minute window says nothing about a day; extrapolating it produced
  // figures in the tens of gigabytes. Wait for an hour of history.
  const span = last.at - first.at;
  if (span < MIN_GROWTH_SPAN_MS) return 0;
  const megabytes = (last.rssBytes - first.rssBytes) / (1024 * 1024);
  return Math.round((megabytes / (span / 86_400_000)) * 10) / 10;
}

function parseOp(line: string): OpRecord | null {
  if (line.length === 0) return null;
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (typeof value.at !== "number" || typeof value.op !== "string") {
      return null;
    }
    if (typeof value.ms !== "number" || typeof value.ok !== "boolean") {
      return null;
    }
    return {
      at: value.at,
      op: value.op as OpType,
      ms: value.ms,
      ok: value.ok,
      load: typeof value.load === "number" ? value.load : 0,
      prefix: typeof value.prefix === "string" ? value.prefix : "",
      ...(typeof value.meta === "object" && value.meta !== null
        ? { meta: value.meta as OpMeta }
        : {}),
    };
  } catch {
    return null;
  }
}

function parseSample(line: string): SampleRecord | null {
  if (line.length === 0) return null;
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (typeof value.at !== "number" || typeof value.pid !== "number") {
      return null;
    }
    if (typeof value.rssBytes !== "number") return null;
    const kind = value.kind;
    if (kind !== "node" && kind !== "watcher" && kind !== "index") return null;
    return {
      at: value.at,
      kind,
      pid: value.pid,
      load: typeof value.load === "number" ? value.load : 0,
      cpuPct: typeof value.cpuPct === "number" ? value.cpuPct : null,
      rssBytes: value.rssBytes,
      threads: typeof value.threads === "number" ? value.threads : null,
    };
  } catch {
    return null;
  }
}

async function readMarker(path: string): Promise<BootMarker | null> {
  try {
    const text = await readFile(path, "utf8");
    const value = JSON.parse(text) as Record<string, unknown>;
    if (typeof value.pid !== "number" || typeof value.at !== "number") {
      return null;
    }
    return {
      bootId:
        typeof value.bootId === "string" ? value.bootId : String(value.pid),
      pid: value.pid,
      prefix: typeof value.prefix === "string" ? value.prefix : "",
      at: value.at,
      phase: typeof value.phase === "string" ? value.phase : "setup",
    };
  } catch {
    return null;
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function readOwner(lock: string): Promise<number | null> {
  const text = await readFile(join(lock, "owner"), "utf8").catch(() => null);
  if (text === null) return null;
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function errorName(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) return error.name;
  return "Error";
}

/** HTTP status for a client error; the message itself is never recorded. */
function httpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const value = (error as { status?: unknown }).status;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rotationOf(name: string): number {
  return Number(/^ops\.(\d+)\.ndjson$/.exec(name)?.[1] ?? 0);
}

export function dayKey(at: number): string {
  const date = new Date(at);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

async function dayFiles(directory: string, suffix: string): Promise<string[]> {
  const names = await readdir(directory).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith(suffix)).sort();
}

async function dayDirs(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
}

async function fileSize(path: string): Promise<number> {
  return stat(path).then((info) => info.size).catch(() => 0);
}

async function removeFile(path: string): Promise<number> {
  const size = await fileSize(path);
  await rm(path, { force: true }).catch(() => {});
  return size;
}

async function removeDirectory(path: string): Promise<number> {
  const size = await directoryBytes(path);
  await rm(path, { recursive: true, force: true }).catch(() => {});
  return size;
}

async function directoryBytes(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  let total = 0;
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(path);
    else total += await fileSize(path);
  }
  return total;
}

