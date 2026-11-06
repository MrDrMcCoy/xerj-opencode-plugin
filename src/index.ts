// Server part. Loads config, brings up the binary and node in the background,
// and registers tools, hooks, and RPC. Nothing here blocks plugin load: a slow
// download or a missing node must not delay OpenCode startup.

import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { Plugin } from "@opencode/plugin";
import { detectRuntime } from "./binary/detect.ts";
import { ensureBinary, externalBinary, type InstalledBinary } from "./binary/manager.ts";
import { loadConfig } from "./config.ts";
import { registerSessionHooks } from "./hooks/session.ts";
import { BrainIndexer, type BrainRun } from "./index/brain.ts";
import { HiddenIndex } from "./index/hidden.ts";
import { corpusLayout } from "./index/corpus.ts";
import { CorpusService, type CorpusSnapshot } from "./index/watcher.ts";
import { createLogger, type KeyValueStorage, type Logger } from "./log.ts";
import { ProjectLifecycle, startSessionTracking } from "./lifecycle.ts";
import { XerjClient, type IndexSummary } from "./node/client.ts";
import { NodeRuntime } from "./node/runtime.ts";
import { reconcileEmbedMode } from "./node/embed-mode.ts";
import { detectNode, EmbedMode, stopNode, type NodeHandle } from "./node/supervisor.ts";
import {
  brainSpecs,
  dataRoot,
  documentRoots,
  environmentFrom,
  externalPrefix,
  indexPrefix,
  isOverbroadRoot,
  memoryNamespace,
  nodeDataDir,
  projectNodeDir,
  projectPath,
  projectStateDir,
  resolveStorageRoot,
  scopedStorageKey,
  webPrefix,
  type BrainSpec,
  type DocumentRoot,
} from "./paths.ts";
import {
  PLUGIN_VERSION,
  XerjRpc,
  type BrainStatus,
  type DatasetStatus,
  type StatusSnapshot,
} from "./rpc.ts";
import { MemoryStore } from "./memory/store.ts";
import {
  SessionPrompts,
  startCompactionCapture,
  startTurnCapture,
} from "./memory/capture.ts";
import {
  detectDocsFolders,
  unindexedDocsHint,
  withoutBrainFolders,
} from "./index/hint.ts";
import {
  handleToolResult,
  type ToolResultEvent,
} from "./hooks/tool-results.ts";
import { recoverMemoryIndex } from "./memory/health.ts";
import { startRetention } from "./memory/retain.ts";
import { migrateMemoryIndex, migrateProjectStorage } from "./memory/migrate.ts";
import { RemoteSpool } from "./remote/spool.ts";
import { BrainGraph } from "./search/brains.ts";
import { SearchService } from "./search/service.ts";
import { formatAge } from "./ui/format.ts";
import { Ledger } from "./stats/ledger.ts";
import { Counters } from "./stats/counters.ts";
import { AnomalyService } from "./telemetry/anomaly.ts";
import { buildTools } from "./tools/search.ts";

interface Runtime {
  phase: "starting" | "ready" | "error" | "disabled";
  binary: InstalledBinary | null;
  node: NodeHandle | null;
  nodes: NodeRuntime | null;
  lifecycle: ProjectLifecycle | null;
  corpus: CorpusService | null;
  search: SearchService | null;
  memory: MemoryStore | null;
  spool: RemoteSpool | null;
  web: CorpusService | null;
  brain: BrainIndexer | null;
  brains: ReadonlyArray<BrainSpec>;
  hidden: HiddenIndex | null;
  hiddenRoots: ReadonlyArray<DocumentRoot>;
  anomaly: AnomalyService | null;
  error: string | null;
  warnings: string[];
}

