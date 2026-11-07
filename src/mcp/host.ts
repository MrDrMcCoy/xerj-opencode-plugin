// Standalone host for the MCP server: no OpenCode process and no plugin
// context. Everything the tool surface needs is built here from a project
// directory and the plugin's own defaults, so any agent that speaks MCP works
// against the same index, memory, and system documentation.

import { join } from "node:path";
import { loadConfig, type Config } from "../config.ts";
import { createLogger, type Logger } from "../log.ts";
import {
  indexPrefix,
  memoryNamespace,
  nodeDataDir,
  pathHash,
  projectNodeDir,
  resolveStorageRoot,
} from "../paths.ts";
import { ensureBinary, externalBinary, type InstalledBinary } from "../binary/manager.ts";
import { detectRuntime } from "../binary/detect.ts";
import { XerjClient } from "../node/client.ts";
import { NodeRuntime } from "../node/runtime.ts";
import { EmbedMode } from "../node/supervisor.ts";
import { CorpusService } from "../index/watcher.ts";
import { SearchService } from "../search/service.ts";
import { TurnArchive } from "../archive/turns.ts";
import { MemoryStore } from "../memory/store.ts";
import { RemoteSpool } from "../remote/spool.ts";
import { AnomalyService } from "../telemetry/anomaly.ts";
import { Ledger, type LedgerSnapshot } from "../stats/ledger.ts";
import { buildTools, type ToolOptions } from "../tools/search.ts";
import { fileStorage } from "./storage.ts";
import { SysdocIndexer } from "../sysdocs/index.ts";
import { PrjdocsIndexer } from "../prjdocs/index.ts";
import { LatestVersions } from "../prjdocs/latest.ts";
import {
  externalPrefix,
  prjdocsPrefix,
  sysdocsPrefix,
  webPrefix,
} from "../paths.ts";
import { hostname } from "node:os";
import { PLUGIN_VERSION, type StatusSnapshot } from "../rpc.ts";

export interface McpHostOptions {
  /** Project to index; defaults to the working directory. */
  readonly projectRoot?: string;
  /** Attach to a running node instead of spawning one. */
  readonly nodeUrl?: string;
  readonly env?: Record<string, string | undefined>;
}

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly input: unknown;
  execute(input: unknown): Promise<unknown>;
}

/** Tool call result in the shape the tool surface already produces. */
interface ToolResult {
  readonly content: string;
  readonly metadata?: { readonly xerj?: Record<string, unknown> };
}

/**
 * Owns the binary, node, and services for one project. Construction is cheap
 * and `start()` does the work, so a slow first start delays the first tool call
 * rather than the server handshake.
 */
export class McpHost {
  readonly config: Config;
  readonly projectRoot: string;
  readonly storageRoot: string;
  readonly warnings: string[];
  private readonly logger: Logger;
  private readonly storage;
  private ready: Promise<void> | null = null;
  private binary: InstalledBinary | null = null;
  private runtime: NodeRuntime | null = null;
  private handle: { port: number; pid: number | null } | null = null;
  private client: XerjClient | null = null;
  private corpus: CorpusService | null = null;
  private search: SearchService | null = null;
  private memory: MemoryStore | null = null;
  private spool: RemoteSpool | null = null;
  private anomaly: AnomalyService | null = null;
  private ledger: Ledger | null = null;

