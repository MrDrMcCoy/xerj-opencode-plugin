import {
  formatCpuSpec,
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
  /** Deadline for host detection commands such as `sysctl`. */
  readonly detectTimeoutMs: number;
  /** Deadline for the archive download and every local command it runs. */
  readonly commandTimeoutMs: number;
  /** Deadline for release metadata and checksum requests. */
  readonly requestTimeoutMs: number;
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
   * CPUs every XERJ process may use: indices and ranges, `odd` (the default),
   * `even`, a percentage of the available CPUs, or `null`/`all` for no
   * affinity change.
   */
  readonly cpus: CpuSpec | null;
  /** Preferred ES-compatible port; the supervisor may advance it. */
  readonly port: number;
  readonly dataDir: string | null;
  /** Stop this project's node when nothing has used it for this long. */
  readonly idleMs: number;
  /** Set false to keep the node running after the last session goes quiet. */
  readonly shutdownOnIdle: boolean;
  /** Deadline for a read or search request to this node. */
  readonly clientTimeoutMs: number;
  /**
   * Deadline for a write. A semantic write embeds before it acknowledges, so
   * this is far longer than a read.
   */
  readonly writeTimeoutMs: number;
  /** Deadline for one `GET /` health probe. */
  readonly probeTimeoutMs: number;
  /** How long a spawn waits for the node to answer. */
  readonly startupTimeoutMs: number;
  /** How long a stop waits after SIGTERM before SIGKILL. */
  readonly stopGraceMs: number;
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
  /** Deadline for fetching a URL through `xerj_index`. */
  readonly fetchTimeoutMs: number;
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
  /** Deadline for one retrieval; a miss injects nothing. */
  readonly timeoutMs: number;
  /** Deadline for re-reading the working set after a compaction. */
  readonly recallTimeoutMs: number;
  /** Deadline for the one-line search hint when the gate rejects a prompt. */
  readonly hintTimeoutMs: number;
  /** Project notes surfaced when a prompt matches their conditions. */
  readonly notes: NoteOptions;
}

export interface NoteOptions {
  readonly enabled: boolean;
  /** Characters of one injected note. */
  readonly maxChars: number;
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
  /** Deadline for one documentation page request. */
  readonly requestTimeoutMs: number;
  /** Deadline for one latest-release lookup. */
  readonly latestTimeoutMs: number;
  /** `User-Agent` sent with every documentation request. */
  readonly userAgent: string;
  /** Minimum gap between two requests to one documentation host. */
  readonly requestIntervalMs: number;
  /** Random extra delay added to that gap. */
  readonly requestJitterMs: number;
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
  /** Days an automatic summary is kept; 0 (the default) means unlimited. */
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
  /** Turn live context into typed memories, and retire what stops being true. */
  readonly distill: DistillOptions;
  /** Mine the pre-compaction window for durable facts. */
  readonly extract: ExtractOptions;
  /** The idle child session that curates memory and writes a primer. */
  readonly dreamer: DreamerOptions;
}

export interface DreamerOptions {
  readonly enabled: boolean;
  /** `provider/model`, or null to inherit the parent session's model. */
  readonly model: string | null;
  /** Minimum time between dreamer runs, per project. */
  readonly intervalMs: number;
  /** Quiet time after a session idles before the dreamer starts. */
  readonly idleMs: number;
  /** Tool calls the child is asked to stay within. */
  readonly maxTurns: number;
  /** Answer budget the child is asked to stay within. */
  readonly maxTokens: number;
}

export interface ExtractOptions {
  readonly enabled: boolean;
  /** Facts promoted from one window. */
  readonly maxFacts: number;
  /** Bytes of window text read before extraction. */
  readonly maxBytes: number;
}

export interface DistillOptions {
  readonly enabled: boolean;
  /**
   * `local` (the default) runs the downloaded jevos CPU model; `heuristic`
   * is the cheap local filter; `model` asks the current model to judge a
   * candidate, which needs a host model.
   */
  readonly judge: "heuristic" | "model" | "local";
  /** Minimum score a candidate needs to become a memory, as a percentage. */
  readonly minConfidence: number;
  /** Candidates promoted from one turn. */
  readonly maxPerTurn: number;
  /** Distilled memories kept in the project before the oldest go. */
  readonly maxPerProject: number;
  /** Model calls one turn may spend; only with `judge: "model"`. */
  readonly modelMaxCalls: number;
  /** Characters of the turn shown to the model judge. */
  readonly modelContextChars: number;
  /** Deadline for one model judgement. */
  readonly modelTimeoutMs: number;
  /** The local jevos decision model. */
  readonly local: LocalJudgeOptions;
}