export default Plugin.define({
  id: "xerj",
  async setup(ctx) {
    const { config, warnings } = loadConfig(ctx.options, process.env);
    const storage = asStorage(ctx.storage);

    const root = dataRoot(environmentFrom(process.env));
    // The location may be a subdirectory of the project; index the project root
    // so a session opened in `docs/` does not create a second corpus.
    const projectRoot = ctx.location.project.canonical;
    const prefix = indexPrefix(projectRoot);
    // Plugin storage is shared by every location in this server, and one server
    // can load this plugin twice for one project (the repo and a subdirectory).
    // Key by project and location: project keeps other projects out, location
    // keeps the two instances from overwriting each other's counters.
    const logger = createLogger(storage, {
      key: scopedStorageKey("log/ring", prefix, ctx.location.directory),
    });
    for (const warning of warnings) logger.warn(warning);

    const overbroad = isOverbroadRoot(projectRoot);
    const indexWarnings = [...warnings];
    if (overbroad) {
      const refusal =
        `refusing to index ${projectRoot}: the home directory and filesystem roots are too broad. Open OpenCode inside a project.`;
      indexWarnings.push(refusal);
      logger.warn(refusal);
    }
    const brains = brainSpecs(projectRoot, config.index.brain);
    // Project notes live in dot-directories, which the engine skips. Index the
    // ones that exist unless the configuration names its own list.
    const hiddenFolders = config.index.hidden.length > 0
      ? config.index.hidden
      : detectDocsFolders((folder) => existsSync(join(projectRoot, folder)));
    // A brain already indexes its folder with sections and edges, so the same
    // files are not also added as whole documents.
    const hiddenRoots = withoutBrainFolders(
      documentRoots(projectRoot, hiddenFolders),
      brains,
    );
    if (!overbroad) {
      const docsHint = unindexedDocsHint(
        (folder) => existsSync(join(projectRoot, folder)),
        [...hiddenFolders, ...config.index.brain],
      );
      if (docsHint !== null) {
        indexWarnings.push(docsHint);
        logger.warn(docsHint);
      }
    }
    const runtime: Runtime = {
      phase: "starting",
      binary: null,
      node: null,
      nodes: null,
      lifecycle: null,
      corpus: null,
      search: null,
      memory: null,
      spool: null,
      web: null,
      brain: null,
      brains,
      hidden: null,
      hiddenRoots,
      anomaly: null,
      error: null,
      warnings: indexWarnings,
    };

    const ledger = new Ledger({
      storage,
      key: scopedStorageKey("stats/lifetime", prefix, ctx.location.directory),
      projectRoot,
      bytesPerToken: config.stats.bytesPerToken,
      maxBaselineBytes: config.stats.maxBaselineBytes,
      logger,
    });

    const counters = new Counters();
    const observer = { onResponse: (status: number) => {
      if (status === 429) counters.note429();
    } };

    const host = await detectRuntime({
      libc: config.binary.libc,
      target: config.binary.target,
      env: process.env,
    });
    const info = host.info;
    if (!info && !config.binary.path) {
      runtime.phase = "disabled";
      runtime.error = config.binary.target
        ? `binary.target ${config.binary.target} cannot run on ${host.platform}/${host.arch}`
        : `unsupported platform: ${host.platform}/${host.arch}`;
      logger.error(runtime.error);
    }

    const memoryNs = memoryNamespace(projectRoot);
    // Every project's data lives in `<project>/.xerj` by default. The binary,
    // release cache, and the shared port lock stay in the global data root.
    const storageLocation = resolveStorageRoot(projectRoot, config.storage.root);
    const storageRoot = storageLocation.root;
    if (storageLocation.rejected !== null) {
      const refusal =
        `storage.root ${storageLocation.rejected} is inside the project but not hidden; ` +
        "using .xerj so the index does not index its own data.";
      indexWarnings.push(refusal);
      logger.warn(refusal);
    }

    // One node directory per project, so two projects (or two locations of the
    // same project) never share a process, a port, or an idle timer.
    const nodeDir = projectNodeDir(storageRoot, prefix);
    // Index journals live beside the engine data they describe, so a node with
    // a new data dir always starts from a full pass instead of trusting a
    // journal that describes documents the engine no longer has.
    const engineDataDir = config.node.dataDir
      ? projectPath(projectRoot, config.node.dataDir)
      : nodeDataDir(nodeDir);
    const stateRoot = engineDataDir;

    const idleSnapshot = (): number | null => {
      const idle = runtime.lifecycle?.snapshot();
      return idle?.idleAt ?? null;
    };

    const snapshot = async (): Promise<StatusSnapshot> => {
      const usage = ledger.snapshot();
      // Only probe the node directory when no live handle exists: a healthy
      // process never pays for detection, and an idle-stopped one reports
      // whether another OpenCode process has since started the node.
      const detection = runtime.node === null ? await runtime.nodes?.detect() : null;
      const runtimeState = runtime.nodes?.snapshot.state ?? "stopped";
      const base: StatusSnapshot = {
        pluginVersion: PLUGIN_VERSION,
        updatedAt: Date.now(),
        node: {
          phase: runtime.phase,
          baseUrl: runtime.node?.baseUrl ?? null,
          serverVersion: runtime.node?.version ?? null,
          spawned: runtime.node?.spawned ?? false,
          state:
            runtimeState === "stopped" && detection?.running ? "running" : runtimeState,
          pid: runtime.node?.pid ?? detection?.pid ?? null,
          idleAt: idleSnapshot(),
          sessions: runtime.lifecycle?.snapshot().sessions ?? 0,
          error: runtime.error,
        },
        binary: {
          version: runtime.binary?.version ?? null,
          path: runtime.binary?.path ?? null,
          upgraded: runtime.binary?.upgraded ?? false,
          target: info?.target ?? null,
        },
        index: {
          prefix,
          docs: 0,
          bytes: 0,
          indices: 0,
          datasets: [],
          ...corpusStatus(runtime.corpus),
        },
        config: {
          indexRoot: projectRoot,
          storageRoot,
          brain: config.index.brain,
          watch: config.index.watch,
          contextEnabled: config.context.enabled,
        },
        usage: {
          queries: usage.queries,
          hits: usage.hits,
          hitRate: usage.hitRate,
          bytesReturned: usage.bytesReturned,
          bytesRead: usage.bytesRead,
          baselineBytes: usage.baselineBytes,
          savedBytes: usage.savedBytes,
          tokensSaved: usage.tokensSaved,
          tokensCost: usage.tokensCost,
          netTokens: usage.netTokens,
          topFiles: usage.topFiles,
        },
        memory: { namespace: memoryNs, count: 0 },
        brains: brainStatus(runtime.brain, runtime.brains),
        counters: counters.snapshot(),
        recent: await recentMessages(logger),
        warnings: runtime.warnings,
        errors: runtime.error ? [runtime.error] : [],
      };

      if (!runtime.node) return base;

      try {
        const client = new XerjClient(runtime.node.baseUrl, undefined, observer);
        const [indices, summary] = await Promise.all([
          client.indices(),
          client.memorySummary(memoryNs).catch(() => null),
        ]);
        const datasets = datasetRows(
          indices,
          prefix,
          webPrefix(projectRoot),
          externalPrefix(projectRoot),
          memoryNs,
          runtime.brains,
        );
        const corpus = datasets.filter((dataset) => dataset.name !== "memory");

        return {
          ...base,
          index: {
            prefix,
            docs: corpus.reduce((total, dataset) => total + dataset.docs, 0),
            bytes: corpus.reduce((total, dataset) => total + dataset.bytes, 0),
            indices: corpus.filter((dataset) => dataset.docs > 0).length,
            datasets,
            ...corpusStatus(runtime.corpus),
          },
          memory: {
            namespace: memoryNs,
            count:
              summary?.count ??
              datasets.find((dataset) => dataset.name === "memory")?.docs ??
              0,
          },
        };
      } catch (error) {
        return { ...base, errors: [...base.errors, String(error)] };
      }
    };

    const registration = await ctx.rpc.register(XerjRpc, {
      status: async () => {
        counters.noteRpc();
        runtime.lifecycle?.touch();
        return snapshot();
      },
      reindex: async () => {
        counters.noteRpc();
        runtime.lifecycle?.touch();
        await Promise.all([
          runtime.corpus?.reindex(),
          runtime.web?.reindex(),
          runtime.hidden?.reindex(),
        ]);
        void runtime.brain?.runAll();
        // The pass ran before this returns, so the caller can report real
        // completion instead of a queue-only toast.
        const status = corpusStatus(runtime.corpus);
        return {
          queued:
            runtime.corpus !== null ||
            runtime.web !== null ||
            runtime.hidden !== null ||
            runtime.brain !== null,
          records: status.lastRecords,
        };
      },
      remember: async (input) => {
        counters.noteRpc();
        runtime.lifecycle?.touch();
        if (!runtime.memory) throw new Error("XERJ memory is not available yet");
        const args = input as { text: string };
        return runtime.memory.remember({ text: args.text });
      },
      search: async (input) => {
        counters.noteRpc();
        runtime.lifecycle?.touch();
        if (!runtime.search) throw new Error("XERJ search is not available yet");
        const args = input as { query: string };
        const result = await runtime.search.search(args.query);
        return { text: result.text, hits: result.hits.length, bytes: result.bytes };
      },
    });

    const summarize = async (): Promise<string> => {
      const status = await snapshot();
      if (status.index.docs === 0) {
        return `The local XERJ index for this project is not populated yet (${status.index.state}).`;
      }

      return [
        `Local XERJ index for this project: ${status.index.docs} records (${status.index.state}).`,
        "Use xerj_search for code and documentation questions, and xerj_def for a symbol.",
        "A cited passage is the file's current text: answer from it, and read the file only to edit it.",
        "Use xerj_recall before asking the user about earlier decisions.",
      ].join(" ");
    };

    const tools = buildTools({
      config,
      ledger,
      getSearch: () => runtime.search,
      getMemory: () => runtime.memory,
      getSpool: () => runtime.spool,
      getAnomaly: () => runtime.anomaly,
      snapshot,
    });

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "xerj",
        description: "Local XERJ search over this project. Prefer it to reading whole files.",
      });
      for (const tool of tools) editor.add(tool as never);
    });

    await ctx.tool.hook("execute.after", (event) =>
      handleToolResult(event as ToolResultEvent, {
        projectRoot,
        logger,
        spool: runtime.spool,
        invalidate: () => runtime.search?.invalidate(),
        touch: (sessionID) => runtime.lifecycle?.touch(sessionID),
        recordRead: (sessionID, path, bytes) =>
          ledger.recordRead(sessionID, path, bytes),
      }),
    );

    // Prompts this instance saw; scopes the server-wide event stream to this
    // project's sessions for memory capture.
    const prompts = new SessionPrompts();

    await registerSessionHooks(ctx, {
      config,
      logger,
      getSearch: () => runtime.search,
      getMemory: () => runtime.memory,
      summarize,
      onActivity: (sessionID) => runtime.lifecycle?.touch(sessionID),
      onInject: () => counters.noteInjection(),
      onNoiseSkip: () => counters.noteNoiseSkip(),
      onCost: (_sessionID, bytes) => void ledger.recordInjection(bytes),
      onPrompt: (sessionID, text) => prompts.note(sessionID, text),
      recordQuery: (sessionID, paths, bytes, hits) =>
        ledger.recordQuery(sessionID, paths, bytes, hits),
    });

    const shutdown = new AbortController();

    let client: XerjClient | null = null;
    let indexerStart: Promise<void> | null = null;

    /** Starts the indexers for a live node; idempotent per node lifetime. */
    const startIndexers = (handle: NodeHandle): Promise<void> => {
      if (indexerStart) return indexerStart;

      indexerStart = (async () => {
        // Runs before any pass so a mode change rebuilds from an empty corpus.
        const rebuilt = await reconcileEmbedMode({
          client: new XerjClient(handle.baseUrl),
          nodeDir,
          stateDir: corpusLayout(projectRoot, prefix, stateRoot).stateDir,
          mode: config.index.neural ? EmbedMode.Neural : EmbedMode.Lexical,
        }).catch((error: unknown) => {
          logger.warn("could not reconcile the embedding mode", {
            error: error instanceof Error ? error.message : String(error),
          });
          return false;
        });
        if (rebuilt) logger.info("rebuilding indices for the embedding mode");

        if (runtime.corpus === null && !overbroad) {
          runtime.corpus = new CorpusService({
            binaryPath: runtime.binary?.path ?? "",
            nodeUrl: handle.baseUrl,
            projectRoot,
            prefix,
            stateRoot,
            config,
            storage,
            logger,
            priority: config.node.priority,
            onRun: () => counters.noteIndexRun(),
            onChange: () => {
              runtime.search?.invalidate();
              void registration.events
                .emit("updated", { updatedAt: Date.now() })
                .catch(() => {});
            },
          });
          await runtime.corpus.start();
        }

        if (runtime.web === null && runtime.spool && client) {
          runtime.web = new CorpusService({
            binaryPath: runtime.binary?.path ?? "",
            nodeUrl: handle.baseUrl,
            projectRoot: runtime.spool.directory,
            prefix: webPrefix(projectRoot),
            stateRoot,
            config,
            storage,
            logger,
            priority: config.node.priority,
            onRun: () => counters.noteIndexRun(),
            onChange: () => {
              runtime.search?.invalidate();
              void registration.events
                .emit("updated", { updatedAt: Date.now() })
                .catch(() => {});
            },
          });
          await runtime.web.start();
        }

        if (runtime.hidden === null && runtime.hiddenRoots.length > 0 && client) {
          runtime.hidden = new HiddenIndex({
            client,
            projectRoot,
            prefix,
            roots: runtime.hiddenRoots,
            maxBytes: config.index.hiddenMaxBytes,
            logger,
            onRun: () => counters.noteIndexRun(),
            onChange: () => {
              runtime.search?.invalidate();
              void registration.events
                .emit("updated", { updatedAt: Date.now() })
                .catch(() => {});
            },
          });

          if (config.index.auto && !overbroad) await runtime.hidden.start();
        }

        if (runtime.brains.length > 0 && !overbroad) {
          runtime.brain = new BrainIndexer({
            binaryPath: runtime.binary?.path ?? "",
            nodeUrl: handle.baseUrl,
            stateRoot,
            config,
            specs: runtime.brains,
            logger,
            observer,
            onRun: () => counters.noteIndexRun(),
            onChange: () => {
              runtime.search?.invalidate();
              void registration.events
                .emit("updated", { updatedAt: Date.now() })
                .catch(() => {});
            },
          });

          // One-shot: graph indexing cannot run in watch mode. `index.auto`
          // gates startup runs only; an explicit reindex still works.
          if (config.index.auto) void runtime.brain.runAll();
        }
      })().finally(() => {
        indexerStart = null;
      });

      return indexerStart;
    };

    /** Stops every indexer process; the node itself is stopped by the caller. */
    const stopIndexers = async (): Promise<void> => {
      indexerStart = null;
      const corpus = runtime.corpus;
      const web = runtime.web;
      const hidden = runtime.hidden;
      runtime.corpus = null;
      runtime.web = null;
      runtime.hidden = null;

      await Promise.all([corpus?.stop(), web?.stop(), hidden?.stop()]);
    };

    // The node is project-scoped and managed through one runtime: it can be
    // started, stopped by the idle timer, and restarted by the next request.
    const nodes = new NodeRuntime({
      nodeDir,
      projectRoot,
      preferredPort: config.node.port,
      dataDir: engineDataDir,
      portLockPath: join(root, "nodes", ".port-lock"),
      explicitUrl: config.node.url,
      embedMode: config.index.neural ? EmbedMode.Neural : EmbedMode.Lexical,
      priority: config.node.priority,
      logger,
      binary: () => runtime.binary,
      onSpawned: () => counters.noteSpawn(),
      onStart: (handle) => {
        runtime.node = handle;
        client?.setBaseUrl(handle.baseUrl);
        // A start counts as activity; otherwise an immediate idle check would
        // shut down a node that was just brought up for a request.
        runtime.lifecycle?.touch();
        void startIndexers(handle);
      },
    });
    runtime.nodes = nodes;

    const lifecycle = new ProjectLifecycle({
      nodeDir,
      idleMs: config.node.idleMs,
      enabled: config.node.shutdownOnIdle && !config.node.url,
      logger,
      onIdle: async () => {
        // The timer keeps firing after the node is gone; act only if a node is
        // actually up, or a stopped project would log an idle stop every tick.
        if (nodes.snapshot.state !== "running") return;

        await stopIndexers();
        await nodes.stop("idle");
        await registration.events
          .emit("updated", { updatedAt: Date.now() })
          .catch(() => {});
      },
    });
    runtime.lifecycle = lifecycle;

    const bootstrapRuntime = async (): Promise<void> => {
      // An explicit path wins over download and detection: the user already
      // built or installed a binary, possibly for a platform we do not ship.
      const binary = config.binary.path
        ? await externalBinary(config.binary.path, logger)
        : info
          ? await ensureBinary({
              root,
              requested: config.binary.version,
              platform: process.platform,
              info,
              logger,
            })
          : null;
      if (!binary) return;
      runtime.binary = binary;

      // The client resolves the node on every call, so services can be built
      // before the node exists and keep working across an idle restart.
      client = new XerjClient(
        `http://127.0.0.1:${config.node.port}`,
        undefined,
        observer,
        {
          ensure: async () => (await nodes.ensure()).baseUrl,
          invalidate: () => nodes.invalidate(),
        },
      );
      runtime.search = new SearchService(
        client,
        [
          prefix,
          webPrefix(projectRoot),
          externalPrefix(projectRoot),
          ...runtime.brains.map((brain) => brain.prefix),
        ],
        logger,
        projectRoot,
        new BrainGraph({ client, brains: runtime.brains, logger }),
        runtime.brains,
        runtime.hiddenRoots.length > 0 ? `${prefix}-hidden-docs` : null,
      );
      runtime.memory = new MemoryStore(client, memoryNamespace(projectRoot), logger);
      runtime.anomaly = new AnomalyService(client, logger);

      // Subscribe before the node exists: a compaction can arrive while the
      // node is starting, and the memory write re-ensures it.
      if (config.memory.enabled && runtime.memory) {
        startCompactionCapture({
          events: ctx.event,
          memory: runtime.memory,
          signal: shutdown.signal,
          logger,
          owns: (sessionID) => prompts.knows(sessionID),
        });
        if (config.memory.captureTurns) {
          startTurnCapture({
            events: ctx.event,
            memory: runtime.memory,
            signal: shutdown.signal,
            logger,
            prompts,
          });
        }
      }

      // A refused root gets no node at startup: nothing will be indexed and the
      // process would only sit there until its idle timer. An explicit tool call
      // still spawns one on demand through the client.
      if (overbroad) {
        runtime.phase = "ready";
        logger.info("xerj is idle: the project root is too broad to index", { projectRoot });
        return;
      }

      // Project data moved into `<project>/.xerj`. Carry the old node directory
      // and spool over once, stopping a node still using the old tree first so
      // it cannot keep writing to a directory we are about to move.
      if (resolve(storageRoot) !== resolve(root)) {
        const legacyNodeDir = projectNodeDir(root, prefix);
        if (await pathExists(legacyNodeDir)) {
          if ((await detectNode(legacyNodeDir)).running) {
            await stopNode(legacyNodeDir).catch((error: unknown) => {
              logger.warn("could not stop the legacy xerj node", String(error));
            });
          }
        }
        await migrateProjectStorage(
          root,
          storageRoot,
          prefix,
          webPrefix(projectRoot),
          logger,
        ).catch((error: unknown) => {
          logger.warn("could not migrate project storage", String(error));
        });
      }

      // Start the heartbeat only after the legacy move: its first write creates
      // the node directory, and a non-empty target would make the migration
      // treat the empty project tree as already populated.
      lifecycle.start();
      startSessionTracking(ctx.event, lifecycle, shutdown.signal, logger);

      // Construct the spool after the move: init creates the spool directory,
      // and an eagerly created empty target would make the migration skip the
      // legacy pages.
      if (config.remote.enabled) {
        const spool = new RemoteSpool({
          root: storageRoot,
          projectRoot,
          prefix: webPrefix(projectRoot),
          externalPrefix: externalPrefix(projectRoot),
          maxBytes: config.remote.maxBytes,
          client,
          logger,
        });
        await spool.init();
        runtime.spool = spool;
      }

      // Memory cannot be rebuilt from the corpus, so carry it over before the
      // first start on a node data directory that predates the move. A node
      // that is already up has loaded its index list, so it has to restart once
      // for the copied index to appear.
      const migrated = await migrateMemoryIndex(
        join(root, "data"),
        engineDataDir,
        memoryNamespace(projectRoot),
        logger,
      ).catch((error: unknown) => {
        logger.warn("could not migrate project memory", String(error));
        return false;
      });
      if (migrated && (await nodes.detect()).running) {
        await nodes.stop("memory migration");
      }

      runtime.node = await nodes.ensure();

      // A memory index built by a different embedder is refused by the node and
      // reports unhealthy rather than failing loudly. Repair it before the first
      // recall so a broken store cannot pass as an empty one.
      if (config.memory.enabled) {
        await recoverMemoryIndex({
          client,
          nodeDir,
          namespace: memoryNamespace(projectRoot),
          logger,
        }).catch((error: unknown) => {
          logger.warn("could not check the memory index", String(error));
        });
      }

      await startIndexers(runtime.node);

      // Automatic memory grows with every turn, so its age and size caps are
      // enforced at startup and once an hour after that. Explicit memories are
      // exempt; only capture-written summaries expire.
      if (config.memory.enabled && runtime.memory) {
        startRetention(runtime.memory, config.memory.retain, shutdown.signal, logger);
      }

      runtime.phase = "ready";
      logger.info("xerj is ready", {
        url: runtime.node.baseUrl,
        version: runtime.node.version,
      });
    };

    const bootstrap = async (): Promise<void> => {
      try {
        if (!info && !config.binary.path) return;

        // Project state is created before the first tool call so a read-only
        // workspace surfaces here, not mid-session.
        await ensureProjectState(projectRoot);
        await bootstrapRuntime();
      } catch (error) {
        runtime.phase = "error";
        runtime.error = error instanceof Error ? error.message : String(error);
        logger.error("xerj failed to start", runtime.error);
      } finally {
        if (!shutdown.signal.aborted) {
          await registration.events.emit("updated", { updatedAt: Date.now() }).catch(() => {});
        }
      }
    };

    void bootstrap();

    return () => {
      shutdown.abort();

      void (async () => {
        try {
          await runtime.lifecycle?.stop();
          await stopIndexers();

          // This process's sessions are over. Stop the node only when no peer
          // process is still serving the project; otherwise its own idle timer
          // decides, and stopping here would break its next request.
          const peers = (await runtime.lifecycle?.peers()) ?? 0;
          if (peers === 0) await runtime.nodes?.stop("shutdown");

          await ledger.flush();
          await logger.flush();
          await registration.dispose();
        } catch {
          // Shutdown must never throw into the host.
        }
      })();
    };
  },
});

