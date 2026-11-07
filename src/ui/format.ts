// Presentation only: every function here turns a status snapshot into text.
// No I/O, no RPC, so the TUI stays thin and the formatting stays testable.

import type { JobStatus, StatusSnapshot } from "../rpc.ts";
import { stateGlyph } from "../telemetry/state.ts";

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
function formatSignedTokens(value: number): string {
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

/** Elapsed time: "1.4s", "48s", "12m", "6h 12m", "2d". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = ms / THOUSAND;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  }
  return `${Math.floor(hours / 24)}d`;
}

/** Time until a future deadline: "in 45m", "in 12s". */
function formatUntil(now: number, at: number): string {
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
/** One label/value row in the sidebar. */
export interface SidebarRow {
  readonly label: string;
  readonly value: string;
  /** Colour hint: a failing corpus or a warning is not muted. */
  readonly tone?: "ok" | "warn" | "bad";
}

export interface SidebarSectionView {
  readonly title: string;
  readonly rows: ReadonlyArray<SidebarRow>;
}

export interface SidebarView {
  readonly label: string;
  readonly version: string;
  /** `● ready` or `◐ busy · indexing`, for the header. */
  readonly badge: string;
  /** Three rows that fit in a collapsed sidebar. */
  readonly collapsed: ReadonlyArray<SidebarRow>;
  readonly sections: ReadonlyArray<SidebarSectionView>;
}

/** Corpora shown before the list is summarised as a count. */
const CORPORA_ROWS = 4;
/** Jobs named in the collapsed row before the rest are counted. */
const JOBS_IN_ROW = 2;

/**
 * The sidebar as data, so the component only places it. Every number comes
 * from the snapshot: the UI never computes a figure the server owns.
 */
export function sidebarView(
  snapshot: StatusSnapshot,
  now: number,
  sections: { corpora: boolean; session: boolean; savings: boolean; runtime: boolean; health: boolean },
): SidebarView {
  const index = snapshot.index;
  const usage = snapshot.usage;

  const indexRow: SidebarRow = {
    label: "Index",
    value:
      index.state === "watching"
        ? `${formatCount(index.docs)} docs`
        : `${index.state} · ${formatCount(index.docs)} docs`,
    tone: index.lastError === null ? "ok" : "warn",
  };
  const savedRow: SidebarRow = {
    label: "Saved",
    value: `${formatTokens(usage.tokensSaved)} tok · ${formatPercent(usage.hitRate)} hit`,
  };
  const memoryRow: SidebarRow = {
    label: "Memory",
    value:
      `${formatCount(snapshot.memory.count)}` +
      (snapshot.memory.stale > 0 ? ` · ${formatCount(snapshot.memory.stale)} stale` : "") +
      (snapshot.memory.exists ? "" : " · missing"),
    tone: snapshot.memory.exists ? "ok" : "bad",
  };

  const state = snapshot.state;
  // A server half older than the field would otherwise take the sidebar down.
  const jobs: ReadonlyArray<JobStatus> = state.jobs ?? [];
  // A running job belongs in the collapsed sidebar too: the reason a search is
  // slow is worth seeing without expanding the block.
  const jobsRow: SidebarRow | null =
    jobs.length === 0
      ? null
      : {
          label: "Jobs",
          value: jobsSummary(jobs, now),
          tone: "warn",
        };

  const stateSection: SidebarSectionView = {
    title: "State",
    rows: [
      {
        label: "now",
        value:
          `${state.name}` +
          (state.detail === null ? "" : ` · ${state.detail}`),
        tone:
          state.name === "degraded"
            ? "bad"
            : state.name === "busy" || state.name === "starting"
              ? "warn"
              : "ok",
      },
      ...(jobs.length === 0
        ? []
        : [
            {
              label: "jobs",
              value: jobsSummary(jobs, now, Number.POSITIVE_INFINITY),
              tone: "warn" as const,
            },
          ]),
      {
        label: "today",
        value:
          `ready ${formatDuration(state.today.readyMs)} · ` +
          `busy ${formatDuration(state.today.busyMs)}` +
          (state.today.degradedMs > 0
            ? ` · degraded ${formatDuration(state.today.degradedMs)}`
            : ""),
      },
    ],
  };

  const corpora: SidebarSectionView = {
    title: "Corpora",
    rows: (() => {
      if (snapshot.corpora.length === 0) return [{ label: "none", value: "no runs yet" }];
      const shown: SidebarRow[] = snapshot.corpora.slice(0, CORPORA_ROWS).map((corpus) => ({
        label: corpus.name,
        value:
          corpus.error !== null
            ? `error · ${corpus.error}`
            : `${corpus.state} · ${corpus.docs === null ? "—" : formatCount(corpus.docs)} docs`,
        tone: corpus.error !== null ? "bad" : corpus.state === "watching" ? "ok" : "warn",
      }));
      const rest = snapshot.corpora.length - shown.length;
      return rest > 0 ? [...shown, { label: `+${rest} more`, value: "" }] : shown;
    })(),
  };

  const session: SidebarSectionView = {
    title: "Session",
    rows: [
      { label: "queries", value: formatCount(usage.queries) },
      { label: "hits", value: `${formatCount(usage.hits)} · ${formatPercent(usage.hitRate)}` },
      { label: "injected", value: formatCount(snapshot.counters.injectedTurns) },
      {
        label: "skipped",
        value: `${formatCount(snapshot.counters.noiseSkips)} as noise`,
      },
    ],
  };

  const savings: SidebarSectionView = {
    title: "Savings",
    rows: [
      { label: "saved", value: `${formatTokens(usage.tokensSaved)} tok` },
      { label: "cost", value: `${formatTokens(usage.tokensCost)} tok`, tone: "warn" },
      {
        label: "net",
        value: `${formatTokens(usage.netTokens)} tok`,
        tone: usage.netTokens < 0 ? "bad" : "ok",
      },
      { label: "returned", value: formatBytes(usage.bytesReturned) },
    ],
  };

  const runtime: SidebarSectionView = {
    title: "Runtime",
    rows: [
      snapshot.process === null
        ? { label: "node", value: "no counters" }
        : {
            label: "node",
            value: `${snapshot.process.cpuPercent.toFixed(1)}% · ${formatBytes(snapshot.process.memoryBytes)}`,
          },
      { label: "vectors", value: snapshot.embeddings ? "building" : "idle", tone: snapshot.embeddings ? "warn" : undefined },
      { label: "sessions", value: formatCount(snapshot.node.sessions ?? 0) },
    ],
  };

  const health: SidebarSectionView = {
    title: "Health",
    rows: [
      {
        label: "warnings",
        value:
          snapshot.warnings.length === 0
            ? "none"
            : String(snapshot.warnings.length),
        tone: snapshot.warnings.length === 0 ? "ok" : "warn",
      },
      {
        label: "last run",
        value:
          index.lastRunAt === null
            ? "no runs"
            : `${formatAge(now, index.lastRunAt)} · gen ${index.lastGeneration ?? "—"}`,
      },
      ...(index.lastError === null
        ? []
        : [{ label: "error", value: index.lastError, tone: "bad" as const }]),
    ],
  };

  return {
    label: "XERJ",
    version: snapshot.pluginVersion,
    badge:
      `${stateGlyph(state.name)} ${state.name}` +
      (state.detail === null ? "" : ` · ${state.detail}`) +
      (state.name === "busy" ? ` · ${formatDuration(now - state.since)}` : ""),
    collapsed:
      jobsRow === null
        ? [indexRow, savedRow, memoryRow]
        : [indexRow, savedRow, memoryRow, jobsRow],
    sections: [
      stateSection,
      ...(sections.corpora ? [corpora] : []),
      ...(sections.session ? [session] : []),
      ...(sections.savings ? [savings] : []),
      ...(sections.runtime ? [runtime] : []),
      ...(sections.health ? [health] : []),
    ],
  };
}

/** `indexing 12s · web 3s`, with a count once the row is full. */
function jobsSummary(
  jobs: ReadonlyArray<JobStatus>,
  now: number,
  limit: number = JOBS_IN_ROW,
): string {
  const shown = jobs
    .slice(0, limit)
    .map((job) => `${job.label} ${formatDuration(now - job.startedAt)}`);
  const rest = jobs.length - shown.length;
  return rest > 0 ? `${shown.join(" · ")} · +${rest}` : shown.join(" · ");
}

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
  const state = snapshot.state;

  return [
    `XERJ  ${stateGlyph(state.name)} ${state.name}` +
      (state.detail === null ? "" : ` · ${state.detail}`) +
      ` · ${formatCount(index.docs)} docs`,
    [
      `q ${formatCount(usage.queries)}`,
      `hit ${formatPercent(usage.hitRate)}`,
      ...(snapshot.counters.noiseSkips > 0
        ? [`${formatCount(snapshot.counters.noiseSkips)} skipped`]
        : []),
      `${formatTokens(usage.tokensSaved)} tok saved`,
    ].join("  "),
    `idx ${formatAge(now, index.lastRunAt)} · ${records}` +
      (snapshot.embeddings ? " · embedding" : ""),
    "▸ /xerj for details",
  ];
}

/** Every block of the details panel, in display order. */
export function panelSections(snapshot: StatusSnapshot, now: number): PanelSection[] {
  const { node, binary, index, memory, usage, state } = snapshot;
  const jobs: ReadonlyArray<JobStatus> = state.jobs ?? [];

  return [
    {
      title: "State",
      lines: [
        `${state.name}${state.detail === null ? "" : ` · ${state.detail}`}` +
          ` · ${formatDuration(now - state.since)} in this state`,
        ...(jobs.length === 0
          ? ["no jobs running"]
          : jobs.map(
              (job) =>
                `${job.kind}  ${job.label} · ` +
                `${formatDuration(now - job.startedAt)}`,
            )),
        `today  ready ${formatDuration(state.today.readyMs)} · ` +
          `busy ${formatDuration(state.today.busyMs)} · ` +
          `degraded ${formatDuration(state.today.degradedMs)} · ` +
          `starting ${formatDuration(state.today.startingMs)}`,
      ],
    },
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
        `engine ${formatBytes(snapshot.disk.engineBytes)} · log ${formatBytes(snapshot.disk.logBytes)}`,
        // What the corpus actually holds, by record kind: a data map rather
        // than a document count.
        ...(snapshot.map.length === 0
          ? []
          : [
              `records: ${snapshot.map
                .slice(0, MAP_ROWS)
                .map((row) => `${row.kind} ${formatCount(row.docs)}`)
                .join(" · ")}`,
            ]),
        // Keywords `prjdocs` documents even though the project does not use
        // them, so the setting is visible where the corpus is described.
        ...(snapshot.config.prjdocsKeywords.length === 0
          ? []
          : [`prjdocs keywords: ${snapshot.config.prjdocsKeywords.join(", ")}`]),
      ],
    },
    {
      title: "Corpora",
      lines:
        snapshot.corpora.length === 0
          ? ["none yet"]
          : snapshot.corpora.map((corpus) =>
              [
                `${corpus.name}  ${corpus.state}`,
                corpus.docs === null ? null : `${formatCount(corpus.docs)} docs`,
                corpus.edges === null
                  ? null
                  : `${formatCount(corpus.edges)} edges`,
                corpus.error === null ? null : `error: ${corpus.error}`,
              ]
                .filter((part) => part !== null)
                .join(" · "),
            ),
    },
    {
      title: "Datasets",
      lines: datasetLines(index.datasets),
    },
    ...(snapshot.frameworks.length === 0
      ? []
      : [
          {
            title: "Frameworks",
            lines: [
              `${formatCount(snapshot.frameworks.length)} documented in ` +
                `${formatBytes(snapshot.frameworks.reduce((total, row) => total + row.bytes, 0))}`,
              ...[...snapshot.frameworks]
                .sort((left, right) => right.bytes - left.bytes)
                .slice(0, FRAMEWORK_ROWS)
                .map((row) =>
                  [
                    `${row.tech}  ${formatCount(row.docs)} docs`,
                    // Documents indexed before the byte field existed sum to
                    // zero; the count is still true, so show only that.
                    row.bytes > 0 ? formatBytes(row.bytes) : null,
                  ]
                    .filter((part) => part !== null)
                    .join(" · "),
                ),
            ],
          },
        ]),
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
      title: "Node load",
      lines: [
        snapshot.process === null
          ? "no counters on this platform"
          : `${snapshot.process.cpuPercent.toFixed(1)}% cpu · ` +
            `${formatBytes(snapshot.process.memoryBytes)} rss`,
        ...(snapshot.telemetry.process === null
          ? []
          : [
              `peak ` +
                `${formatBytes(snapshot.telemetry.process.peakRssBytes)} · ` +
                `p95 ${formatBytes(snapshot.telemetry.process.rssP95)}` +
                (snapshot.telemetry.process.cpuBusy === null
                  ? ""
                  : ` · busy ` +
                    `${snapshot.telemetry.process.cpuBusy.toFixed(1)}% cpu`),
              `growth ` +
                (snapshot.telemetry.process.growthMbPerDay >= 0 ? "+" : "") +
                `${snapshot.telemetry.process.growthMbPerDay} MB/day`,
            ]),
        snapshot.embeddings ? "building embeddings now" : "not embedding",
      ],
    },
    ...(snapshot.telemetry.enabled
      ? [
          {
            title: "Telemetry",
            lines: telemetryLines(snapshot),
          },
        ]
      : []),
    {
      title: "Memory",
      lines: [
        [
          `${formatCount(memory.count)} ${plural(memory.count, "entry", "entries")}` +
            (memory.exists ? "" : " · index missing") +
            (memory.stale > 0 ? ` · ${formatCount(memory.stale)} stale` : ""),
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
        `${formatCount(snapshot.counters.noiseSkips)} prompts skipped as noise ` +
          "(gate kept nothing, so the turn injected no context)",
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

/**
 * The five busiest operation types, the last boot's figures, and the promise
 * that matters most: these files stay on this machine.
 */
function telemetryLines(snapshot: StatusSnapshot): string[] {
  const telemetry = snapshot.telemetry;
  const last = telemetry.starts[0] ?? null;

  return [
    ...(telemetry.ops.length === 0
      ? ["no operations recorded yet"]
      : telemetry.ops
          .slice(0, 5)
          .map(
            (row) =>
              `${row.op} ${formatCount(row.count)}× · ` +
              `p50 ${row.p50}ms · p95 ${row.p95}ms` +
              (row.errors > 0 ? ` · ${row.errors} err` : ""),
          )),
    last === null
      ? "no boot recorded yet"
      : `last boot setup ${formatDuration(last.bootMs)}` +
        (last.readyMs === null
          ? ""
          : ` · ready ${formatDuration(last.readyMs)}`) +
        (last.indexedMs === null
          ? ""
          : ` · indexed ${formatDuration(last.indexedMs)}`) +
        (last.crashed ? " · previous run crashed" : ""),
    `${formatCount(telemetry.crashes)} crashes · ` +
      `${formatCount(telemetry.restarts)} restarts · ` +
      `${formatBytes(telemetry.storeBytes)} store` +
      (telemetry.disabled === null ? "" : ` · ${telemetry.disabled}`),
    `local only · never sent` +
      (telemetry.historyStart === null
        ? ""
        : ` · since ${telemetry.historyStart}`),
  ].flat();
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

/** Rows the framework list shows before it is cut. */
const FRAMEWORK_ROWS = 12;
/** Record kinds the data map lists. */
const MAP_ROWS = 6;

/**
 * Datasets largest first, each with its share of the total. A corpus's size
 * against the rest is what tells a reader whether the Elasticsearch reference
 * or their own project dominates the index.
 */
function datasetLines(datasets: ReadonlyArray<{ name: string; docs: number; bytes: number }>): string[] {
  if (datasets.length === 0) return ["none yet"];
  const total = datasets.reduce((sum, dataset) => sum + dataset.bytes, 0);

  return [...datasets]
    .sort((left, right) => right.bytes - left.bytes)
    .map((dataset) => {
      const share = total === 0 ? 0 : Math.round((dataset.bytes / total) * 100);
      return (
        `${dataset.name}  ${formatCount(dataset.docs)} docs · ` +
        `${formatBytes(dataset.bytes)} · ${share}%`
      );
    });
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}