export interface LocalJudgeOptions {
  /** Release tag, for example `jevos-v5`. */
  readonly version: string;
  /** A pre-installed directory holding `bin/jev` and `model/`. */
  readonly path: string | null;
  readonly port: number;
  /** Worker threads; 0 uses every logical CPU. */
  readonly threads: number;
  /** Stop the server after this long without a judgement. */
  readonly idleMs: number;
  /** Deadline for one judgement request. */
  readonly timeoutMs: number;
  /** P(keep) floor, as a percentage. */
  readonly threshold: number;
  /** Choice confidence floor, as a percentage. */
  readonly kindConfidence: number;
  /** Deadline for the one-time 630 MB model download. */
  readonly downloadTimeoutMs: number;
  /** Deadline for the server to answer its first health probe. */
  readonly startupTimeoutMs: number;
  /** Periodic calibration of the keep floor. */
  readonly autotune: LocalAutotuneOptions;
}

export interface LocalAutotuneOptions {
  readonly enabled: boolean;
  /** Time between calibration passes. */
  readonly intervalMs: number;
  /** Delay after setup before the first pass. */
  readonly initialDelayMs: number;
  /** F1 points a candidate needs over the active floor, as a percentage. */
  readonly margin: number;
  /** Answered samples a pass needs before it can decide. */
  readonly minSamples: number;
}

export interface StatsOptions {
  readonly enabled: boolean;
  readonly bytesPerToken: number;
  /** Baseline credited per cited file; a lockfile should not count as 700 KB. */
  readonly maxBaselineBytes: number;
}

/** Command output kept under `<storage root>/cmd/` and indexed cheaply. */
export interface CmdOptions {
  readonly enabled: boolean;
  /** Teach the model about `xerj_run` and `xerj_out` in the context block. */
  readonly suggest: boolean;
  /** Record host bash/shell results, not only commands run through the tool. */
  readonly mirrorHostResults: boolean;
  /** Include the command corpus in prompt-time injection. */
  readonly inject: boolean;
  /** Cap for the two files of every command together. */
  readonly maxBytes: number;
  /** Cap for the indexed text across the corpus. */
  readonly maxIndexBytes: number;
  /** Captured per command before the runner truncates. */
  readonly maxCommandBytes: number;
  /** One file past this is stored but not parsed. */
  readonly maxFileBytes: number;
  readonly windowLines: number;
  readonly windowBytes: number;
  /** Approximate output budget for one `show`. */
  readonly showTokens: number;
  /** Deadline for one `xerj_run` command. */
  readonly timeoutMs: number;
  /** A mirrored result past this many lines queues a hint for the next turn. */
  readonly hintLines: number;
}

export interface TelemetryOptions {
  readonly anomaly: boolean;
  /** Local operation records; nothing is ever sent anywhere. */
  readonly enabled: boolean;
  /** Cap for the whole telemetry directory, in bytes. */
  readonly maxBytes: number;
  /** Samples kept per operation type. */
  readonly samplesPerType: number;
  /** Size at which `ops.ndjson` rotates. */
  readonly rotateBytes: number;
  /** Rotated operation files kept. */
  readonly rotations: number;
  /** Queue drain period. */
  readonly flushMs: number;
  /** CPU and RSS sample period; 0 disables sampling. */
  readonly sampleMs: number;
  /** Characters of caller text kept; 0 records none. */
  readonly maxText: number;
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
  readonly cmd: CmdOptions;
  readonly hub: HubOptions;
  readonly analysis: AnalysisOptions;
  readonly code: CodeOptions;
  readonly share: ShareOptions;
}

export interface CodeOptions {
  /** Register xerj_code. Off by default. */
  readonly enabled: boolean;
  /** Allow `corpus add` to clone git URLs. */
  readonly network: boolean;
  readonly timeoutMs: number;
  readonly maxResults: number;
  readonly maxPassageChars: number;
}

export interface ShareOptions {
  /** Register xerj_share. Off by default. */
  readonly enabled: boolean;
  readonly expires: string;
  readonly maxClaims: number;
  readonly timeoutMs: number;
}

export interface AnalysisOptions {
  readonly treeSitter: TreeSitterOptions;
  readonly lsp: LspOptions;
}

export interface LspOptions {
  /** Register the language-server tools and start servers. Off by default. */
  readonly enabled: boolean;
  /** Language id to command; empty means detect and auto-resolve. */
  readonly servers: Readonly<Record<string, string | ReadonlyArray<string>>>;
  /** Install a missing pinned server into the plugin cache. */
  readonly autoInstall: boolean;
  /** Stop a server that answered nothing for this long. */
  readonly idleMs: number;
  /** Concurrent servers across languages. */
  readonly maxServers: number;
  /** Deadline for one language-server request. */
  readonly timeoutMs: number;
}