  constructor(private readonly options: McpHostOptions = {}) {
    this.projectRoot = options.projectRoot ?? process.cwd();
    const env = options.env ?? process.env;
    const loaded = loadConfig({}, env);
    this.warnings = [...loaded.warnings];

    // A standalone server has no plugin options, so the three settings that
    // matter most on a machine without OpenCode come from the environment.
    this.config = applyEnv(loaded.config, env);

    const resolved = resolveStorageRoot(this.projectRoot, this.config.storage.root);
    this.storageRoot = resolved.root;
    if (resolved.rejected !== null) {
      this.warnings.push(`storage root refused: ${resolved.rejected}; using ${resolved.root}`);
    }

    this.storage = fileStorage(join(this.storageRoot, "mcp-kv.json"));
    this.logger = createLogger(this.storage, {
      key: `log/ring:${this.prefix}:mcp`,
      echoToConsole: false,
    });
    // The ledger needs only storage, so it exists before the node does: that
    // lets `tools/list` answer without starting anything.
    this.ledger = new Ledger({
      storage: this.storage,
      key: `stats/lifetime:${this.prefix}:${pathHash(this.projectRoot)}`,
      projectRoot: this.projectRoot,
      bytesPerToken: this.config.stats.bytesPerToken,
      maxBaselineBytes: this.config.stats.maxBaselineBytes,
      logger: this.logger,
    });
  }

  get prefix(): string {
    return indexPrefix(this.projectRoot);
  }

  get nodeDir(): string {
    return projectNodeDir(this.storageRoot, this.prefix);
  }

  /** Downloads or reuses the managed binary for this platform. */
  private async installBinary(): Promise<InstalledBinary> {
    const runtimeTarget = await detectRuntime({
      target: this.config.binary.target,
      libc: this.config.binary.libc,
      timeoutMs: this.config.binary.detectTimeoutMs,
    });
    const info = runtimeTarget.info;
    if (info === null) {
      throw new Error(`no XERJ release for ${runtimeTarget.platform}/${runtimeTarget.arch}`);
    }

    return ensureBinary({
      root: this.storageRoot,
      requested: this.config.binary.version,
      platform: runtimeTarget.platform,
      info,
      logger: this.logger,
      timeouts: {
        commandMs: this.config.binary.commandTimeoutMs,
        requestMs: this.config.binary.requestTimeoutMs,
      },
    });
  }

  /** Starts the binary, node, and services once; a failure is retried next call. */
  async start(): Promise<void> {
    if (this.ready !== null) return this.ready;
    this.ready = this.boot().catch((error: unknown) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  /**
   * The MCP tool surface. Definitions are static, so listing them touches
   * nothing: the node starts on the first call that needs it.
   */
  async tools(): Promise<McpTool[]> {
    const options: ToolOptions = {
      config: this.config,
      projectRoot: this.projectRoot,
      // The archive the plugin writes for this project, read-only here: the
      // MCP server has no session events of its own to append.
      getArchive: () =>
        this.config.context.archiveEnabled
          ? new TurnArchive({
              directory: join(
                projectNodeDir(this.storageRoot, indexPrefix(this.projectRoot)),
                "archive",
              ),
              logger: this.logger,
              maxBytes: this.config.context.archiveMaxBytes,
            })
          : null,
      ledger: this.requireLedger(),
      logger: this.logger,
      getClient: () => this.client,
      getSearch: () => this.search,
      getMemory: () => this.memory,
      getSpool: () => this.spool,
      getAnomaly: () => this.anomaly,
      snapshot: () => this.snapshot(),
    };

    const built = buildTools(options).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input: tool.input,
      execute: async (input: unknown) => {
        await this.start();
        return tool.execute(input, {});
      },
    }));

