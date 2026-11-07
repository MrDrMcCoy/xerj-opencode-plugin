// Periodic calibration for the local judge's keep floor.
//
// The autotuner does not learn from unlabelled turns. It replays the labelled
// set through the live model, picks the threshold with the best F1, and adopts
// it only when the improvement clears a margin. The set is fixed, so a stable
// model normally leaves the floor alone; a changed model, wording, or tokenizer
// is what moves it. The chosen value lives in `<data root>/jev/tuning.json` and
// survives restarts.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "../log.ts";
import { ACCEPT, REPORTS } from "../memory/labels.ts";

export interface TuningView {
  readonly threshold: number;
  readonly autotuned: boolean;
  readonly tunedAt: string | null;
  readonly f1: number | null;
}

export interface AutotuneResult {
  readonly from: number;
  readonly to: number;
  readonly candidate: number;
  readonly f1: number;
  readonly precision: number;
  readonly recall: number;
  readonly samples: number;
  readonly applied: boolean;
}

export interface AutotuneState {
  readonly threshold: number;
  readonly configThreshold: number;
  readonly candidate: number;
  readonly f1: number;
  readonly candidateF1: number;
  readonly precision: number;
  readonly recall: number;
  readonly samples: number;
  readonly applied: boolean;
  readonly autotuned: boolean;
  readonly at: string;
}

export interface AutotuneOptions {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly initialDelayMs: number;
  /** F1 points, 0..1, a candidate needs over the current floor. */
  readonly margin: number;
  readonly minSamples: number;
  readonly statePath: string;
  readonly logger: Logger;
  /** One sentence through the live judge; null when it cannot answer. */
  readonly ask: (text: string) => Promise<number | null>;
  /** The floor from configuration, 0..1. */
  readonly configThreshold: number;
  readonly onThreshold: (value: number) => void;
  readonly onState: (view: TuningView) => void;
  readonly record: (result: AutotuneResult) => void;
  /** Tests inject their own set; production uses the labelled set. */
  readonly samples?: ReadonlyArray<{ readonly text: string; readonly label: boolean }>;
}

export interface Confusion {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly tn: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

export interface SweepRow {
  readonly threshold: number;
  readonly confusion: Confusion;
}

export const THRESHOLDS: ReadonlyArray<number> = [
  0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5,
];

/** Confusion at one threshold; `invert` keeps a low score. */
export function confusion(
  scores: readonly (number | null)[],
  labels: readonly boolean[],
  threshold: number,
  invert = false,
): Confusion {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (let index = 0; index < scores.length; index += 1) {
    const score = scores[index];
    const label = labels[index];
    if (score === null || score === undefined || label === undefined) continue;
    const keep = invert ? score <= threshold : score >= threshold;
    if (keep && label) tp += 1;
    else if (keep) fp += 1;
    else if (label) fn += 1;
    else tn += 1;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, tn, precision, recall, f1 };
}

export function sweep(
  scores: readonly (number | null)[],
  labels: readonly boolean[],
  thresholds: readonly number[],
  invert = false,
): SweepRow[] {
  return thresholds.map((threshold) => ({
    threshold,
    confusion: confusion(scores, labels, threshold, invert),
  }));
}

export function bestRow(rows: readonly SweepRow[]): SweepRow | null {
  let best: SweepRow | null = null;
  for (const row of rows) {
    if (best === null || row.confusion.f1 > best.confusion.f1) best = row;
  }
  return best;
}

const DEFAULT_SAMPLES = [
  ...ACCEPT.map((label) => ({ text: label.text, label: true })),
  ...REPORTS.map((text) => ({ text, label: false })),
];

export class Autotuner {
  private readonly options: AutotuneOptions;
  private readonly samples: ReadonlyArray<{
    readonly text: string;
    readonly label: boolean;
  }>;
  private threshold: number;
  private autotuned = false;
  private tunedAt: string | null = null;
  private f1: number | null = null;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: AutotuneOptions) {
    this.options = options;
    this.samples = options.samples ?? DEFAULT_SAMPLES;
    this.threshold = options.configThreshold;
  }

  get view(): TuningView {
    return {
      threshold: this.threshold,
      autotuned: this.autotuned,
      tunedAt: this.tunedAt,
      f1: this.f1,
    };
  }

  get activeThreshold(): number {
    return this.threshold;
  }

  /** Reads a saved floor and applies it when the config has not changed. */
  async load(): Promise<void> {
    if (!this.options.enabled) {
      this.publish();
      return;
    }
    const state = await this.readState();
    if (state !== null && Math.abs(state.configThreshold - this.options.configThreshold) < 1e-9) {
      if (state.threshold >= 0 && state.threshold <= 1) {
        this.threshold = state.threshold;
        this.autotuned = state.autotuned;
        this.tunedAt = state.at;
        this.f1 = state.f1;
        this.options.onThreshold(this.threshold);
      }
    } else if (state !== null) {
      this.options.logger.debug(
        "autotune state ignored: memory.distill.local.threshold changed",
        { saved: state.configThreshold, current: this.options.configThreshold },
      );
    }
    this.publish();
  }