/** `.xerj/` holds the marker and caches; it must never be committed. */
async function ensureProjectState(projectRoot: string): Promise<void> {
  const directory = projectStateDir(projectRoot);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, ".gitignore"), "*\n", { flag: "wx" }).catch(() => {});
}

function corpusStatus(corpus: CorpusService | null): Pick<
  StatusSnapshot["index"],
  | "state"
  | "lastRunAt"
  | "lastGeneration"
  | "lastRecords"
  | "lastFiles"
  | "restarts"
  | "lastError"
> {
  const snapshot: CorpusSnapshot | null = corpus?.snapshot() ?? null;
  return {
    state: snapshot?.state ?? "disabled",
    lastRunAt: snapshot?.lastRun?.at ?? null,
    lastGeneration: snapshot?.lastRun?.generation ?? null,
    lastRecords: snapshot?.lastRun?.records ?? null,
    lastFiles: snapshot?.lastRun?.files ?? null,
    restarts: snapshot?.restarts ?? 0,
    lastError: snapshot?.lastError ?? null,
  };
}

/** Groups the node's indices into the corpora this plugin maintains. */
function datasetRows(
  indices: ReadonlyArray<IndexSummary>,
  project: string,
  web: string,
  external: string,
  memoryNs: string,
  brains: ReadonlyArray<BrainSpec>,
): DatasetStatus[] {
  const groups = [
    {
      name: "project",
      matches: (index: string) =>
        index.startsWith(`${project}-`) &&
        !index.startsWith(`${project}-hidden-`),
    },
    {
      name: "hidden",
      matches: (index: string) => index.startsWith(`${project}-hidden-`),
    },
    { name: "web", matches: (index: string) => index.startsWith(`${web}-`) },
    {
      name: "external",
      matches: (index: string) => index.startsWith(`${external}-`),
    },
    ...brains.map((brain) => ({
      name: `brain:${brain.name}`,
      matches: (index: string) => index.startsWith(`${brain.prefix}-`),
    })),
    {
      name: "memory",
      matches: (index: string) => index === `.xerj-memory-${memoryNs}`,
    },
  ];

  return groups
    .map((group) => {
      const matched = indices.filter((entry) => group.matches(entry.index));
      return {
        name: group.name,
        docs: matched.reduce((total, entry) => total + entry.docs, 0),
        bytes: matched.reduce((total, entry) => total + entry.bytes, 0),
      };
    })
    .filter((dataset) => dataset.docs > 0 || dataset.bytes > 0);
}


