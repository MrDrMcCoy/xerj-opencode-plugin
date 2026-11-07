// Closed vocabulary for the telemetry store. Operation types are a fixed set so
// a typo cannot create a new ring file or a row the report never groups; the
// `tool.` and `rpc.` families are the exception, because their members are
// discovered at registration time.

/** Operation types the plugin records on its own behalf. */
export const OP_TYPES = [
  "retrieve",
  "inject",
  "recall",
  "hint",
  "rehydrate",
  "search",
  "search.lexical",
  "search.semantic",
  "search.name",
  "brain.expand",
  "index.project",
  "index.hidden",
  "index.web",
  "index.brain",
  "index.git",
  "index.archive",
  "index.prjdocs",
  "index.sysdocs",
  "node.spawn",
  "node.attach",
  "node.probe",
  "node.stop",
  "binary.detect",
  "binary.install",
  "binary.resolve",
  "memory.store",
  "memory.recall",
  "memory.forget",
  "memory.curate",
  "memory.verify",
  "memory.distill",
  "memory.distill.judge",
  "memory.distill.autotune",
  "memory.extract",
  "hook.prompt",
  "hook.context",
  "hook.tool",
  "graph.ego",
  "graph.overview",
  "archive.append",
  "archive.expand",
  "lifecycle.boot",
  "lifecycle.ready",
  "lifecycle.indexed",
  "lifecycle.state",
  "lifecycle.crash",
  "lifecycle.restart",
] as const;

export type StaticOpType = (typeof OP_TYPES)[number];

/** A tool or RPC member, named after its registration. */
export type DynamicOpType = `tool.${string}` | `rpc.${string}`;

export type OpType = StaticOpType | DynamicOpType;

const STATIC_OPS: ReadonlySet<string> = new Set(OP_TYPES);
const DYNAMIC_OP = /^(?:tool|rpc)\.[a-z0-9][a-z0-9_.-]*$/;

/** True for a known type; unknown names are refused rather than stored. */
export function isOpType(value: string): value is OpType {
  return STATIC_OPS.has(value) || DYNAMIC_OP.test(value);
}

/**
 * Longer-running work that makes the service `busy`. Each kind has a deadline
 * so a leaked job cannot pin the badge forever.
 */
export enum JobKind {
  Spawn = "spawn",
  Index = "index",
  Embed = "embed",
  Hidden = "hidden",
  Web = "web",
  Brain = "brain",
  Git = "git",
  Archive = "archive",
  Cmd = "cmd",
  Prjdocs = "prjdocs",
  Sysdocs = "sysdocs",
  Install = "install",
}

/** How long a job of each kind may run before it stops counting as busy. */
export const JOB_DEADLINE_MS: Readonly<Record<JobKind, number>> = {
  [JobKind.Spawn]: 5 * 60_000,
  [JobKind.Index]: 30 * 60_000,
  [JobKind.Embed]: 30 * 60_000,
  [JobKind.Hidden]: 5 * 60_000,
  [JobKind.Web]: 5 * 60_000,
  [JobKind.Brain]: 20 * 60_000,
  [JobKind.Git]: 5 * 60_000,
  [JobKind.Archive]: 5 * 60_000,
  [JobKind.Cmd]: 5 * 60_000,
  [JobKind.Prjdocs]: 20 * 60_000,
  [JobKind.Sysdocs]: 20 * 60_000,
  [JobKind.Install]: 10 * 60_000,
};

export type ServiceState =
  | "starting"
  | "ready"
  | "busy"
  | "degraded"
  | "stopped";

/** Milliseconds spent in each state today. */
export interface StateDwell {
  readonly startingMs: number;
  readonly readyMs: number;
  readonly busyMs: number;
  readonly degradedMs: number;
  readonly stoppedMs: number;
}

export const ZERO_DWELL: StateDwell = {
  startingMs: 0,
  readyMs: 0,
  busyMs: 0,
  degradedMs: 0,
  stoppedMs: 0,
};

/** One running job, as the sidebar and the report see it. */
export interface JobView {
  readonly kind: JobKind;
  readonly label: string;
  readonly startedAt: number;
}

export type MetaValue = string | number | boolean | null;
export type OpMeta = Readonly<Record<string, MetaValue>>;

/** One line of `ops.ndjson`. */
export interface OpRecord {
  readonly at: number;
  readonly op: OpType;
  readonly ms: number;
  readonly ok: boolean;
  readonly load: number;
  readonly prefix: string;
  readonly meta?: OpMeta;
}

/** One process sample. `cpuPct` is null for the first sample of a pid. */
export interface SampleRecord {
  readonly at: number;
  readonly kind: "node" | "watcher" | "index";
  /** Project prefix, so a report shows this project's node, not a peer's. */
  readonly prefix?: string;
  readonly pid: number;
  readonly load: number;
  readonly cpuPct: number | null;
  readonly rssBytes: number;
  readonly threads: number | null;
}

/** One line the UI half reported about itself, kept in `rings/ui.sidebar`. */
export interface UiRecord {
  readonly at: number;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  /** Project prefix and instance, so two open locations stay apart. */
  readonly prefix?: string;
  readonly instance?: string;
  readonly detail?: string;
}

/** The boot marker that tells a clean shutdown from a crash. */
export interface BootMarker {
  readonly bootId: string;
  readonly pid: number;
  readonly prefix: string;
  readonly at: number;
  readonly phase: string;
}

export const PROCESS_KINDS = ["node", "watcher", "index"] as const;
export type ProcessKind = (typeof PROCESS_KINDS)[number];

/** A bounded scalar set: never a prompt, a file body, or model output. */
export function sanitizeMeta(value: unknown): OpMeta | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  const out: Record<string, MetaValue> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9_]{0,31}$/i.test(key)) continue;
    if (typeof entry === "string") out[key] = entry;
    else if (typeof entry === "number" && Number.isFinite(entry)) {
      out[key] = entry;
    }
    else if (typeof entry === "boolean") out[key] = entry;
    else if (entry === null) out[key] = null;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}
