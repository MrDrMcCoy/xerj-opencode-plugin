// Per-operation cost: wall time alone says nothing about whether a feature is
// cheap or expensive for the machine. Every span records its own CPU time and
// resident-set change, and the report groups those by operation and feature.

export interface CostSnapshot {
  readonly user: number;
  readonly system: number;
  readonly rss: number;
  /** Process-wide peak RSS in bytes, when the platform reports it. */
  readonly peakRss: number;
}

export interface CostFields {
  readonly cpuMs: number;
  readonly rssBefore: number;
  readonly rssAfter: number;
  readonly rssDelta: number;
  readonly rssPeak: number;
}

export function snapshotCost(): CostSnapshot {
  const cpu = process.cpuUsage();
  const peak = process.resourceUsage?.().maxRSS ?? 0;
  return {
    user: cpu.user,
    system: cpu.system,
    rss: process.memoryUsage().rss,
    // Linux reports maxRSS in kilobytes; other platforms are left at zero
    // rather than multiplied by a guess.
    peakRss: process.platform === "linux" ? peak * 1024 : 0,
  };
}

export function costFields(before: CostSnapshot, after: CostSnapshot): CostFields {
  return {
    cpuMs: Math.max(
      0,
      Math.round((after.user - before.user + after.system - before.system) / 1000),
    ),
    rssBefore: before.rss,
    rssAfter: after.rss,
    rssDelta: after.rss - before.rss,
    rssPeak: Math.max(before.rss, after.rss, after.peakRss),
  };
}

/** Merges cost fields under any caller metadata; caller values win. */
export function withCost(meta: unknown, cost: CostFields): Record<string, unknown> {
  const base =
    typeof meta === "object" && meta !== null
      ? (meta as Record<string, unknown>)
      : {};
  return { ...cost, ...base };
}

const TOOL_FEATURES: Readonly<Record<string, string>> = {
  search: "retrieval",
  def: "retrieval",
  refs: "analysis",
  outline: "analysis",
  zoom: "analysis",
  find: "analysis",
  ast: "analysis",
  imports: "analysis",
  complexity: "analysis",
  callers: "analysis",
  impact: "analysis",
  inspect: "analysis",
  ask: "hub",
  hub: "hub",
  code: "code",
  share: "share",
  run: "cmd",
  out: "cmd",
  remember: "memory",
  recall: "memory",
  forget: "memory",
  reindex: "index",
  prjdocs: "index",
  sysdocs: "index",
  telemetry: "telemetry",
  status: "status",
  anomaly: "anomaly",
  dataset: "dataset",
  expand: "archive",
  notes: "notes",
};

/** Maps an operation or tool span to the feature a user would compare. */
export function featureOf(op: string): string {
  if (op.startsWith("tool.")) {
    return TOOL_FEATURES[op.slice("tool.".length)] ?? "tool";
  }
  if (op.startsWith("index.")) return "index";
  if (op.startsWith("node.")) return "node";
  if (op.startsWith("binary.")) return "binary";
  if (op.startsWith("memory.")) return "memory";
  if (op.startsWith("search.")) return "retrieval";
  if (op === "retrieve" || op === "inject" || op === "recall" || op === "hint") {
    return "retrieval";
  }
  if (op === "brain.expand" || op === "rehydrate" || op.startsWith("hook.")) {
    return "retrieval";
  }
  if (op.startsWith("graph.")) return "graph";
  if (op.startsWith("archive.")) return "archive";
  if (op.startsWith("lifecycle.")) return "lifecycle";
  return "other";
}
