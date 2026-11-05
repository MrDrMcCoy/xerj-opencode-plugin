// Presentation only: every function here turns a status snapshot into text.
// No I/O, no RPC, so the TUI stays thin and the formatting stays testable.

import type { StatusSnapshot } from "../rpc.ts";

export interface PanelSection {
  readonly title: string;
  readonly lines: ReadonlyArray<string>;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const THOUSAND = 1000;

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";

  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < BYTE_UNITS.length - 1) {
    amount /= 1024;
    unit += 1;
  }

  // Whole bytes stay whole; scaled units keep one decimal below 100.
  const digits = unit === 0 || amount >= 100 ? 0 : 1;
  return `${amount.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Math.round(value).toLocaleString("en-US");
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "~0";
  return `~${formatTokenAmount(value)}`;
}

/** Signed variant for the net figure: "~-1.2K" when the plugin costs more than it saves. */
export function formatSignedTokens(value: number): string {
  if (!Number.isFinite(value)) return "~0";
  const sign = value < 0 ? "-" : "~";
  return `${sign}${formatTokenAmount(Math.abs(value))}`;
}

function formatTokenAmount(value: number): string {
  if (value < THOUSAND) return `${Math.round(value)}`;

  if (value < THOUSAND * THOUSAND) {
    return `${(value / THOUSAND).toFixed(1)}K`;
  }
  return `${(value / (THOUSAND * THOUSAND)).toFixed(1)}M`;
}

export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return "0%";
  return `${Math.round(ratio * 100)}%`;
}

/** Compact age; `null` is "never" and the first ten seconds are "just now". */
export function formatAge(now: number, at: number | null): string {
  if (at === null || !Number.isFinite(at)) return "never";

  const seconds = Math.max(0, Math.round((now - at) / THOUSAND));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  return `${Math.floor(hours / 24)}d ago`;
}

/** Time until a future deadline: "in 45m", "in 12s". */
export function formatUntil(now: number, at: number): string {
  const seconds = Math.max(0, Math.round((at - now) / THOUSAND));
  if (seconds < 10) return "any moment";
  if (seconds < 60) return `in ${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

/** Four lines for the sidebar slot. */
export function sidebarLines(snapshot: StatusSnapshot, now: number): string[] {
  const index = snapshot.index;
  const usage = snapshot.usage;
  // Files, not records: the headline already counts docs, and a record count
  // next to it reads as a mismatch because docs include symbol records.
  const records =
    index.lastRunAt === null
      ? "no runs"
      : index.lastFiles === null
        ? `${formatCount(index.lastRecords ?? 0)} records`
        : `${formatCount(index.lastFiles)} files`;

  return [
    `XERJ  ${marker(snapshot)} ${headline(snapshot)}`,
    [
      `q ${formatCount(usage.queries)}`,
      `hit ${formatPercent(usage.hitRate)}`,
      `${formatTokens(usage.tokensSaved)} tok saved`,
    ].join("  "),
    `idx ${formatAge(now, index.lastRunAt)} · ${records}`,
    "▸ /xerj for details",
  ];
}

/** Every block of the details panel, in display order. */
export function panelSections(snapshot: StatusSnapshot, now: number): PanelSection[] {
  const { node, binary, index, memory, usage } = snapshot;

  return [
    {
      title: "Node",
      lines: [
        [
          node.phase,
          node.state,
          node.spawned ? "spawned" : "attached",
          node.baseUrl ?? "no address",
        ].join(" · "),
        node.serverVersion === null ? "server unknown" : `server ${node.serverVersion}`,
        node.idleAt === null || node.state !== "running"
          ? `${node.sessions} ${plural(node.sessions, "session", "sessions")}`
          : [
              `${node.sessions} ${plural(node.sessions, "session", "sessions")}`,
              `idle stop ${formatUntil(now, node.idleAt)}`,
            ].join(" · "),
      ],
    },
    {
      title: "Binary",
      lines: [
        `${binary.version ?? "not installed"}${targetSuffix(binary.target)}`,
        binary.path ?? "managed download",
      ],
    },
    {
      title: "Index",
      lines: [
        `${indexLabel(index.state)} · ${index.prefix}`,
        [
          `${formatCount(index.docs)} docs`,
          formatBytes(index.bytes),
          `${index.indices} ${plural(index.indices, "index", "indices")}`,
        ].join(" · "),
        [
          `last run ${formatAge(now, index.lastRunAt)}`,
          `generation ${index.lastGeneration ?? "—"}`,
          index.lastFiles === null
            ? `${index.lastRecords ?? 0} records`
            : `${formatCount(index.lastFiles)} files → ${formatCount(index.lastRecords ?? 0)} records`,
        ].join(" · "),
      ],
    },
    {
      title: "Datasets",
      lines:
        index.datasets.length === 0
          ? ["none yet"]
          : index.datasets.map(
              (dataset) =>
                `${dataset.name}  ${formatCount(dataset.docs)} docs · ` +
                `${formatBytes(dataset.bytes)}`,
            ),
    },
    ...(snapshot.brains.length === 0
      ? []
      : [
          {
            title: "Brains",
            lines: snapshot.brains.map((brain) =>
              [
                `${brain.name}  ${formatCount(brain.docs)} docs`,
                `${brain.edges} ${plural(brain.edges, "edge", "edges")}`,
                formatAge(now, brain.lastRunAt),
                brain.error ?? "",
              ]
                .filter((part) => part.length > 0)
                .join(" · "),
            ),
          },
        ]),
    {
      title: "Memory",
      lines: [
        [
          `${formatCount(memory.count)} ${plural(memory.count, "entry", "entries")}`,
          memory.namespace,
        ].join(" · "),
      ],
    },
    {
      title: "Usage",
      lines: [
        [
          `${formatCount(usage.queries)} queries`,
          `${formatPercent(usage.hitRate)} hit`,
          `${formatCount(usage.hits)} hits`,
        ].join(" · "),
        [
          `${formatTokens(usage.tokensSaved)} tokens saved`,
          `${formatBytes(usage.savedBytes)} of ` +
            `${formatBytes(usage.baselineBytes)} baseline`,
        ].join(" · "),
        `${formatBytes(usage.bytesReturned)} returned · ${formatBytes(usage.bytesRead)} read`,
        [
          `${formatTokens(usage.tokensCost)} tok cost · ` +
            `${formatSignedTokens(usage.netTokens)} net`,
          usage.netTokens < 0
            ? "costing more than it saves"
            : "saving more than it costs",
        ].join(" · "),
      ],
    },
    {
      title: "Counters",
      lines: [
        `${formatCount(snapshot.counters.indexRuns)} index runs · ` +
          `${formatCount(snapshot.counters.injectedTurns)} injections`,
        `${formatCount(snapshot.counters.nodeSpawns)} spawns · ` +
          `${formatCount(snapshot.counters.http429)} rate-limited · ` +
          `${formatCount(snapshot.counters.rpcCalls)} rpc calls`,
      ],
    },
    {
      title: "Top cited",
      lines:
        usage.topFiles.length === 0
          ? ["none yet"]
          : usage.topFiles.map(
              (file) => `${file.path} ×${file.citations} · ${formatBytes(file.bytes)}`,
            ),
    },
    {
      title: "Health",
      lines: healthLines(snapshot),
    },
  ];
}

function healthLines(snapshot: StatusSnapshot): string[] {
  const lines = [
    ...snapshot.warnings.map((warning) => `warn: ${warning}`),
    ...snapshot.recent,
    ...snapshot.errors.map((error) => `error: ${error}`),
  ];

  return lines.length === 0 ? ["no warnings"] : lines.slice(-6);
}

// `shared` means another plugin instance owns the watcher for this project; the
// corpus is still healthy, so do not surface the ownership detail as a state.
function indexLabel(state: string): string {
  return state === "shared" ? "watching (shared)" : state;
}

function marker(snapshot: StatusSnapshot): string {
  return snapshot.node.phase === "ready" ? "●" : "○";
}

function headline(snapshot: StatusSnapshot): string {
  const index = snapshot.index;
  if (snapshot.node.phase !== "ready") {
    return snapshot.node.phase === "starting" ? "starting" : snapshot.node.phase;
  }
  if (index.docs === 0) return "ready · not indexed yet";
  return `ready · ${formatCount(index.docs)} docs · ${formatBytes(index.bytes)}`;
}

function targetSuffix(target: string | null): string {
  return target === null ? "" : ` · ${target}`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}
