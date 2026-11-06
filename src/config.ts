import {
  Priority as NodePriority,
  parseCpuSpec,
  type CpuSpec,
} from "./node/priority.ts";
import type { Libc } from "./platform.ts";

// Plugin options. Every field has a default, unknown keys are ignored, and a
// malformed value falls back to the default with a warning instead of failing
// plugin load. A search plugin that refuses to start because one option is a
// string instead of a number is worse than one that starts with defaults.

export interface BinaryOptions {
  /** "auto" tracks the newest release at or above the tracking floor,
   * across majors; anything else pins that exact version. */
  readonly version: string;
  /** Explicit binary path; skips download and upgrade entirely. */
  readonly path: string | null;
  /** Explicit release triple; overrides host detection. Mostly for CI. */
  readonly target: string | null;
  /** Linux C library flavour of the downloaded build. */
  readonly libc: Libc;
}

export interface NodeOptions {
  /** Size at which `node.log` is rotated aside; 0 disables rotation. */
  readonly logMaxBytes: number;
  /** Attach to an existing node instead of spawning one. */
  readonly url: string | null;
  /**
   * CPU and I/O priority for every XERJ process the plugin starts. `low`
   * keeps indexing out of the editor's way; `high` trades responsiveness for
   * a faster first index.
   */
  readonly priority: NodePriority;
  /**
   * CPUs every XERJ process may use: indices and ranges, `odd`, `even`, or a
   * percentage of the available CPUs. Null leaves affinity unchanged.
   */
  readonly cpus: CpuSpec | null;
  /** Preferred ES-compatible port; the supervisor may advance it. */
  readonly port: number;
  readonly dataDir: string | null;
  /** Stop this project's node when nothing has used it for this long. */
  readonly idleMs: number;
  /** Set false to keep the node running after the last session goes quiet. */
  readonly shutdownOnIdle: boolean;
}

export interface IndexOptions {
  readonly auto: boolean;
  /** Keep a resident `autoindex --watch` process instead of polling. */
  readonly watch: boolean;
  readonly debounceMs: number;
  readonly periodicMs: number;
  readonly workers: number | null;
  readonly brain: ReadonlyArray<string>;
  /** Hidden folders indexed as plain documents, e.g. `.agents`. */
  readonly hidden: ReadonlyArray<string>;
  readonly hiddenMaxBytes: number;
  readonly semantic: boolean;
  /**
   * Index the project as a graph (a "super brain"): one corpus with sections,
   * symbols, `path:line`, and edges, refreshed by the plugin's own watcher
   * because the engine refuses `--watch` in graph mode.
   */
  readonly graph: boolean;
  /** Git history as a searchable corpus. */
  readonly git: boolean;
  /** Commits read per pass; older ones leave the corpus. */
  readonly gitLimit: number;
  /** Embed passages with the node's neural model; false serves lexical only. */
  readonly neural: boolean;
  readonly maxBytes: number;
  /** Upper bound on the measured first-index estimate before asking. */
  readonly maxMinutes: number;
}

export interface RemoteOptions {
  readonly enabled: boolean;
  readonly maxBytes: number;
}

export interface ContextOptions {
  readonly enabled: boolean;
  readonly maxTokens: number;
  readonly memoryTokens: number;
  /** Keeps raw turns so a compacted session can still be expanded. */
  readonly archiveEnabled: boolean;
  readonly archiveMaxBytes: number;
  /** Re-injects the session's working set after the host compacts. */
  readonly rehydrate: boolean;
  readonly rehydrateTokens: number;
  readonly maxPassages: number;
  readonly timeoutMs: number;
}

