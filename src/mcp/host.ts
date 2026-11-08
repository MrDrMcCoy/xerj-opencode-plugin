// Standalone host for the MCP server: no OpenCode process and no plugin
// context. Everything the tool surface needs is built here from a project
// directory and the plugin's own defaults, so any agent that speaks MCP works
// against the same index, memory, and system documentation.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "../config.ts";
import { discoverPluginOptions } from "../config-file.ts";
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
import { CorpusService, type CorpusSnapshot } from "../index/watcher.ts";
import { SearchService } from "../search/service.ts";
import { CommitIndex } from "../index/commits.ts";
import { BrainIndexer } from "../index/brain.ts";
import { ArchiveIndex } from "../archive/index.ts";
import { TurnArchive } from "../archive/turns.ts";
import { MemoryStore } from "../memory/store.ts";
import { RemoteSpool } from "../remote/spool.ts";
import { AnomalyService } from "../telemetry/anomaly.ts";
import { Ledger, type LedgerSnapshot } from "../stats/ledger.ts";
import { datasetRows } from "../datasets/rows.ts";
import { sampleProcess } from "../process-stats.ts";
import { buildTools, type ToolOptions } from "../tools/search.ts";
import { cmdTools } from "../tools/cmd.ts";
import { CmdService } from "../cmd/service.ts";
import { HubService } from "../hub/service.ts";
import { TreeSitterService } from "../analysis/treesitter.ts";
import { CodeService } from "../code/service.ts";
import { ShareService } from "../share/service.ts";
import { LspPool } from "../analysis/lsp/pool.ts";
import { NoteStore } from "../notes/store.ts";
import { verifyMemories } from "../memory/verify.ts";
import { curateMemories } from "../memory/curate.ts";
import { startRetention } from "../memory/retain.ts";
import {
  archivePrefix,
  brainSpecs,
  cacheRoot,
  cmdPrefix,
  documentRoots,
  environmentFrom,
  externalPrefix,
  gitPrefix,
  prjdocsPrefix,
  projectBrainName,
  projectStateDir,
  sysdocsPrefix,
  webPrefix,
  type BrainSpec,
} from "../paths.ts";
import { detectDocsFolders, withoutBrainFolders } from "../index/hint.ts";
import { HiddenIndex } from "../index/hidden.ts";
import { fileStorage } from "./storage.ts";
import { SysdocIndexer } from "../sysdocs/index.ts";
import { PrjdocsIndexer } from "../prjdocs/index.ts";
import { LatestVersions } from "../prjdocs/latest.ts";
import { BrainGraph } from "../search/brains.ts";
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
  private hidden: HiddenIndex | null = null;
  private brain: BrainIndexer | null = null;
  private cmd: CmdService | null = null;
  private staleMemories = 0;
  private lsp: LspPool | null = null;
  private ledger: Ledger | null = null;
  private toolsCache: McpTool[] | null = null;
  private readonly shutdown = new AbortController();

  constructor(private readonly options: McpHostOptions = {}) {
    this.projectRoot = options.projectRoot ?? process.cwd();
    const env = options.env ?? process.env;
    // A standalone server has no host to pass options down, so it reads the
    // same opencode.json the host would, then applies the three environment
    // settings that matter on a machine without OpenCode.
    const discovered = discoverPluginOptions(this.projectRoot, env);
    const loaded = loadConfig(discovered.options, env);
    this.warnings = [...discovered.warnings, ...loaded.warnings];
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

  /** The shared cache root; the binary, grammars, LSP, and port lock. */
  private get cache(): string {
    return cacheRoot(environmentFrom(this.options.env ?? process.env));
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
    // The protocol asks for the list on every call. Building the services
    // again would create a new LSP pool per tool call and lose its servers.
    if (this.toolsCache !== null) return this.toolsCache;

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
      // No resident web watcher in the MCP; one pass makes a fetched page
      // searchable before the tool reports success. A failed pass is an
      // error, not a silent success.
      onSpooledUrl: async () => {
        const snapshot = await this.indexWebOnce();
        if (snapshot?.lastError != null) throw new Error(snapshot.lastError);
      },
      getAnomaly: () => this.anomaly,
      hub: new HubService({
        config: this.config.hub,
        hubRoot: join(this.cache, "hub"),
        binary: () => this.binary?.path ?? null,
        nodeUrl: () => this.client?.baseUrl ?? null,
        logger: this.logger,
      }),
      notes: new NoteStore({
        directory: projectStateDir(this.projectRoot),
        logger: this.logger,
      }),
      lsp: (this.lsp ??= new LspPool({
        projectRoot: this.projectRoot,
        root: join(this.cache, "lsp"),
        config: this.config.analysis.lsp,
        logger: this.logger,
      })),
      code: new CodeService({
        config: this.config.code,
        binary: () => this.binary?.path ?? null,
        nodeUrl: () => this.client?.baseUrl ?? null,
        codeRoot: join(this.cache, "code"),
        logger: this.logger,
      }),
      share: new ShareService({
        config: this.config.share,
        binary: () => this.binary?.path ?? null,
        nodeUrl: () => this.client?.baseUrl ?? null,
        logger: this.logger,
      }),
      treeSitter: new TreeSitterService({
        projectRoot: this.projectRoot,
        grammarRoot: join(this.cache, "grammars"),
        config: this.config.analysis.treeSitter,
        logger: this.logger,
      }),
      snapshot: () => this.snapshot(),
    };

    const wrap = (tool: {
      readonly name: string;
      readonly description: string;
      readonly input: unknown;
      readonly execute: (input: unknown, context: unknown) => Promise<unknown>;
    }): McpTool => ({
      name: tool.name,
      description: tool.description,
      input: tool.input,
      execute: async (input: unknown) => {
        await this.start();
        // The shared tools read a session id and an abort signal from their
        // context. The MCP has no OpenCode session, so it supplies a stable
        // synthetic one and the server's shutdown signal.
        return tool.execute(input, {
          sessionID: "mcp",
          signal: this.shutdown.signal,
        }) as never;
      },
    });

    const built = buildTools(options).map(wrap);
    const command = this.config.cmd.enabled
      ? cmdTools({
          config: this.config,
          getCmd: () => this.cmd,
          logger: this.logger,
        }).map(wrap)
      : [];

    this.toolsCache = [...built, ...command, ...this.runnerTools()];
    return this.toolsCache;
  }

  async stop(): Promise<void> {
    this.shutdown.abort();
    this.cmd?.stop();
    await this.hidden?.stop().catch(() => {});
    await this.corpus?.stop().catch(() => {});
    await this.lsp?.stopAll().catch(() => {});
    this.corpus = null;
    this.hidden = null;
    this.lsp = null;
    this.toolsCache = null;

    // `shutdownOnIdle: false` means the node survives the client session, so
    // another MCP client or the plugin can attach to it. With the key on it is
    // this server's to stop.
    if (this.config.node.shutdownOnIdle && this.config.node.url === null) {
      await this.runtime?.stop("mcp server shutting down").catch(() => {});
    } else {
      this.runtime?.invalidate();
    }
    this.runtime = null;
    this.ready = null;
    this.client = null;
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
      portLockPath: join(this.cache, "nodes", ".port-lock"),
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
    // The same maintenance the plugin runs at setup. There are no turns to
    // distill here, but stale citations and duplicates still need the sweep.
    void verifyMemories({
      memory: this.memory,
      projectRoot: this.projectRoot,
      logger: this.logger,
      signal: this.shutdown.signal,
    })
      .then((summary) => {
        this.staleMemories = summary.stale;
      })
      .catch((error: unknown) => {
        this.logger.debug("memory verification skipped", String(error));
      });
    void curateMemories({
      memory: this.memory,
      logger: this.logger,
      signal: this.shutdown.signal,
    }).catch((error: unknown) => {
      this.logger.debug("memory curation skipped", String(error));
    });
    startRetention(
      this.memory,
      this.config.memory.retain,
      this.shutdown.signal,
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

    const brains = brainSpecs(this.projectRoot, this.config.index.brain);
    // Project notes live in dot-directories the engine skips, so the MCP
    // indexes the detected docs folders through the same hidden indexer the
    // plugin uses. A folder already covered by a brain is not duplicated.
    const hiddenFolders =
      this.config.index.hidden.length > 0
        ? this.config.index.hidden
        : detectDocsFolders((folder) =>
            existsSync(join(this.projectRoot, folder)),
          );
    const hiddenRoots = withoutBrainFolders(
      documentRoots(this.projectRoot, hiddenFolders),
      brains,
    );
    this.hidden =
      hiddenRoots.length === 0
        ? null
        : new HiddenIndex({
            client: this.client,
            projectRoot: this.projectRoot,
            prefix: this.prefix,
            roots: hiddenRoots,
            maxBytes: this.config.index.hiddenMaxBytes,
            logger: this.logger,
          });
    if (this.hidden !== null) await this.hidden.start();

    const graphBrains: BrainSpec[] = this.config.index.graph
      ? [
          {
            name: projectBrainName(this.projectRoot),
            label: ".",
            directory: this.projectRoot,
            prefix: this.prefix,
            pathciteOnly: true,
          },
        ]
      : [];
    this.search = new SearchService(
      this.client,
      [
        this.prefix,
        gitPrefix(this.projectRoot),
        archivePrefix(this.projectRoot),
        webPrefix(this.projectRoot),
        externalPrefix(this.projectRoot),
        sysdocsPrefix(hostname()),
        prjdocsPrefix(this.projectRoot),
        cmdPrefix(this.projectRoot),
        ...brains.map((brain) => brain.prefix),
      ],
      this.logger,
      this.projectRoot,
      new BrainGraph({
        client: this.client,
        brains: [...brains, ...graphBrains],
        logger: this.logger,
      }),
      brains,
      this.hidden === null ? null : `${this.prefix}-hidden-docs`,
    );

    this.brain =
      brains.length === 0
        ? null
        : new BrainIndexer({
            binaryPath: this.binary?.path ?? "",
            nodeUrl: this.client.baseUrl,
            stateRoot: this.storageRoot,
            config: this.config,
            specs: brains,
            logger: this.logger,
            priority: this.config.node.priority,
            cpus: this.config.node.cpus,
            onChange: () => this.search?.invalidate(),
          });
    if (this.brain !== null && this.config.index.auto) {
      void this.brain.runAll().catch((error: unknown) => {
        this.logger.debug("could not index a brain", String(error));
      });
    }

    if (this.config.cmd.enabled) {
      this.cmd = new CmdService({
        config: this.config.cmd,
        storageRoot: this.storageRoot,
        projectRoot: this.projectRoot,
        indexName: `${cmdPrefix(this.projectRoot)}-docs`,
        getClient: () => this.client,
        logger: this.logger,
        signal: this.shutdown.signal,
      });
      await this.cmd.start();
      void this.cmd.reindex();
    }

    for (const warning of this.warnings) this.logger.warn(warning);
  }

  private createCorpus(options: { watch?: boolean } = {}): CorpusService {
    const config =
      options.watch === undefined
        ? this.config
        : {
            ...this.config,
            index: { ...this.config.index, watch: options.watch },
          };
    return new CorpusService({
      binaryPath: this.binary?.path ?? "",
      nodeUrl: this.client?.baseUrl ?? "",
      projectRoot: this.projectRoot,
      prefix: this.prefix,
      stateRoot: this.storageRoot,
      config,
      storage: this.storage,
      logger: this.logger,
      priority: this.config.node.priority,
      cpus: this.config.node.cpus,
      onChange: () => this.search?.invalidate(),
    });
  }

  /**
   * One synchronous project pass. A one-shot corpus avoids the engine's
   * resident `--watch`, which refuses a state dir inside the watched tree
   * (the default `.xerj` layout), and it returns only after the pass.
   */
  private async indexProjectOnce(): Promise<CorpusSnapshot | null> {
    const corpus = this.createCorpus({ watch: false });
    this.corpus = corpus;
    await corpus.start();
    const snapshot = corpus.snapshot();
    await corpus.stop();
    return snapshot;
  }

  /** The web spool in one pass; there is no resident web watcher here. */
  private async indexWebOnce(): Promise<CorpusSnapshot | null> {
    const spool = this.spool;
    if (spool === null) return null;

    const corpus = new CorpusService({
      binaryPath: this.binary?.path ?? "",
      nodeUrl: this.client?.baseUrl ?? "",
      projectRoot: spool.directory,
      prefix: webPrefix(this.projectRoot),
      stateRoot: this.storageRoot,
      config: {
        ...this.config,
        index: { ...this.config.index, watch: false },
      },
      storage: this.storage,
      logger: this.logger,
      priority: this.config.node.priority,
      cpus: this.config.node.cpus,
      onChange: () => this.search?.invalidate(),
    });
    await corpus.start();
    const snapshot = corpus.snapshot();
    await corpus.stop();
    return snapshot;
  }

  private async indexCommitsOnce(): Promise<void> {
    if (!this.config.index.git) return;
    await new CommitIndex({
      client: this.requireClient(),
      indexName: `${gitPrefix(this.projectRoot)}-docs`,
      projectRoot: this.projectRoot,
      statePath: join(this.nodeDir, "git", "commits.json"),
      logger: this.logger,
      limit: this.config.index.gitLimit,
      signal: this.shutdown.signal,
    })
      .run()
      .catch((error: unknown) => {
        this.logger.debug("could not index git history", String(error));
      });
    this.search?.invalidate();
  }

  private async indexArchiveOnce(): Promise<void> {
    if (!this.config.context.archiveEnabled) return;
    await new ArchiveIndex({
      client: this.requireClient(),
      indexName: `${archivePrefix(this.projectRoot)}-docs`,
      directory: join(this.nodeDir, "archive"),
      statePath: join(this.nodeDir, "archive", "index.json"),
      logger: this.logger,
      signal: this.shutdown.signal,
    })
      .run()
      .then(() => this.search?.invalidate())
      .catch((error: unknown) => {
        this.logger.debug("could not index the turn archive", String(error));
      });
  }

  /** One full pass over every corpus the MCP owns. */
  private async reindexAll(): Promise<{
    readonly project: CorpusSnapshot | null;
    readonly web: CorpusSnapshot | null;
  }> {
    const project = await this.indexProjectOnce();
    const web = await this.indexWebOnce();
    await this.hidden?.reindex();
    await this.indexCommitsOnce();
    await this.indexArchiveOnce();
    await this.brain?.runAll();
    await this.cmd?.reindex();
    this.search?.invalidate();
    return { project, web };
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
          const { project, web } = await this.reindexAll();
          const run = project?.lastRun;
          const webRun = web?.lastRun;
          return {
            content:
              `indexed ${run?.records?.toLocaleString("en-US") ?? "?"} records ` +
              `from ${run?.files?.toLocaleString("en-US") ?? "?"} files` +
              (webRun?.records ? ` · web ${webRun.records} records` : ""),
            metadata: {
              xerj: {
                records: run?.records ?? null,
                files: run?.files ?? null,
                web: webRun?.records ?? null,
              },
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

    const brains = brainSpecs(this.projectRoot, this.config.index.brain);
    const datasets = datasetRows(
      indices,
      this.prefix,
      gitPrefix(this.projectRoot),
      webPrefix(this.projectRoot),
      externalPrefix(this.projectRoot),
      sysdocsPrefix(hostname()),
      cmdPrefix(this.projectRoot),
      memoryNamespace(this.projectRoot),
      brains,
    );
    const corpus = datasets.filter((dataset) => dataset.name !== "memory");
    const corpora = corpus
      .filter((dataset) => !dataset.name.startsWith("brain:"))
      .map((dataset) => ({
        name: dataset.name,
        state:
          dataset.name === "project"
            ? (this.corpus?.snapshot().state ?? "idle")
            : "idle",
        docs: dataset.docs,
        lastRunAt:
          dataset.name === "project"
            ? (this.corpus?.snapshot().lastRun?.at ?? null)
            : null,
        records:
          dataset.name === "project"
            ? (this.corpus?.snapshot().lastRun?.records ?? null)
            : null,
        edges: null,
        error: null,
      }));
    const pages = (name: string): number =>
      datasets.find((dataset) => dataset.name === name)?.docs ?? 0;
    const processInfo =
      this.handle?.pid == null
        ? null
        : await sampleProcess(this.handle.pid).catch(() => null);

    return {
      pluginVersion: PLUGIN_VERSION,
      updatedAt: Date.now(),
      // The standalone MCP host has no dreamer.
      dreamer: {
        enabled: false,
        running: false,
        lastRunAt: null,
        nextRunAt: null,
        checked: 0,
        stale: 0,
        merged: 0,
        flagged: 0,
        contributions: 0,
      },
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
        docs: corpus.reduce((total, dataset) => total + dataset.docs, 0),
        bytes: corpus.reduce((total, dataset) => total + dataset.bytes, 0),
        indices: corpus.filter((dataset) => dataset.docs > 0).length,
        state: this.corpus === null ? "idle" : this.corpus.snapshot().state,
        lastRunAt: this.corpus?.snapshot().lastRun?.at ?? null,
        lastGeneration: this.corpus?.snapshot().lastRun?.generation ?? null,
        lastRecords: this.corpus?.snapshot().lastRun?.records ?? null,
        lastFiles: this.corpus?.snapshot().lastRun?.files ?? null,
        restarts: this.corpus?.snapshot().restarts ?? 0,
        lastError: this.corpus?.snapshot().lastError ?? null,
        datasets,
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
      memory: {
        namespace: memoryNamespace(this.projectRoot),
        count: memory.count,
        exists: memory.exists,
        stale: this.staleMemories,
      },
      brains: [],
      corpora,
      disk: { engineBytes: 0, logBytes: 0 },
      map: [],
      frameworks: [],
      docs: {
        prjdocs: { lastRunAt: null, pages: pages("prjdocs") },
        sysdocs: { lastRunAt: null, pages: pages("sysdocs") },
      },
      process:
        processInfo === null
          ? null
          : {
              cpuPercent: processInfo.cpuPercent,
              memoryBytes: processInfo.memoryBytes,
            },
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