export interface TreeSitterOptions {
  /** Register the structural tools and parse project files. Off by default. */
  readonly enabled: boolean;
  /** Empty means detect from the project's extensions. */
  readonly languages: ReadonlyArray<string>;
  /** Files above this are skipped. */
  readonly maxParseBytes: number;
}

export interface HubOptions {
  /** Register xerj_ask and xerj_hub. Off by default. */
  readonly enabled: boolean;
  /** Allow pack and catalogue downloads. Cached packs answer when false. */
  readonly network: boolean;
  /** May a question be sent to the hosted hub? */
  readonly hosted: "off" | "auto" | "on";
  /** Catalogue base URL; the trust key stays the one in the binary. */
  readonly url: string;
  /** Answer cap passed to xerj ask. */
  readonly maxTokens: number;
  /** Deadline for one hub command. */
  readonly timeoutMs: number;
}

export interface LoadedConfig {
  readonly config: Config;
  readonly warnings: ReadonlyArray<string>;
}

export const DEFAULT_CONFIG: Config = {
  binary: {
    version: "auto",
    path: null,
    target: null,
    libc: "musl",
    detectTimeoutMs: 2_000,
    commandTimeoutMs: 60_000,
    requestTimeoutMs: 10_000,
  },
  storage: { root: null },
  node: {
    url: null,
    priority: NodePriority.Low,
    cpus: { kind: "odd" },
    logMaxBytes: 8 * 1024 ** 2,
    port: 9200,
    dataDir: null,
    idleMs: 1_800_000,
    shutdownOnIdle: false,
    clientTimeoutMs: 5_000,
    writeTimeoutMs: 120_000,
    probeTimeoutMs: 800,
    startupTimeoutMs: 30_000,
    stopGraceMs: 5_000,
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
  remote: { enabled: true, maxBytes: 2_000_000, fetchTimeoutMs: 10_000 },
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
    recallTimeoutMs: 120,
    hintTimeoutMs: 150,
    notes: { enabled: true, maxChars: 400 },
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
    requestTimeoutMs: 15_000,
    latestTimeoutMs: 5_000,
    userAgent:
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    requestIntervalMs: 250,
    requestJitterMs: 100,
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
    retain: { days: 0, maxCount: 0, maxBytes: 2 * 1024 ** 3 },
    distill: {
      enabled: true,
      judge: "local",
      minConfidence: 55,
      maxPerTurn: 3,
      maxPerProject: 200,
      modelMaxCalls: 3,
      modelContextChars: 1_200,
      modelTimeoutMs: 4_000,
      local: {
        version: "jevos-v5",
        path: null,
        port: 8017,
        threads: 0,
        idleMs: 600_000,
        timeoutMs: 5_000,
        threshold: 20,
        kindConfidence: 40,
        downloadTimeoutMs: 900_000,
        startupTimeoutMs: 120_000,
        autotune: {
          enabled: true,
          intervalMs: 86_400_000,
          initialDelayMs: 600_000,
          margin: 5,
          minSamples: 12,
        },
      },
    },
    extract: {
      enabled: true,
      maxFacts: 3,
      maxBytes: 200 * 1024,
    },
    dreamer: {
      enabled: true,
      model: null,
      intervalMs: 86_400_000,
      idleMs: 600_000,
      maxTurns: 3,
      maxTokens: 4_000,
    },
  },
  stats: { enabled: true, bytesPerToken: 4, maxBaselineBytes: 128 * 1024 },
  analysis: {
    treeSitter: {
      enabled: true,
      languages: [],
      maxParseBytes: 1_048_576,
    },
    lsp: {
      enabled: true,
      servers: {},
      autoInstall: true,
      idleMs: 300_000,
      maxServers: 2,
      timeoutMs: 2_000,
    },
  },
  code: {
    enabled: true,
    network: false,
    timeoutMs: 600_000,
    maxResults: 8,
    maxPassageChars: 1_200,
  },
  share: {
    enabled: false,
    expires: "24h",
    maxClaims: 1,
    timeoutMs: 30_000,
  },
  hub: {
    enabled: true,
    network: true,
    hosted: "off",
    url: "https://hub.xerj.org",
    maxTokens: 1_200,
    timeoutMs: 120_000,
  },
  cmd: {
    enabled: true,
    suggest: true,
    mirrorHostResults: true,
    inject: true,
    maxBytes: 256 * 1024 ** 2,
    maxIndexBytes: 32 * 1024 ** 2,
    maxCommandBytes: 64 * 1024 ** 2,
    maxFileBytes: 32 * 1024 ** 2,
    windowLines: 200,
    windowBytes: 16 * 1024,
    showTokens: 1200,
    timeoutMs: 600_000,
    hintLines: 40,
  },
  telemetry: {
    anomaly: true,
    enabled: true,
    maxBytes: 128 * 1024 ** 2,
    samplesPerType: 256,
    rotateBytes: 8 * 1024 ** 2,
    rotations: 4,
    flushMs: 5_000,
    sampleMs: 15_000,
    maxText: 160,
  },
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
  const distill = asObject(memory.distill);
  const local = asObject(distill.local);
  const tune = asObject(local.autotune);
  const extract = asObject(memory.extract);
  const dreamer = asObject(memory.dreamer);
  const notes = asObject(context.notes);
  const stats = asObject(root.stats);
  const telemetry = asObject(root.telemetry);
  const cmd = asObject(root.cmd);
  const hub = asObject(root.hub);
  const analysis = asObject(root.analysis);
  const treeSitter = asObject(analysis.treeSitter);
  const lsp = asObject(analysis.lsp);
  const code = asObject(root.code);
  const share = asObject(root.share);

  const envUrl = env.XERJ_URL?.trim();

  const config: Config = {
    storage: { root: readString(storage.root, null) },
    binary: {
      version: readVersion(binary.version, warnings),
      path: readString(binary.path, null),
      target: readTarget(binary.target, warnings),
      libc: readLibc(binary.libc, warnings),
      detectTimeoutMs: readInteger(
        binary.detectTimeoutMs,
        DEFAULT_CONFIG.binary.detectTimeoutMs,
        100,
        60_000,
        "binary.detectTimeoutMs",
        warnings,
      ),
      commandTimeoutMs: readInteger(
        binary.commandTimeoutMs,
        DEFAULT_CONFIG.binary.commandTimeoutMs,
        1_000,
        3_600_000,
        "binary.commandTimeoutMs",
        warnings,
      ),
      requestTimeoutMs: readInteger(
        binary.requestTimeoutMs,
        DEFAULT_CONFIG.binary.requestTimeoutMs,
        1_000,
        600_000,
        "binary.requestTimeoutMs",
        warnings,
      ),
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
      clientTimeoutMs: readInteger(
        node.clientTimeoutMs,
        DEFAULT_CONFIG.node.clientTimeoutMs,
        100,
        600_000,
        "node.clientTimeoutMs",
        warnings,
      ),
      writeTimeoutMs: readInteger(
        node.writeTimeoutMs,
        DEFAULT_CONFIG.node.writeTimeoutMs,
        1_000,
        3_600_000,
        "node.writeTimeoutMs",
        warnings,
      ),
      probeTimeoutMs: readInteger(
        node.probeTimeoutMs,
        DEFAULT_CONFIG.node.probeTimeoutMs,
        50,
        60_000,
        "node.probeTimeoutMs",
        warnings,
      ),
      startupTimeoutMs: readInteger(
        node.startupTimeoutMs,
        DEFAULT_CONFIG.node.startupTimeoutMs,
        1_000,
        600_000,
        "node.startupTimeoutMs",
        warnings,
      ),
      stopGraceMs: readInteger(
        node.stopGraceMs,
        DEFAULT_CONFIG.node.stopGraceMs,
        0,
        120_000,
        "node.stopGraceMs",
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
      fetchTimeoutMs: readInteger(
        remote.fetchTimeoutMs,
        DEFAULT_CONFIG.remote.fetchTimeoutMs,
        1_000,
        600_000,
        "remote.fetchTimeoutMs",
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
      recallTimeoutMs: readInteger(
        context.recallTimeoutMs,
        DEFAULT_CONFIG.context.recallTimeoutMs,
        10,
        30_000,
        "context.recallTimeoutMs",
        warnings,
      ),
      hintTimeoutMs: readInteger(
        context.hintTimeoutMs,
        DEFAULT_CONFIG.context.hintTimeoutMs,
        10,
        30_000,
        "context.hintTimeoutMs",
        warnings,
      ),
      notes: {
        enabled: readBoolean(
          notes.enabled,
          DEFAULT_CONFIG.context.notes.enabled,
          "context.notes.enabled",
          warnings,
        ),
        maxChars: readInteger(
          notes.maxChars,
          DEFAULT_CONFIG.context.notes.maxChars,
          40,
          2_000,
          "context.notes.maxChars",
          warnings,
        ),
      },
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
      requestTimeoutMs: readInteger(
        prjdocs.requestTimeoutMs,
        DEFAULT_CONFIG.prjdocs.requestTimeoutMs,
        1_000,
        600_000,
        "prjdocs.requestTimeoutMs",
        warnings,
      ),
      latestTimeoutMs: readInteger(
        prjdocs.latestTimeoutMs,
        DEFAULT_CONFIG.prjdocs.latestTimeoutMs,
        500,
        120_000,
        "prjdocs.latestTimeoutMs",
        warnings,
      ),
      userAgent: readString(
        prjdocs.userAgent,
        DEFAULT_CONFIG.prjdocs.userAgent,
      ) as string,
      requestIntervalMs: readInteger(
        prjdocs.requestIntervalMs,
        DEFAULT_CONFIG.prjdocs.requestIntervalMs,
        0,
        60_000,
        "prjdocs.requestIntervalMs",
        warnings,
      ),
      requestJitterMs: readInteger(
        prjdocs.requestJitterMs,
        DEFAULT_CONFIG.prjdocs.requestJitterMs,
        0,
        30_000,
        "prjdocs.requestJitterMs",
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
      distill: {
        enabled: readBoolean(
          distill.enabled,
          DEFAULT_CONFIG.memory.distill.enabled,
          "memory.distill.enabled",
          warnings,
        ),
        judge: readJudge(distill.judge, warnings),
        minConfidence: readInteger(
          distill.minConfidence,
          DEFAULT_CONFIG.memory.distill.minConfidence,
          0,
          100,
          "memory.distill.minConfidence",
          warnings,
        ),
        maxPerTurn: readInteger(
          distill.maxPerTurn,
          DEFAULT_CONFIG.memory.distill.maxPerTurn,
          1,
          50,
          "memory.distill.maxPerTurn",
          warnings,
        ),
        maxPerProject: readInteger(
          distill.maxPerProject,
          DEFAULT_CONFIG.memory.distill.maxPerProject,
          10,
          100_000,
          "memory.distill.maxPerProject",
          warnings,
        ),
        modelMaxCalls: readInteger(
          distill.modelMaxCalls,
          DEFAULT_CONFIG.memory.distill.modelMaxCalls,
          0,
          50,
          "memory.distill.modelMaxCalls",
          warnings,
        ),
        modelContextChars: readInteger(
          distill.modelContextChars,
          DEFAULT_CONFIG.memory.distill.modelContextChars,
          200,
          20_000,
          "memory.distill.modelContextChars",
          warnings,
        ),
        modelTimeoutMs: readInteger(
          distill.modelTimeoutMs,
          DEFAULT_CONFIG.memory.distill.modelTimeoutMs,
          500,
          60_000,
          "memory.distill.modelTimeoutMs",
          warnings,
        ),
        local: {
          version:
            readString(
              local.version,
              DEFAULT_CONFIG.memory.distill.local.version,
            ) ?? "jevos-v5",
          path: readString(local.path, null),
          port: readInteger(
            local.port,
            DEFAULT_CONFIG.memory.distill.local.port,
            1024,
            65_535,
            "memory.distill.local.port",
            warnings,
          ),
          threads: readInteger(
            local.threads,
            DEFAULT_CONFIG.memory.distill.local.threads,
            0,
            256,
            "memory.distill.local.threads",
            warnings,
          ),
          idleMs: readInteger(
            local.idleMs,
            DEFAULT_CONFIG.memory.distill.local.idleMs,
            0,
            86_400_000,
            "memory.distill.local.idleMs",
            warnings,
          ),
          timeoutMs: readInteger(
            local.timeoutMs,
            DEFAULT_CONFIG.memory.distill.local.timeoutMs,
            100,
            120_000,
            "memory.distill.local.timeoutMs",
            warnings,
          ),
          threshold: readInteger(
            local.threshold,
            DEFAULT_CONFIG.memory.distill.local.threshold,
            0,
            100,
            "memory.distill.local.threshold",
            warnings,
          ),
          kindConfidence: readInteger(
            local.kindConfidence,
            DEFAULT_CONFIG.memory.distill.local.kindConfidence,
            0,
            100,
            "memory.distill.local.kindConfidence",
            warnings,
          ),
          downloadTimeoutMs: readInteger(
            local.downloadTimeoutMs,
            DEFAULT_CONFIG.memory.distill.local.downloadTimeoutMs,
            60_000,
            86_400_000,
            "memory.distill.local.downloadTimeoutMs",
            warnings,
          ),
          startupTimeoutMs: readInteger(
            local.startupTimeoutMs,
            DEFAULT_CONFIG.memory.distill.local.startupTimeoutMs,
            1_000,
            600_000,
            "memory.distill.local.startupTimeoutMs",
            warnings,
          ),
          autotune: {
            enabled: readBoolean(
              tune.enabled,
              DEFAULT_CONFIG.memory.distill.local.autotune.enabled,
              "memory.distill.local.autotune.enabled",
              warnings,
            ),
            intervalMs: readInteger(
              tune.intervalMs,
              DEFAULT_CONFIG.memory.distill.local.autotune.intervalMs,
              3_600_000,
              604_800_000,
              "memory.distill.local.autotune.intervalMs",
              warnings,
            ),
            initialDelayMs: readInteger(
              tune.initialDelayMs,
              DEFAULT_CONFIG.memory.distill.local.autotune.initialDelayMs,
              0,
              86_400_000,
              "memory.distill.local.autotune.initialDelayMs",
              warnings,
            ),
            margin: readInteger(
              tune.margin,
              DEFAULT_CONFIG.memory.distill.local.autotune.margin,
              0,
              50,
              "memory.distill.local.autotune.margin",
              warnings,
            ),
            minSamples: readInteger(
              tune.minSamples,
              DEFAULT_CONFIG.memory.distill.local.autotune.minSamples,
              2,
              200,
              "memory.distill.local.autotune.minSamples",
              warnings,
            ),
          },
        },
      },
      dreamer: {
        enabled: readBoolean(
          dreamer.enabled,
          DEFAULT_CONFIG.memory.dreamer.enabled,
          "memory.dreamer.enabled",
          warnings,
        ),
        model: readDreamerModel(dreamer.model, warnings),
        intervalMs: readInteger(
          dreamer.intervalMs,
          DEFAULT_CONFIG.memory.dreamer.intervalMs,
          60_000,
          30 * 86_400_000,
          "memory.dreamer.intervalMs",
          warnings,
        ),
        idleMs: readInteger(
          dreamer.idleMs,
          DEFAULT_CONFIG.memory.dreamer.idleMs,
          0,
          86_400_000,
          "memory.dreamer.idleMs",
          warnings,
        ),
        maxTurns: readInteger(
          dreamer.maxTurns,
          DEFAULT_CONFIG.memory.dreamer.maxTurns,
          1,
          20,
          "memory.dreamer.maxTurns",
          warnings,
        ),
        maxTokens: readInteger(
          dreamer.maxTokens,
          DEFAULT_CONFIG.memory.dreamer.maxTokens,
          200,
          32_000,
          "memory.dreamer.maxTokens",
          warnings,
        ),
      },
      extract: {
        enabled: readBoolean(
          extract.enabled,
          DEFAULT_CONFIG.memory.extract.enabled,
          "memory.extract.enabled",
          warnings,
        ),
        maxFacts: readInteger(
          extract.maxFacts,
          DEFAULT_CONFIG.memory.extract.maxFacts,
          1,
          20,
          "memory.extract.maxFacts",
          warnings,
        ),
        maxBytes: readInteger(
          extract.maxBytes,
          DEFAULT_CONFIG.memory.extract.maxBytes,
          1_024,
          1_048_576,
          "memory.extract.maxBytes",
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
    code: {
      enabled: readBoolean(
        code.enabled,
        DEFAULT_CONFIG.code.enabled,
        "code.enabled",
        warnings,
      ),
      network: readBoolean(
        code.network,
        DEFAULT_CONFIG.code.network,
        "code.network",
        warnings,
      ),
      timeoutMs: readInteger(
        code.timeoutMs,
        DEFAULT_CONFIG.code.timeoutMs,
        5_000,
        3_600_000,
        "code.timeoutMs",
        warnings,
      ),
      maxResults: readInteger(
        code.maxResults,
        DEFAULT_CONFIG.code.maxResults,
        1,
        50,
        "code.maxResults",
        warnings,
      ),
      maxPassageChars: readInteger(
        code.maxPassageChars,
        DEFAULT_CONFIG.code.maxPassageChars,
        0,
        20_000,
        "code.maxPassageChars",
        warnings,
      ),
    },
    share: {
      enabled: readBoolean(
        share.enabled,
        DEFAULT_CONFIG.share.enabled,
        "share.enabled",
        warnings,
      ),
      expires:
        readString(share.expires, DEFAULT_CONFIG.share.expires)?.trim() ??
        DEFAULT_CONFIG.share.expires,
      maxClaims: readInteger(
        share.maxClaims,
        DEFAULT_CONFIG.share.maxClaims,
        1,
        50,
        "share.maxClaims",
        warnings,
      ),
      timeoutMs: readInteger(
        share.timeoutMs,
        DEFAULT_CONFIG.share.timeoutMs,
        5_000,
        300_000,
        "share.timeoutMs",
        warnings,
      ),
    },
    analysis: {
      lsp: {
        enabled: readBoolean(
          lsp.enabled,
          DEFAULT_CONFIG.analysis.lsp.enabled,
          "analysis.lsp.enabled",
          warnings,
        ),
        servers: readLspServers(lsp.servers, warnings),
        autoInstall: readBoolean(
          lsp.autoInstall,
          DEFAULT_CONFIG.analysis.lsp.autoInstall,
          "analysis.lsp.autoInstall",
          warnings,
        ),
        idleMs: readInteger(
          lsp.idleMs,
          DEFAULT_CONFIG.analysis.lsp.idleMs,
          60_000,
          86_400_000,
          "analysis.lsp.idleMs",
          warnings,
        ),
        maxServers: readInteger(
          lsp.maxServers,
          DEFAULT_CONFIG.analysis.lsp.maxServers,
          1,
          8,
          "analysis.lsp.maxServers",
          warnings,
        ),
        timeoutMs: readInteger(
          lsp.timeoutMs,
          DEFAULT_CONFIG.analysis.lsp.timeoutMs,
          200,
          60_000,
          "analysis.lsp.timeoutMs",
          warnings,
        ),
      },
      treeSitter: {
        enabled: readBoolean(
          treeSitter.enabled,
          DEFAULT_CONFIG.analysis.treeSitter.enabled,
          "analysis.treeSitter.enabled",
          warnings,
        ),
        languages: readStringArray(
          treeSitter.languages,
          "analysis.treeSitter.languages",
          warnings,
        ),
        maxParseBytes: readInteger(
          treeSitter.maxParseBytes,
          DEFAULT_CONFIG.analysis.treeSitter.maxParseBytes,
          1024,
          16_777_216,
          "analysis.treeSitter.maxParseBytes",
          warnings,
        ),
      },
    },
    hub: {
      enabled: readBoolean(
        hub.enabled,
        DEFAULT_CONFIG.hub.enabled,
        "hub.enabled",
        warnings,
      ),
      network: readBoolean(
        hub.network,
        DEFAULT_CONFIG.hub.network,
        "hub.network",
        warnings,
      ),
      hosted: readHosted(hub.hosted, warnings),
      url:
        readString(hub.url, DEFAULT_CONFIG.hub.url)?.trim() ||
        DEFAULT_CONFIG.hub.url,
      maxTokens: readInteger(
        hub.maxTokens,
        DEFAULT_CONFIG.hub.maxTokens,
        100,
        4_000,
        "hub.maxTokens",
        warnings,
      ),
      timeoutMs: readInteger(
        hub.timeoutMs,
        DEFAULT_CONFIG.hub.timeoutMs,
        5_000,
        600_000,
        "hub.timeoutMs",
        warnings,
      ),
    },
    cmd: {
      enabled: readBoolean(cmd.enabled, DEFAULT_CONFIG.cmd.enabled, "cmd.enabled", warnings),
      suggest: readBoolean(cmd.suggest, DEFAULT_CONFIG.cmd.suggest, "cmd.suggest", warnings),
      mirrorHostResults: readBoolean(
        cmd.mirrorHostResults,
        DEFAULT_CONFIG.cmd.mirrorHostResults,
        "cmd.mirrorHostResults",
        warnings,
      ),
      inject: readBoolean(cmd.inject, DEFAULT_CONFIG.cmd.inject, "cmd.inject", warnings),
      maxBytes: readInteger(
        cmd.maxBytes,
        DEFAULT_CONFIG.cmd.maxBytes,
        1_048_576,
        10_000_000_000,
        "cmd.maxBytes",
        warnings,
      ),
      maxIndexBytes: readInteger(
        cmd.maxIndexBytes,
        DEFAULT_CONFIG.cmd.maxIndexBytes,
        0,
        10_000_000_000,
        "cmd.maxIndexBytes",
        warnings,
      ),
      maxCommandBytes: readInteger(
        cmd.maxCommandBytes,
        DEFAULT_CONFIG.cmd.maxCommandBytes,
        65_536,
        10_000_000_000,
        "cmd.maxCommandBytes",
        warnings,
      ),
      maxFileBytes: readInteger(
        cmd.maxFileBytes,
        DEFAULT_CONFIG.cmd.maxFileBytes,
        4_096,
        10_000_000_000,
        "cmd.maxFileBytes",
        warnings,
      ),
      windowLines: readInteger(
        cmd.windowLines,
        DEFAULT_CONFIG.cmd.windowLines,
        20,
        5_000,
        "cmd.windowLines",
        warnings,
      ),
      windowBytes: readInteger(
        cmd.windowBytes,
        DEFAULT_CONFIG.cmd.windowBytes,
        1_024,
        1_048_576,
        "cmd.windowBytes",
        warnings,
      ),
      showTokens: readInteger(
        cmd.showTokens,
        DEFAULT_CONFIG.cmd.showTokens,
        100,
        20_000,
        "cmd.showTokens",
        warnings,
      ),
      timeoutMs: readInteger(
        cmd.timeoutMs,
        DEFAULT_CONFIG.cmd.timeoutMs,
        1_000,
        3_600_000,
        "cmd.timeoutMs",
        warnings,
      ),
      hintLines: readInteger(
        cmd.hintLines,
        DEFAULT_CONFIG.cmd.hintLines,
        1,
        1_000,
        "cmd.hintLines",
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
      enabled: readBoolean(
        telemetry.enabled,
        DEFAULT_CONFIG.telemetry.enabled,
        "telemetry.enabled",
        warnings,
      ),
      maxBytes: readInteger(
        telemetry.maxBytes,
        DEFAULT_CONFIG.telemetry.maxBytes,
        0,
        10_000_000_000,
        "telemetry.maxBytes",
        warnings,
      ),
      samplesPerType: readInteger(
        telemetry.samplesPerType,
        DEFAULT_CONFIG.telemetry.samplesPerType,
        8,
        10_000,
        "telemetry.samplesPerType",
        warnings,
      ),
      rotateBytes: readInteger(
        telemetry.rotateBytes,
        DEFAULT_CONFIG.telemetry.rotateBytes,
        65_536,
        10_000_000_000,
        "telemetry.rotateBytes",
        warnings,
      ),
      rotations: readInteger(
        telemetry.rotations,
        DEFAULT_CONFIG.telemetry.rotations,
        1,
        20,
        "telemetry.rotations",
        warnings,
      ),
      flushMs: readInteger(
        telemetry.flushMs,
        DEFAULT_CONFIG.telemetry.flushMs,
        100,
        60_000,
        "telemetry.flushMs",
        warnings,
      ),
      sampleMs: readInteger(
        telemetry.sampleMs,
        DEFAULT_CONFIG.telemetry.sampleMs,
        0,
        3_600_000,
        "telemetry.sampleMs",
        warnings,
      ),
      maxText: readInteger(
        telemetry.maxText,
        DEFAULT_CONFIG.telemetry.maxText,
        0,
        4_096,
        "telemetry.maxText",
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
  const fallback = DEFAULT_CONFIG.node.cpus;
  if (value === undefined) return fallback;
  // An explicit null is how a user asks for no affinity change now that the
  // default pins indexing to the odd CPUs.
  if (value === null) return null;
  if (typeof value !== "string") {
    warnings.push(
      `node.cpus must be a string; using ${formatCpuSpec(fallback)}`,
    );
    return fallback;
  }

  const parsed = parseCpuSpec(value);
  if (parsed.error !== null) {
    warnings.push(
      `node.cpus is invalid (${parsed.error}); ` +
        `using ${formatCpuSpec(fallback)}`,
    );
    return fallback;
  }
  return parsed.spec;
}

function readBoolean(value: unknown, fallback: boolean, key: string, warnings: string[]): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  warnings.push(`${key} must be a boolean; using ${fallback}`);
  return fallback;
}

function readDreamerModel(
  value: unknown,
  warnings: string[],
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.includes("/")) {
    warnings.push(
      "memory.dreamer.model must be \"provider/model\"; inheriting the session model",
    );
    return null;
  }
  return value.trim();
}

function readLspServers(
  value: unknown,
  warnings: string[],
): Readonly<Record<string, string | ReadonlyArray<string>>> {
  if (value === undefined) return DEFAULT_CONFIG.analysis.lsp.servers;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    warnings.push("analysis.lsp.servers must be an object; using {}");
    return {};
  }
  const out: Record<string, string | ReadonlyArray<string>> = {};
  for (const [language, command] of Object.entries(value as Record<string, unknown>)) {
    if (typeof command === "string" && command.trim().length > 0) {
      out[language] = command.trim();
      continue;
    }
    if (
      Array.isArray(command) &&
      command.length > 0 &&
      command.every((part) => typeof part === "string" && part.length > 0)
    ) {
      out[language] = command as string[];
      continue;
    }
    warnings.push(`analysis.lsp.servers.${language} must be a command or string array; skipped`);
  }
  return out;
}

function readHosted(
  value: unknown,
  warnings: string[],
): "off" | "auto" | "on" {
  if (value === undefined) return DEFAULT_CONFIG.hub.hosted;
  if (value === "off" || value === "auto" || value === "on") return value;
  warnings.push(
    `hub.hosted must be "off", "auto", or "on"; using ${DEFAULT_CONFIG.hub.hosted}`,
  );
  return DEFAULT_CONFIG.hub.hosted;
}

function readJudge(
  value: unknown,
  warnings: string[],
): "heuristic" | "model" | "local" {
  if (value === undefined) return DEFAULT_CONFIG.memory.distill.judge;
  if (value === "heuristic" || value === "model" || value === "local") {
    return value;
  }
  warnings.push(
    `memory.distill.judge must be "heuristic", "model", or "local"; ` +
      `using ${DEFAULT_CONFIG.memory.distill.judge}`,
  );
  return DEFAULT_CONFIG.memory.distill.judge;
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
  // `null` means "use the engine default". A typo used to fall through to
  // the minimum, which silently pins one worker instead of leaving it alone.
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value)
  ) {
    warnings.push(`${key} must be an integer; using the engine default`);
    return null;
  }
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