export interface PrjdocsOptions {
  /** Documentation targets crawled in one run. */
  readonly maxTargets: number;
  /** Pages per target; 0 uses the per-source default. */
  readonly maxPages: number;
  /**
   * Eager mode removes the depth and page-type limits, judges pages with the
   * current model, and searches for documentation of unknown technologies.
   */
  readonly eager: boolean;
  /** Pages per site in eager mode. */
  readonly eagerMaxPages: number;
  /** Link depth in eager mode. */
  readonly eagerMaxDepth: number;
  /** Model judgements per run; the heuristic covers the rest. */
  readonly eagerModelCalls: number;
  /** Terms to document even when the project does not use them (eager mode). */
  readonly eagerKeywords: ReadonlyArray<string>;
  /**
   * Include XERJ's own documentation and the Elasticsearch reference for the
   * version this node emulates, whatever the project uses.
   */
  readonly builtin: boolean;
  /** Markdown files taken from the XERJ repository. */
  readonly builtinXerjPages: number;
  /** Pages taken from the Elasticsearch reference. */
  readonly builtinElasticsearchPages: number;
  /**
   * Days before the always-on sources are crawled again. The reference crawl
   * takes minutes, so it runs on this window rather than on every command.
   */
  readonly builtinRefreshDays: number;
}

export interface SysdocsOptions {
  /** Pages indexed per run; the rest wait for the next run. */
  readonly maxDocs: number;
  /** Bytes kept per page. */
  readonly maxBytesPerDoc: number;
  /** Extra man roots; empty means MANPATH, then the system defaults. */
  readonly manDirs: ReadonlyArray<string>;
  /** Extra info roots; empty means INFOPATH, then the system defaults. */
  readonly infoDirs: ReadonlyArray<string>;
}

export interface MemoryRetainOptions {
  /** Days an automatic summary is kept; 0 disables the age cap. */
  readonly days: number;
  /** Summaries kept regardless of age; 0 disables the count cap. */
  readonly maxCount: number;
  /** Bytes of summary text kept; 0 disables the size cap. */
  readonly maxBytes: number;
}

export interface MemoryOptions {
  readonly enabled: boolean;
  /** Store each substantive turn's final answer as a `summary` memory. */
  readonly captureTurns: boolean;
  /** Age and size caps for automatic summaries. Explicit memories never expire. */
  readonly retain: MemoryRetainOptions;
}

export interface StatsOptions {
  readonly enabled: boolean;
  readonly bytesPerToken: number;
  /** Baseline credited per cited file; a lockfile should not count as 700 KB. */
  readonly maxBaselineBytes: number;
}

export interface TelemetryOptions {
  readonly anomaly: boolean;
}

export interface StorageOptions {
  /** Per-project XERJ data. Relative paths resolve inside the project. */
  readonly root: string | null;
}

export interface Config {
  readonly binary: BinaryOptions;
  readonly storage: StorageOptions;
  readonly node: NodeOptions;
  readonly index: IndexOptions;
  readonly remote: RemoteOptions;
  readonly context: ContextOptions;
  readonly prjdocs: PrjdocsOptions;
  readonly sysdocs: SysdocsOptions;
  readonly memory: MemoryOptions;
  readonly stats: StatsOptions;
  readonly telemetry: TelemetryOptions;
}

export interface LoadedConfig {
  readonly config: Config;
  readonly warnings: ReadonlyArray<string>;
}

export const DEFAULT_CONFIG: Config = {
  binary: { version: "auto", path: null, target: null, libc: "musl" },
  storage: { root: null },
  node: {
    url: null,
    priority: NodePriority.Low,
    cpus: null,
    logMaxBytes: 8 * 1024 ** 2,
    port: 9200,
    dataDir: null,
    idleMs: 1_800_000,
    shutdownOnIdle: true,
  },
  index: {
    auto: true,
    watch: true,
    debounceMs: 800,
    periodicMs: 900_000,
    workers: null,
    brain: [],
    hidden: [],
    hiddenMaxBytes: 256 * 1024,
    semantic: true,
    graph: true,
    git: true,
    gitLimit: 500,
    neural: true,
    maxBytes: 2 * 1024 ** 3,
    maxMinutes: 10,
  },
  remote: { enabled: true, maxBytes: 2_000_000 },
  context: {
    enabled: true,
    maxTokens: 1500,
    memoryTokens: 400,
    archiveEnabled: true,
    archiveMaxBytes: 64 * 1024 * 1024,
    rehydrate: true,
    rehydrateTokens: 600,
    maxPassages: 8,
    timeoutMs: 400,
  },
  prjdocs: {
    maxTargets: 40,
    maxPages: 0,
    eager: false,
    eagerMaxPages: 120,
    eagerMaxDepth: 12,
    eagerModelCalls: 150,
    eagerKeywords: [],
    builtin: true,
    builtinXerjPages: 200,
    builtinElasticsearchPages: 2500,
    builtinRefreshDays: 7,
  },
  sysdocs: {
    maxDocs: 5000,
    maxBytesPerDoc: 65536,
    manDirs: [],
    infoDirs: [],
  },
  memory: {
    enabled: true,
    captureTurns: true,
    retain: { days: 180, maxCount: 0, maxBytes: 2 * 1024 ** 3 },
  },
  stats: { enabled: true, bytesPerToken: 4, maxBaselineBytes: 128 * 1024 },
  telemetry: { anomaly: false },
};