  async start(signal: AbortSignal): Promise<void> {
    if (!this.options.enabled) {
      this.publish();
      return;
    }
    await this.load();
    if (signal.aborted) return;
    signal.addEventListener("abort", () => this.stop(), { once: true });
    this.initialTimer = setTimeout(
      () => void this.runOnce(),
      Math.max(0, this.options.initialDelayMs),
    );
    this.initialTimer.unref?.();
    this.timer = setInterval(() => void this.runOnce(), this.options.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.initialTimer !== null) clearTimeout(this.initialTimer);
    if (this.timer !== null) clearInterval(this.timer);
    this.initialTimer = null;
    this.timer = null;
  }

  /** One calibration pass; public so a test and a manual run can drive it. */
  async runOnce(): Promise<AutotuneResult | null> {
    if (!this.options.enabled || this.running) return null;
    this.running = true;
    try {
      const scores = await pool(this.samples, 4, (sample) =>
        this.options.ask(sample.text),
      );
      const labels = this.samples.map((sample) => sample.label);
      const answered = scores.filter((score) => score !== null).length;
      if (answered < this.options.minSamples) {
        this.options.logger.debug(
          "autotune skipped: too few judge answers",
          { answered, need: this.options.minSamples },
        );
        return null;
      }

      const current = confusion(scores, labels, this.threshold);
      const rows = sweep(scores, labels, THRESHOLDS);
      const best = bestRow(rows);
      if (best === null) return null;
      const applied =
        best.threshold !== this.threshold &&
        best.confusion.f1 >= current.f1 + this.options.margin;

      const from = this.threshold;
      if (applied) {
        this.threshold = best.threshold;
        this.autotuned = true;
        this.options.onThreshold(this.threshold);
        this.options.logger.info(
          "autotune moved the local judge floor",
          {
            from: from.toFixed(2),
            to: this.threshold.toFixed(2),
            f1: Number(best.confusion.f1.toFixed(3)),
            samples: answered,
          },
        );
      } else {
        this.options.logger.debug("autotune kept the local judge floor", {
          threshold: this.threshold.toFixed(2),
          f1: Number(current.f1.toFixed(3)),
          candidate: best.threshold.toFixed(2),
          candidateF1: Number(best.confusion.f1.toFixed(3)),
        });
      }

      this.tunedAt = new Date().toISOString();
      this.f1 = applied ? best.confusion.f1 : current.f1;
      const state: AutotuneState = {
        threshold: this.threshold,
        configThreshold: this.options.configThreshold,
        candidate: best.threshold,
        f1: this.f1,
        candidateF1: best.confusion.f1,
        precision: applied ? best.confusion.precision : current.precision,
        recall: applied ? best.confusion.recall : current.recall,
        samples: answered,
        applied,
        autotuned: this.autotuned,
        at: this.tunedAt,
      };
      await this.writeState(state);
      this.publish();
      const result: AutotuneResult = {
        from,
        to: this.threshold,
        candidate: best.threshold,
        f1: this.f1,
        precision: state.precision,
        recall: state.recall,
        samples: answered,
        applied,
      };
      this.options.record(result);
      return result;
    } catch (error) {
      this.options.logger.debug("autotune failed", String(error));
      return null;
    } finally {
      this.running = false;
    }
  }

  private publish(): void {
    this.options.onState(this.view);
  }

  private async readState(): Promise<AutotuneState | null> {
    try {
      const value = JSON.parse(await readFile(this.options.statePath, "utf8"));
      if (typeof value !== "object" || value === null) return null;
      const state = value as Record<string, unknown>;
      if (
        typeof state.threshold !== "number" ||
        typeof state.configThreshold !== "number" ||
        typeof state.at !== "string"
      ) {
        return null;
      }
      return {
        threshold: state.threshold,
        configThreshold: state.configThreshold,
        candidate: typeof state.candidate === "number" ? state.candidate : state.threshold,
        f1: typeof state.f1 === "number" ? state.f1 : 0,
        candidateF1: typeof state.candidateF1 === "number" ? state.candidateF1 : 0,
        precision: typeof state.precision === "number" ? state.precision : 0,
        recall: typeof state.recall === "number" ? state.recall : 0,
        samples: typeof state.samples === "number" ? state.samples : 0,
        applied: state.applied === true,
        autotuned: state.autotuned === true,
        at: state.at,
      };
    } catch {
      return null;
    }
  }

  private async writeState(state: AutotuneState): Promise<void> {
    try {
      await mkdir(dirname(this.options.statePath), { recursive: true, mode: 0o700 });
      await writeFile(
        this.options.statePath,
        `${JSON.stringify(state, null, 2)}\n`,
        { mode: 0o600 },
      );
    } catch (error) {
      this.options.logger.debug("could not save the autotune state", String(error));
    }
  }
}

async function pool<T, R>(
  items: readonly T[],
  size: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(size, items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await run(items[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
