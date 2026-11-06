// CPU and RSS sampling for every XERJ process the plugin owns. A duration says
// an index pass took 105 seconds; the sampler says whether that used one core
// or eight, and whether the resident set grew while it ran.

import type { Logger } from "../log.ts";
import {
  cpuPercentSince,
  readProcessCounters,
  type ProcessCounters,
} from "../process-stats.ts";
import type { TelemetryStore } from "./store.ts";
import type { ProcessKind, SampleRecord } from "./types.ts";

export interface SampleTarget {
  readonly kind: ProcessKind;
  readonly pid: number;
}

export interface SamplerOptions {
  readonly store: TelemetryStore;
  readonly logger: Logger;
  /** 0 disables sampling; everything else in the store keeps working. */
  readonly intervalMs: number;
  readonly targets: () => ReadonlyArray<SampleTarget>;
  readonly load: () => number;
  readonly platform?: NodeJS.Platform;
  readonly read?: (pid: number) => Promise<ProcessCounters | null>;
  readonly now?: () => number;
}

const VANISHED_WARN_MS = 60 * 60_000;
const VANISHED_KINDS: ReadonlySet<ProcessKind> = new Set(["watcher", "index"]);

export class ProcessSampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly previous = new Map<string, { ticks: number; at: number }>();
  private readonly warned = new Map<string, number>();
  private unavailable = false;

  constructor(private readonly options: SamplerOptions) {
    this.options.store.setLoadProvider(() => this.options.load());
  }

  start(): void {
    if (this.options.intervalMs <= 0 || this.unavailable) return;
    if ((this.options.platform ?? process.platform) === "win32") {
      this.options.logger.warn(
        "CPU and memory sampling is not available on Windows; " +
          "set telemetry.sampleMs to 0 to silence this",
      );
      this.unavailable = true;
      return;
    }

    void this.sampleOnce();
    this.timer = setInterval(
      () => void this.sampleOnce(),
      this.options.intervalMs,
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** One sample of each target; a vanished pid is skipped, not an error. */
  async sampleOnce(): Promise<void> {
    if (this.unavailable) return;
    const at = this.options.now?.() ?? Date.now();
    const load = this.options.load();

    for (const target of this.options.targets()) {
      const counters = await this.read(target.pid);
      if (counters === null) {
        this.noteVanished(target.kind);
        continue;
      }

      const key = `${target.kind}:${target.pid}`;
      let cpuPct = counters.cpuPercent;
      if (counters.ticks !== null) {
        const prior = this.previous.get(key);
        cpuPct =
          prior === undefined
            ? null
            : cpuPercentSince(prior, { ticks: counters.ticks, at });
        this.previous.set(key, { ticks: counters.ticks, at });
      }

      const sample: SampleRecord = {
        at,
        kind: target.kind,
        pid: target.pid,
        load,
        cpuPct,
        rssBytes: counters.memoryBytes,
        threads: counters.threads,
      };
      this.options.store.sample(sample);
    }
  }

  /** Drops a pid's history, so a restarted process starts at null CPU. */
  forget(pid: number): void {
    for (const key of [...this.previous.keys()]) {
      if (key.endsWith(`:${pid}`)) this.previous.delete(key);
    }
  }

  private async read(pid: number): Promise<ProcessCounters | null> {
    if (this.options.read !== undefined) {
      return this.options.read(pid).catch(() => null);
    }
    return readProcessCounters(pid, { platform: this.options.platform }).catch(
      () => null,
    );
  }

  /** One warning per kind per hour, not one per interval. */
  private noteVanished(kind: ProcessKind): void {
    if (!VANISHED_KINDS.has(kind)) return;
    const now = this.options.now?.() ?? Date.now();
    const last = this.warned.get(kind) ?? 0;
    if (now - last < VANISHED_WARN_MS) return;
    this.warned.set(kind, now);
    this.options.logger.debug(
      "telemetry sample skipped: the process is gone",
      { kind },
    );
  }
}