type Raw = Record<string, unknown>;

export function loadConfig(
  raw: unknown,
  env: Readonly<Record<string, string | undefined>> = {},
): LoadedConfig {
  const warnings: string[] = [];
  const root = asObject(raw);

  const binary = asObject(root.binary);
  const storage = asObject(root.storage);
  const node = asObject(root.node);
  const index = asObject(root.index);
  const remote = asObject(root.remote);
  const context = asObject(root.context);
  const archive = asObject(context.archive);
  const prjdocs = asObject(root.prjdocs);
  const sysdocs = asObject(root.sysdocs);
  const memory = asObject(root.memory);
  const retain = asObject(memory.retain);
  const stats = asObject(root.stats);
  const telemetry = asObject(root.telemetry);

  const envUrl = env.XERJ_URL?.trim();

  const config: Config = {
    storage: { root: readString(storage.root, null) },
    binary: {
      version: readVersion(binary.version, warnings),
      path: readString(binary.path, null),
      target: readTarget(binary.target, warnings),
      libc: readLibc(binary.libc, warnings),
    },
    node: {
      url: readString(node.url, null) ?? (envUrl ? envUrl : null),
      priority: readPriority(node.priority, warnings),
      cpus: readCpuSpec(node.cpus, warnings),
      logMaxBytes: readInteger(
        node.logMaxBytes,
        DEFAULT_CONFIG.node.logMaxBytes,
        0,
        1024 ** 3,
        "node.logMaxBytes",
        warnings,
      ),
      port: readInteger(node.port, DEFAULT_CONFIG.node.port, 1, 65_535, "node.port", warnings),
      dataDir: readString(node.dataDir, null),
      idleMs: readInteger(
        node.idleMs,
        DEFAULT_CONFIG.node.idleMs,
        60_000,
        86_400_000,
        "node.idleMs",
        warnings,
      ),
      shutdownOnIdle: readBoolean(
        node.shutdownOnIdle,
        DEFAULT_CONFIG.node.shutdownOnIdle,
        "node.shutdownOnIdle",
        warnings,
      ),
    },
    index: {
      auto: readBoolean(index.auto, DEFAULT_CONFIG.index.auto, "index.auto", warnings),
      watch: readBoolean(index.watch, DEFAULT_CONFIG.index.watch, "index.watch", warnings),
      debounceMs: readInteger(
        index.debounceMs,
        DEFAULT_CONFIG.index.debounceMs,
        200,
        60_000,
        "index.debounceMs",
        warnings,
      ),
      periodicMs: readInteger(
        index.periodicMs,
        DEFAULT_CONFIG.index.periodicMs,
        10_000,
        86_400_000,
        "index.periodicMs",
        warnings,
      ),
      workers: readOptionalInteger(index.workers, 1, 1024, "index.workers", warnings),
      brain: readStringArray(index.brain, "index.brain", warnings),
      hidden: readStringArray(index.hidden, "index.hidden", warnings),
      hiddenMaxBytes: readInteger(
        index.hiddenMaxBytes,
        DEFAULT_CONFIG.index.hiddenMaxBytes,
        1_024,
        Number.MAX_SAFE_INTEGER,
        "index.hiddenMaxBytes",
        warnings,
      ),
      graph: readBoolean(
        index.graph,
        DEFAULT_CONFIG.index.graph,
        "index.graph",
        warnings,
      ),
      git: readBoolean(
        index.git,
        DEFAULT_CONFIG.index.git,
        "index.git",
        warnings,
      ),
      gitLimit: readInteger(
        index.gitLimit,
        DEFAULT_CONFIG.index.gitLimit,
        10,
        5000,
        "index.gitLimit",
        warnings,
      ),
      semantic: readBoolean(
        index.semantic,
        DEFAULT_CONFIG.index.semantic,
        "index.semantic",
        warnings,
      ),
      neural: readBoolean(index.neural, DEFAULT_CONFIG.index.neural, "index.neural", warnings),
      maxBytes: readInteger(
        index.maxBytes,
        DEFAULT_CONFIG.index.maxBytes,
        0,
        Number.MAX_SAFE_INTEGER,
        "index.maxBytes",
        warnings,
      ),
      maxMinutes: readInteger(
        index.maxMinutes,
        DEFAULT_CONFIG.index.maxMinutes,
        1,
        10_080,
        "index.maxMinutes",
        warnings,
      ),
    },
    remote: {
      enabled: readBoolean(remote.enabled, DEFAULT_CONFIG.remote.enabled, "remote.enabled", warnings),
      maxBytes: readInteger(
        remote.maxBytes,
        DEFAULT_CONFIG.remote.maxBytes,
        0,
        Number.MAX_SAFE_INTEGER,
        "remote.maxBytes",
        warnings,
      ),
    },
    context: {
      enabled: readBoolean(context.enabled, DEFAULT_CONFIG.context.enabled, "context.enabled", warnings),
      maxTokens: readInteger(
        context.maxTokens,
        DEFAULT_CONFIG.context.maxTokens,
        100,
        100_000,
        "context.maxTokens",
        warnings,
      ),
      memoryTokens: readInteger(
        context.memoryTokens,
        DEFAULT_CONFIG.context.memoryTokens,
        0,
        100_000,
        "context.memoryTokens",
        warnings,
      ),
      archiveEnabled: readBoolean(
        archive.enabled,
        DEFAULT_CONFIG.context.archiveEnabled,
        "context.archive.enabled",
        warnings,
      ),
      archiveMaxBytes: readInteger(
        archive.maxBytes,
        DEFAULT_CONFIG.context.archiveMaxBytes,
        1_048_576,
        Number.MAX_SAFE_INTEGER,
        "context.archive.maxBytes",
        warnings,
      ),
      rehydrate: readBoolean(
        context.rehydrate,
        DEFAULT_CONFIG.context.rehydrate,
        "context.rehydrate",
        warnings,
      ),
      rehydrateTokens: readInteger(
        context.rehydrateTokens,
        DEFAULT_CONFIG.context.rehydrateTokens,
        0,
        10_000,
        "context.rehydrateTokens",
        warnings,
      ),
      maxPassages: readInteger(
        context.maxPassages,
        DEFAULT_CONFIG.context.maxPassages,
        1,
        20,
        "context.maxPassages",
        warnings,
      ),
      timeoutMs: readInteger(
        context.timeoutMs,
        DEFAULT_CONFIG.context.timeoutMs,
        50,
        30_000,
        "context.timeoutMs",
        warnings,
      ),
    },
    prjdocs: {
      maxTargets: readInteger(
        prjdocs.maxTargets,
        DEFAULT_CONFIG.prjdocs.maxTargets,
        1,
        500,
        "prjdocs.maxTargets",
        warnings,
      ),
      maxPages: readInteger(
        prjdocs.maxPages,
        DEFAULT_CONFIG.prjdocs.maxPages,
        0,
        500,
        "prjdocs.maxPages",
        warnings,
      ),
      eager: readBoolean(
        prjdocs.eager,
        DEFAULT_CONFIG.prjdocs.eager,
        "prjdocs.eager",
        warnings,
      ),
      eagerMaxPages: readInteger(
        prjdocs.eagerMaxPages,
        DEFAULT_CONFIG.prjdocs.eagerMaxPages,
        1,
        5000,
        "prjdocs.eagerMaxPages",
        warnings,
      ),
      eagerMaxDepth: readInteger(
        prjdocs.eagerMaxDepth,
        DEFAULT_CONFIG.prjdocs.eagerMaxDepth,
        1,
        100,
        "prjdocs.eagerMaxDepth",
        warnings,
      ),
      eagerModelCalls: readInteger(
        prjdocs.eagerModelCalls,
        DEFAULT_CONFIG.prjdocs.eagerModelCalls,
        0,
        5000,
        "prjdocs.eagerModelCalls",
        warnings,
      ),
      eagerKeywords: readStringList(
        prjdocs.eagerKeywords,
        "prjdocs.eagerKeywords",
        warnings,
      ),
      builtin: readBoolean(
        prjdocs.builtin,
        DEFAULT_CONFIG.prjdocs.builtin,
        "prjdocs.builtin",
        warnings,
      ),
      builtinXerjPages: readInteger(
        prjdocs.builtinXerjPages,
        DEFAULT_CONFIG.prjdocs.builtinXerjPages,
        0,
        2000,
        "prjdocs.builtinXerjPages",
        warnings,
      ),
      builtinElasticsearchPages: readInteger(
        prjdocs.builtinElasticsearchPages,
        DEFAULT_CONFIG.prjdocs.builtinElasticsearchPages,
        0,
        5000,
        "prjdocs.builtinElasticsearchPages",
        warnings,
      ),
      builtinRefreshDays: readInteger(
        prjdocs.builtinRefreshDays,
        DEFAULT_CONFIG.prjdocs.builtinRefreshDays,
        0,
        365,
        "prjdocs.builtinRefreshDays",
        warnings,
      ),
    },
    sysdocs: {
      maxDocs: readInteger(
        sysdocs.maxDocs,
        DEFAULT_CONFIG.sysdocs.maxDocs,
        1,
        100_000,
        "sysdocs.maxDocs",
        warnings,
      ),
      maxBytesPerDoc: readInteger(
        sysdocs.maxBytesPerDoc,
        DEFAULT_CONFIG.sysdocs.maxBytesPerDoc,
        512,
        10 * 1024 ** 2,
        "sysdocs.maxBytesPerDoc",
        warnings,
      ),
      manDirs: readStringList(sysdocs.manDirs, "sysdocs.manDirs", warnings),
      infoDirs: readStringList(sysdocs.infoDirs, "sysdocs.infoDirs", warnings),
    },
    memory: {
      enabled: readBoolean(memory.enabled, DEFAULT_CONFIG.memory.enabled, "memory.enabled", warnings),
      captureTurns: readBoolean(
        memory.captureTurns,
        DEFAULT_CONFIG.memory.captureTurns,
        "memory.captureTurns",
        warnings,
      ),
      retain: {
        days: readInteger(
          retain.days,
          DEFAULT_CONFIG.memory.retain.days,
          0,
          3_650,
          "memory.retain.days",
          warnings,
        ),
        maxCount: readInteger(
          retain.maxCount,
          DEFAULT_CONFIG.memory.retain.maxCount,
          0,
          100_000,
          "memory.retain.maxCount",
          warnings,
        ),
        maxBytes: readInteger(
          retain.maxBytes,
          DEFAULT_CONFIG.memory.retain.maxBytes,
          0,
          10_000_000_000,
          "memory.retain.maxBytes",
          warnings,
        ),
      },
    },
    stats: {
      enabled: readBoolean(stats.enabled, DEFAULT_CONFIG.stats.enabled, "stats.enabled", warnings),
      bytesPerToken: readInteger(
        stats.bytesPerToken,
        DEFAULT_CONFIG.stats.bytesPerToken,
        1,
        100,
        "stats.bytesPerToken",
        warnings,
      ),
      maxBaselineBytes: readInteger(
        stats.maxBaselineBytes,
        DEFAULT_CONFIG.stats.maxBaselineBytes,
        0,
        Number.MAX_SAFE_INTEGER,
        "stats.maxBaselineBytes",
        warnings,
      ),
    },
    telemetry: {
      anomaly: readBoolean(
        telemetry.anomaly,
        DEFAULT_CONFIG.telemetry.anomaly,
        "telemetry.anomaly",
        warnings,
      ),
    },
  };

  return { config, warnings };
}

