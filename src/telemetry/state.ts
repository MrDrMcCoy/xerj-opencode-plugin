// The five service states and the jobs that make the service busy. One place
// computes both, so the sidebar, the panel, and the telemetry report cannot
// disagree about whether XERJ is ready or working.

import {
  JOB_DEADLINE_MS,
  type JobKind,
  type JobView,
  type ServiceState,
} from "./types.ts";

export interface JobRegistryOptions {
  readonly now?: () => number;
  /** Called once per job that outlives its deadline. */
  readonly onStale?: (job: JobView) => void;
}

interface ActiveJob extends JobView {
  stale: boolean;
}

/**
 * Reference-counted jobs: two overlapping passes keep the state busy until
 * both end, and the first to finish does not clear it.
 */
export class JobRegistry {
  private readonly active: ActiveJob[] = [];
  private readonly now: () => number;

  constructor(private readonly options: JobRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Starts a job and returns the function that ends it; idempotent. */
  begin(kind: JobKind, label: string): () => void {
    const job: ActiveJob = { kind, label, startedAt: this.now(), stale: false };
    this.active.push(job);
    let ended = false;

    return () => {
      if (ended) return;
      ended = true;
      const index = this.active.indexOf(job);
      if (index >= 0) this.active.splice(index, 1);
    };
  }

  /** Number of live jobs; recorded as `load` on every operation. */
  get load(): number {
    this.expire();
    return this.active.filter((job) => !job.stale).length;
  }

  /** Live jobs, newest last; a stale job is dropped and reported once. */
  jobs(): JobView[] {
    this.expire();
    return this.active
      .filter((job) => !job.stale)
      .map(({ kind, label, startedAt }) => ({ kind, label, startedAt }));
  }

  /** The dominant job's label, for the one-line state detail. */
  detail(): string | null {
    const jobs = this.jobs();
    if (jobs.length === 0) return null;
    const first = jobs[0];
    return first === undefined ? null : first.label;
  }

  clear(): void {
    this.active.length = 0;
  }

  private expire(): void {
    const now = this.now();
    for (const job of this.active) {
      if (job.stale) continue;
      if (now - job.startedAt <= JOB_DEADLINE_MS[job.kind]) continue;
      job.stale = true;
      this.options.onStale?.({
        kind: job.kind,
        label: job.label,
        startedAt: job.startedAt,
      });
    }
  }
}

export interface CorpusStateInput {
  readonly name: string;
  readonly state: string;
  readonly docs: number | null;
  readonly records: number | null;
  readonly error: string | null;
}

export interface ServiceStateInput {
  readonly nodePhase: "starting" | "ready" | "error" | "disabled";
  readonly nodeState: "stopped" | "starting" | "running" | "error";
  readonly corpora: ReadonlyArray<CorpusStateInput>;
  readonly memoryExists: boolean;
  readonly jobs: ReadonlyArray<JobView>;
}

export interface ServiceStateResult {
  readonly name: ServiceState;
  readonly detail: string | null;
}

/**
 * Precedence: starting, stopped, degraded, busy, ready. A broken index
 * outranks a slow one for the badge; the running jobs stay listed regardless.
 */
export function serviceState(input: ServiceStateInput): ServiceStateResult {
  if (input.nodePhase === "starting") {
    return { name: "starting", detail: null };
  }
  if (input.nodePhase === "disabled" || input.nodePhase === "error") {
    return { name: "degraded", detail: input.nodePhase };
  }
  if (input.nodeState === "stopped") {
    return { name: "stopped", detail: null };
  }

  const broken = input.corpora.find(
    (corpus) => corpus.error !== null || isMissing(corpus),
  );
  if (broken !== undefined) {
    return {
      name: "degraded",
      detail: broken.error ?? `${broken.name} index missing`,
    };
  }
  if (!input.memoryExists && input.corpora.length > 0) {
    return { name: "degraded", detail: "memory missing" };
  }

  const job = input.jobs[0];
  if (job !== undefined) {
    return { name: "busy", detail: job.label };
  }
  return { name: "ready", detail: null };
}

/** A pass that wrote records but whose index is gone. */
function isMissing(corpus: CorpusStateInput): boolean {
  if (corpus.state === "missing") return true;
  return corpus.docs === 0 && (corpus.records ?? 0) > 0;
}

/** A stable one-line badge, e.g. `busy · indexing` or `ready`. */
export function stateBadge(state: ServiceStateResult): string {
  return state.detail === null ? state.name : `${state.name} · ${state.detail}`;
}

/** Marker glyph for the sidebar header. */
export function stateGlyph(state: ServiceState): string {
  switch (state) {
    case "starting":
      return "◐";
    case "busy":
      return "◐";
    case "degraded":
      return "▲";
    case "stopped":
      return "○";
    case "ready":
      return "●";
  }
}