async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}


function brainStatus(
  indexer: BrainIndexer | null,
  specs: ReadonlyArray<BrainSpec>,
): BrainStatus[] {
  const runs: ReadonlyArray<BrainRun> =
    indexer?.snapshot() ??
    specs.map((spec) => ({
      name: spec.name,
      prefix: spec.prefix,
      at: 0,
      docs: 0,
      edges: 0,
      error: null,
    }));

  return runs.map((run) => ({
    name: run.name,
    prefix: run.prefix,
    docs: run.docs,
    edges: run.edges,
    lastRunAt: run.at === 0 ? null : run.at,
    error: run.error,
  }));
}

/** Warnings from an earlier process are history, not current health. */
const PROCESS_START = Date.now();

async function recentMessages(logger: Logger): Promise<string[]> {
  const entries = await logger.entries().catch(() => []);
  const now = Date.now();
  return entries
    .filter(
      (entry) =>
        (entry.level === "warn" || entry.level === "error") &&
        entry.at >= PROCESS_START,
    )
    .slice(-4)
    .map((entry) => `${entry.level}: ${entry.message} (${formatAge(now, entry.at)})`);
}


function asStorage(storage: Plugin.Context["storage"]): KeyValueStorage {
  return {
    get: (key) => storage.get(key),
    // The logger and ledger only ever write JSON values.
    set: (key, value) => storage.set(key, value as never),
  };
}