function asObject(value: unknown): Raw {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Raw;
}

function readVersion(value: unknown, warnings: string[]): string {
  if (value === undefined) return DEFAULT_CONFIG.binary.version;
  if (typeof value !== "string") {
    warnings.push("binary.version must be a string; using auto");
    return DEFAULT_CONFIG.binary.version;
  }

  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "auto") return "auto";
  if (!/^v?\d+\.\d+\.\d+/.test(trimmed)) {
    warnings.push(`binary.version "${trimmed}" is not a version; using auto`);
    return "auto";
  }

  return trimmed.replace(/^v/, "");
}

/** A release triple, e.g. `aarch64-apple-darwin`. Invalid values fall back to
 * host detection rather than failing plugin load. */
function readTarget(value: unknown, warnings: string[]): string | null {
  const target = readString(value, null);
  if (target === null) return null;
  if (!/^(x86_64|aarch64)-[a-z0-9-]+$/.test(target)) {
    warnings.push(`binary.target "${target}" is not a release triple; using host detection`);
    return null;
  }
  return target;
}

function readLibc(value: unknown, warnings: string[]): Libc {
  if (value === undefined) return DEFAULT_CONFIG.binary.libc;
  if (value === "musl" || value === "gnu") return value;
  warnings.push(`binary.libc must be "musl" or "gnu"; using ${DEFAULT_CONFIG.binary.libc}`);
  return DEFAULT_CONFIG.binary.libc;
}