    return [...built, ...this.runnerTools()];
  }

  async stop(): Promise<void> {
    await this.runtime?.stop("mcp server shutting down").catch(() => {});
    this.runtime = null;
    this.ready = null;
  }

  private async boot(): Promise<void> {
    const explicit = this.config.binary.path;
    if (explicit !== null && explicit.trim().length > 0) {
      this.binary = await externalBinary(
        explicit,
        this.logger,
        this.config.binary.commandTimeoutMs,
      );
    } else {
      this.binary = await this.installBinary();
    }

    this.runtime = new NodeRuntime({
      nodeDir: this.nodeDir,
      projectRoot: this.projectRoot,
      preferredPort: this.config.node.port,
      dataDir: nodeDataDir(this.nodeDir),
      portLockPath: join(this.storageRoot, "nodes", ".port-lock"),
      explicitUrl: this.options.nodeUrl ?? this.config.node.url,
      embedMode: this.config.index.neural ? EmbedMode.Neural : EmbedMode.Lexical,
      logMaxBytes: this.config.node.logMaxBytes,
      priority: this.config.node.priority,
      cpus: this.config.node.cpus,
      startupTimeoutMs: this.config.node.startupTimeoutMs,
      probeTimeoutMs: this.config.node.probeTimeoutMs,
      stopGraceMs: this.config.node.stopGraceMs,
      logger: this.logger,
      binary: () => this.binary,
      onSpawned: () => {},
      onStart: () => {},
    });

    const handle = await this.runtime.ensure();
    this.handle = { port: handle.port, pid: handle.pid };
    this.client = new XerjClient(handle.baseUrl, {
      timeoutMs: this.config.node.clientTimeoutMs,
      writeTimeoutMs: this.config.node.writeTimeoutMs,
    });

    this.memory = new MemoryStore(
      this.client,
      memoryNamespace(this.projectRoot),
      this.logger,
    );
    this.spool = new RemoteSpool({
      root: this.storageRoot,
      projectRoot: this.projectRoot,
      prefix: webPrefix(this.projectRoot),
      externalPrefix: externalPrefix(this.projectRoot),
      maxBytes: this.config.remote.maxBytes,
      client: this.client,
      logger: this.logger,
    });
    await this.spool.init().catch(() => {});
    this.anomaly = new AnomalyService(this.client, this.logger);
    this.search = new SearchService(
      this.client,
      [this.prefix, webPrefix(this.projectRoot), externalPrefix(this.projectRoot)],
      this.logger,
      this.projectRoot,
    );

    for (const warning of this.warnings) this.logger.warn(warning);
  }

  private createCorpus(): CorpusService {
    return new CorpusService({
      binaryPath: this.binary?.path ?? "",
      nodeUrl: this.client?.baseUrl ?? "",
      projectRoot: this.projectRoot,
      prefix: this.prefix,
      stateRoot: this.storageRoot,
      config: this.config,
      storage: this.storage,
      logger: this.logger,
      priority: this.config.node.priority,
      cpus: this.config.node.cpus,
    });
  }

  /** Tools that run a corpus: the plugin exposes these as commands. */
  private runnerTools(): McpTool[] {
    return [
      {
        name: "reindex",
        description:
          "Run an incremental index pass over the project now. Use when search looks stale after edits.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          await this.start();
          this.corpus ??= this.createCorpus();
          await this.corpus.reindex();
          const snapshot = this.corpus.snapshot();
          const run = snapshot.lastRun;
          return {
            content:
              `reindexed ${run?.records?.toLocaleString("en-US") ?? "?"} records ` +
              `from ${run?.files?.toLocaleString("en-US") ?? "?"} files (${snapshot.state})`,
            metadata: {
              xerj: { records: run?.records ?? null, files: run?.files ?? null },
            },
          } satisfies ToolResult;
        },
      },
      {
        name: "sysdocs",
        description:
          "Index this machine's man and info pages, skipping pages already indexed and pruning pages that vanished.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          await this.start();
          const summary = await new SysdocIndexer({
            client: this.requireClient(),
            prefix: sysdocsPrefix(hostname()),
            stateDir: join(this.nodeDir, "sysdocs"),
            logger: this.logger,
            maxDocs: this.config.sysdocs.maxDocs,
            maxBytesPerDoc: this.config.sysdocs.maxBytesPerDoc,
            manDirs:
              this.config.sysdocs.manDirs.length > 0
                ? this.config.sysdocs.manDirs
                : undefined,
            infoDirs:
              this.config.sysdocs.infoDirs.length > 0
                ? this.config.sysdocs.infoDirs
                : undefined,
          }).run();

          return {
            content:
              `system docs: ${summary.indexed} indexed, ${summary.skipped} unchanged, ` +
              `${summary.pruned} pruned, ${summary.discovered} discovered`,
            metadata: { xerj: { ...summary } },
          } satisfies ToolResult;
        },
      },
      {
        name: "prjdocs",
        description:
          "Index official documentation for this project's languages, frameworks, and cloud APIs at the versions it uses.",
        input: {
          type: "object",
          properties: {
            eager: {
              type: "boolean",
              description:
                "Remove the depth and page-type limits, judge pages with the model, and search for unknown technologies.",
            },
            keywords: {
              type: "array",
              items: { type: "string" },
              description:
                "Extra terms to document even though the project does not use them. Eager mode only.",
            },
          },
          additionalProperties: false,
        },
        execute: async (raw: unknown) => {
          await this.start();
          const eager = typeof raw === "object" && raw !== null && (raw as { eager?: unknown }).eager === true;
          const asked =
            typeof raw === "object" && raw !== null && Array.isArray((raw as { keywords?: unknown }).keywords)
              ? ((raw as { keywords: unknown[] }).keywords.filter((entry) => typeof entry === "string") as string[])
              : [];
          const latest = new LatestVersions({
            logger: this.logger,
            requestTimeoutMs: this.config.prjdocs.latestTimeoutMs,
          });
          const banner = await this.requireClient().info().catch(() => null);
          const summary = await new PrjdocsIndexer({
            client: this.requireClient(),
            builtin: {
              enabled: this.config.prjdocs.builtin,
              elasticsearchVersion: banner?.wireVersion ?? "8.13",
              xerjPages: this.config.prjdocs.builtinXerjPages,
              elasticsearchPages: this.config.prjdocs.builtinElasticsearchPages,
              refreshDays: this.config.prjdocs.builtinRefreshDays,
              eager,
            },
            prefix: prjdocsPrefix(this.projectRoot),
            projectRoot: this.projectRoot,
            stateDir: join(this.nodeDir, "prjdocs"),
            logger: this.logger,
            maxTargets: this.config.prjdocs.maxTargets,
            maxPages: this.config.prjdocs.maxPages > 0 ? this.config.prjdocs.maxPages : undefined,
            requestTimeoutMs: this.config.prjdocs.requestTimeoutMs,
            latestVersion: (ref) => latest.resolve(ref),
            eager: eager
              ? {
                  maxPages: this.config.prjdocs.eagerMaxPages,
                  maxDepth: this.config.prjdocs.eagerMaxDepth,
                  maxModelCalls: this.config.prjdocs.eagerModelCalls,
                  keywords: [...this.config.prjdocs.eagerKeywords, ...asked],
                }
              : undefined,
          }).run();

          return {
            content:
              `project docs: ${summary.indexed} indexed, ${summary.skipped} unchanged, ` +
              `${summary.pruned} pruned across ${summary.techs.length} technologies`,
            metadata: { xerj: { ...summary } },
          } satisfies ToolResult;
        },
      },
    ];
  }

  private get target(): string {
    return this.config.binary.target ?? process.arch;
  }

  private async snapshot(): Promise<StatusSnapshot> {
    const ledger = this.requireLedger();
    const usage: LedgerSnapshot = ledger.snapshot();
    const client = this.client;
    const indices = client === null ? [] : await client.indices().catch(() => []);
    const memory =
      client === null
        ? { count: 0, exists: false }
        : await client.memorySummary(memoryNamespace(this.projectRoot)).catch(() => ({
            count: 0,
            exists: false,
          }));
    const recent = (await this.logger.entries())
      .filter((entry) => entry.level !== "info")
      .slice(-4)
      .map((entry) => `${entry.level}: ${entry.message}`);

    return {
      pluginVersion: PLUGIN_VERSION,
      updatedAt: Date.now(),
      node: {
        phase: this.runtime === null ? "disabled" : "ready",
        baseUrl: this.client?.baseUrl ?? null,
        serverVersion: this.binary?.version ?? null,
        spawned: false,
        state: this.runtime === null ? "stopped" : "running",
        pid: this.handle?.pid ?? null,
        idleAt: null,
        sessions: 1,
        error: null,
      },
      binary: {
        version: this.binary?.version ?? null,
        path: this.binary?.path ?? null,
        upgraded: this.binary?.upgraded ?? false,
        target: this.target,
      },
      index: {
        prefix: this.prefix,
        docs: indices.reduce((total, entry) => total + entry.docs, 0),
        bytes: indices.reduce((total, entry) => total + entry.bytes, 0),
        indices: indices.length,
        state: this.corpus === null ? "idle" : this.corpus.snapshot().state,
        lastRunAt: this.corpus?.snapshot().lastRun?.at ?? null,
        lastGeneration: this.corpus?.snapshot().lastRun?.generation ?? null,
        lastRecords: this.corpus?.snapshot().lastRun?.records ?? null,
        lastFiles: this.corpus?.snapshot().lastRun?.files ?? null,
        restarts: this.corpus?.snapshot().restarts ?? 0,
        lastError: this.corpus?.snapshot().lastError ?? null,
        datasets: [],
      },
      config: {
        indexRoot: this.projectRoot,
        storageRoot: this.storageRoot,
        brain: this.config.index.brain,
        watch: this.config.index.watch,
        contextEnabled: this.config.context.enabled,
        prjdocsKeywords: this.config.prjdocs.eagerKeywords,
      },
      usage,
      memory: { namespace: memoryNamespace(this.projectRoot), count: memory.count, exists: memory.count > 0, stale: 0 },
      brains: [],
      corpora: [],
      disk: { engineBytes: 0, logBytes: 0 },
      map: [],
      frameworks: [],
  docs: { prjdocs: { lastRunAt: null, pages: 0 }, sysdocs: { lastRunAt: null, pages: 0 } },
      process: null,
      embeddings: false,
      state: {
        name: this.runtime === null ? "stopped" : "ready",
        since: Date.now(),
        detail: null,
        jobs: [],
        today: {
          startingMs: 0,
          readyMs: 0,
          busyMs: 0,
          degradedMs: 0,
          stoppedMs: 0,
        },
      },
      telemetry: {
        enabled: false,
        ops: [],
        starts: [],
        crashes: 0,
        restarts: 0,
        process: null,
        storeBytes: 0,
        historyStart: null,
        distill: { promoted: 0, heuristic: 0, model: 0, local: 0, recalled: 0, calls: 0, chars: 0 },
        disabled: "the MCP host does not run the telemetry store",
      },
      counters: {
        rpcCalls: 0,
        injectedTurns: 0,
        nodeSpawns: 0,
        http429: 0,
        indexRuns: 0,
        noiseSkips: 0,
      },
      recent,
      warnings: this.warnings,
      errors: [],
    };
  }

  private requireClient(): XerjClient {
    if (this.client === null) throw new Error("the XERJ node is not ready");
    return this.client;
  }

  private requireLedger(): Ledger {
    if (this.ledger === null) throw new Error("the ledger is not ready");
    return this.ledger;
  }

}


/**
 * Environment settings for a machine without OpenCode: where the binary is,
 * where project state lives, and which node to attach to.
 */
function applyEnv(config: Config, env: Record<string, string | undefined>): Config {
  const binaryPath = nonEmpty(env.XERJ_BIN);
  const storageRoot = nonEmpty(env.XERJ_STORAGE_ROOT);
  const nodeUrl = nonEmpty(env.XERJ_NODE_URL);

  if (binaryPath === null && storageRoot === null && nodeUrl === null) return config;

  return {
    ...config,
    binary: binaryPath === null ? config.binary : { ...config.binary, path: binaryPath },
    storage: storageRoot === null ? config.storage : { ...config.storage, root: storageRoot },
    node: nodeUrl === null ? config.node : { ...config.node, url: nodeUrl },
  };
}

function nonEmpty(value: string | undefined): string | null {
  return value !== undefined && value.trim().length > 0 ? value.trim() : null;
}
