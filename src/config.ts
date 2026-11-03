import type { Libc } from "./platform.ts";

// Plugin options. Every field has a default, unknown keys are ignored, and a
// malformed value falls back to the default with a warning instead of failing
// plugin load. A search plugin that refuses to start because one option is a
// string instead of a number is worse than one that starts with defaults.

export interface BinaryOptions {
  /** "auto" tracks the latest release; anything else pins a version. */
  readonly version: string;
  /** Explicit binary path; skips download and upgrade entirely. */
  readonly path: string | null;
  /** Explicit release triple; overrides host detection. Mostly for CI. */
  readonly target: string | null;
  /** Linux C library flavour of the downloaded build. */
  readonly libc: Libc;
}

export interface NodeOptions {
  /** Attach to an existing node instead of spawning one. */
  readonly url: string | null;
  /** Preferred ES-compatible port; the supervisor may advance it. */
  readonly port: number;
  readonly dataDir: string | null;
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
  readonly maxPassages: number;
  readonly timeoutMs: number;
}

export interface MemoryOptions {
  readonly enabled: boolean;
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

export interface Config {
  readonly binary: BinaryOptions;
  readonly node: NodeOptions;
  readonly index: IndexOptions;
  readonly remote: RemoteOptions;
  readonly context: ContextOptions;
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
  node: { url: null, port: 9200, dataDir: null },
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
    maxBytes: 2 * 1024 ** 3,
    maxMinutes: 10,
  },
  remote: { enabled: true, maxBytes: 2_000_000 },
  context: {
    enabled: true,
    maxTokens: 1500,
    memoryTokens: 400,
    maxPassages: 4,
    timeoutMs: 400,
  },
  memory: { enabled: true },
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
  const node = asObject(root.node);
  const index = asObject(root.index);
  const remote = asObject(root.remote);
  const context = asObject(root.context);
  const memory = asObject(root.memory);
  const stats = asObject(root.stats);
  const telemetry = asObject(root.telemetry);

  const envUrl = env.XERJ_URL?.trim();

  const config: Config = {
    binary: {
      version: readVersion(binary.version, warnings),
      path: readString(binary.path, null),
      target: readTarget(binary.target, warnings),
      libc: readLibc(binary.libc, warnings),
    },
    node: {
      url: readString(node.url, null) ?? (envUrl ? envUrl : null),
      port: readInteger(node.port, DEFAULT_CONFIG.node.port, 1, 65_535, "node.port", warnings),
      dataDir: readString(node.dataDir, null),
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
      semantic: readBoolean(
        index.semantic,
        DEFAULT_CONFIG.index.semantic,
        "index.semantic",
        warnings,
      ),
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
    memory: {
      enabled: readBoolean(memory.enabled, DEFAULT_CONFIG.memory.enabled, "memory.enabled", warnings),
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