/** A list of non-empty strings; anything else is dropped with a warning. */
function readStringList(value: unknown, name: string, warnings: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push(`${name} must be a list of strings`);
    return [];
  }

  const kept = value.filter((entry): entry is string => typeof entry === "string");
  if (kept.length !== value.length) warnings.push(`${name} dropped non-string entries`);
  return kept.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function readPriority(value: unknown, warnings: string[]): NodePriority {
  const fallback = DEFAULT_CONFIG.node.priority;
  if (value === undefined) return fallback;
  const found = Object.values(NodePriority).find((priority) => priority === value);
  if (found !== undefined) return found;
  warnings.push(
    `node.priority must be one of ${Object.values(NodePriority).join(", ")}; using ${fallback}`,
  );
  return fallback;
}

function readCpuSpec(value: unknown, warnings: string[]): CpuSpec | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    warnings.push("node.cpus must be a string; leaving CPU affinity unchanged");
    return null;
  }

  const parsed = parseCpuSpec(value);
  if (parsed.error !== null) {
    warnings.push(
      `node.cpus is invalid (${parsed.error}); leaving CPU affinity unchanged`,
    );
    return null;
  }
  return parsed.spec;
}

function readBoolean(value: unknown, fallback: boolean, key: string, warnings: string[]): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  warnings.push(`${key} must be a boolean; using ${fallback}`);
  return fallback;
}

function readString(value: unknown, fallback: string | null): string | null {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed === "" ? fallback : trimmed;
}

function readInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  key: string,
  warnings: string[],
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    warnings.push(`${key} must be an integer; using ${fallback}`);
    return fallback;
  }

  if (value < min || value > max) {
    const clamped = Math.min(max, Math.max(min, value));
    warnings.push(`${key} must be between ${min} and ${max}; using ${clamped}`);
    return clamped;
  }

  return value;
}

function readOptionalInteger(
  value: unknown,
  min: number,
  max: number,
  key: string,
  warnings: string[],
): number | null {
  if (value === undefined || value === null) return null;
  return readInteger(value, min, min, max, key, warnings);
}

function readStringArray(value: unknown, key: string, warnings: string[]): ReadonlyArray<string> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push(`${key} must be an array of strings; using []`);
    return [];
  }

  const entries = value.filter((entry): entry is string => typeof entry === "string");
  if (entries.length !== value.length) warnings.push(`${key} contains non-string entries; ignoring them`);
  return entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}
