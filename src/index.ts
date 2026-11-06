// Server part. Loads config, brings up the binary and node in the background,
// and registers tools, hooks, and RPC. Nothing here blocks plugin load: a slow
// download or a missing node must not delay OpenCode startup.

import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { directoryBytes, fileBytes } from "./disk.ts";
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
import { reconcileCorpusMode } from "./node/corpus-mode.ts";
import { reconcileEmbedMode } from "./node/embed-mode.ts";
import { detectNode, EmbedMode, stopNode, type NodeHandle } from "./node/supervisor.ts";
import {
  brainSpecs,
  dataRoot,
  documentRoots,
  environmentFrom,
  externalPrefix,
  archivePrefix,
  gitPrefix,
  indexPrefix,
  isOverbroadRoot,
  memoryNamespace,
  nodeDataDir,
  nodeLogPath,
  prjdocsPrefix,
  projectBrainName,
  projectNodeDir,
  projectPath,
  projectStateDir,
  resolveStorageRoot,
  scopedStorageKey,
  sysdocsPrefix,
  type BrainSpec,
  type DocumentRoot,
  webPrefix,
} from "./paths.ts";
import {
  PLUGIN_VERSION,
  XerjRpc,
  type BrainStatus,
  type CorpusHealth,
  type DatasetStatus,
  type StatusSnapshot,
} from "./rpc.ts";
import { PrjdocsIndexer } from "./prjdocs/index.ts";
import { LatestVersions } from "./prjdocs/latest.ts";
import { SysdocIndexer } from "./sysdocs/index.ts";
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
import { CommitIndex, type CommitSummary } from "./index/commits.ts";
import { ArchiveIndex } from "./archive/index.ts";
import { TurnArchive } from "./archive/turns.ts";
import { registerCompactionArchive } from "./archive/window.ts";
import { memoryIndexMissing, recoverMemoryIndex } from "./memory/health.ts";
import { curateMemories } from "./memory/curate.ts";
import { verifyMemories } from "./memory/verify.ts";
import { sampleProcess } from "./process-stats.ts";
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
  /** Memories the verification pass flagged; reported in the panel. */
  staleMemories: number;
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
    staleMemories: 0,
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
    // Raw turns, so a compacted session can still be expanded. Off means the
    // expand tool is not registered either.
    const archive = config.context.archiveEnabled
      ? new TurnArchive({
          directory: join(nodeDir, "archive"),
          logger,
          maxBytes: config.context.archiveMaxBytes,
        })
      : null;
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
          prjdocsKeywords: config.prjdocs.eagerKeywords,
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
        memory: { namespace: memoryNs, count: 0, exists: false, stale: 0 },
        brains: brainStatus(runtime.brain, runtime.brains),
        corpora: corpusHealth(runtime),
        // The engine data and the node log were invisible before: a project
        // could occupy gigabytes with only document counts to show for it.
        disk: {
          engineBytes: await directoryBytes(engineDataDir),
          logBytes:
            (await fileBytes(nodeLogPath(nodeDir))) +
            (await fileBytes(`${nodeLogPath(nodeDir)}.1`)),
        },
        counters: counters.snapshot(),
        recent: await recentMessages(logger),
        warnings: runtime.warnings,
        errors: runtime.error ? [runtime.error] : [],
        map: [],
        frameworks: [],
        process: null,
        embeddings: false,
      };

      if (!runtime.node) return base;

      try {
        const client = new XerjClient(runtime.node.baseUrl, undefined, observer);
        const [indices, summary, overview] = await Promise.all([
          client.indices(),
          client.memorySummary(memoryNs).catch(() => null),
          config.index.graph
            ? client
                .get(
                  `/_graph/${encodeURIComponent(projectBrainName(projectRoot))}/overview`,
                  "graph overview failed",
                )
                .catch(() => null)
            : Promise.resolve(null),
        ]);
        const datasets = datasetRows(
          indices,
          prefix,
          gitPrefix(projectRoot),
          webPrefix(projectRoot),
          externalPrefix(projectRoot),
          sysdocsPrefix(hostname()),
          memoryNs,
          runtime.brains,
        );
        const corpus = datasets.filter((dataset) => dataset.name !== "memory");

        // Fill document counts from the same listing, so each corpus row shows
        // what is actually stored rather than only whether the service runs.
        // The graph's live edge total comes from its own overview; a run
        // document counts edges written, not edges that still exist.
        const edgeTotal =
          overview !== null &&
          typeof overview === "object" &&
          "edges" in overview &&
          typeof (overview as { edges: unknown }).edges === "object" &&
          (overview as { edges: { total?: unknown } }).edges?.total;

        const corpora = base.corpora.map((row) => {
          const docs = datasets.find((dataset) => dataset.name === row.name)?.docs ?? 0;
          // A last pass can outlive its index: a mode change or a reset drops
          // the index and the run record still claims what it wrote.
          const missing = docs === 0 && (row.records ?? 0) > 0;
          return {
            ...row,
            docs,
            records: missing ? 0 : row.records,
            state: missing ? "missing" : row.state,
            error: missing
              ? `index is missing; the last pass wrote ${row.records ?? 0} records`
              : row.error,
            edges:
              row.name === "project" && typeof edgeTotal === "number"
                ? edgeTotal
                : row.edges,
          };
        });

        const frameworks = await frameworkRows(client, prjdocsPrefix(projectRoot)).catch(
          () => [] as StatusSnapshot["frameworks"],
        );
        const map = await recordKinds(client, prefix).catch(
          () => [] as StatusSnapshot["map"],
        );
        const pid = runtime.node?.pid ?? null;
        const usageNow = pid === null ? null : await sampleProcess(pid).catch(() => null);

        return {
          ...base,
          corpora,
          map,
          frameworks,
          process: usageNow === null ? null : { cpuPercent: usageNow.cpuPercent, memoryBytes: usageNow.memoryBytes },
          // The node embeds only while a pass runs, and only when the index was
          // built with the semantic field set.
          // A pass reports `starting` while it runs; the node embeds only when
          // the index carries a semantic field, which is why semantics gates it.
          embeddings:
            config.index.semantic && corpusStatus(runtime.corpus).state === "starting",
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
            stale: runtime.staleMemories,
            count:
              summary?.count ??
              datasets.find((dataset) => dataset.name === "memory")?.docs ??
              0,
            exists:
              summary?.exists ?? datasets.some((dataset) => dataset.name === "memory"),
          },
        };
      } catch (error) {
        return { ...base, errors: [...base.errors, String(error)] };
      }
    };

    // Both documentation corpora are reachable as RPC methods, TUI commands,
    // and tools, so the work lives in one place and the three surfaces only
    // differ in how they report it.
    const runPrjdocs = async (input: unknown) => {
        const ensured = runtime.node
          ? { handle: runtime.node, failure: null }
          : await nodes
              .ensure()
              .then((handle) => ({ handle, failure: null }))
              .catch((error: unknown) => ({ handle: null, failure: errorText(error) }));

        if (ensured.handle === null) {
          throw new Error(
            ensured.failure === null
              ? "the XERJ node is not available"
              : `the XERJ node did not start: ${ensured.failure}`,
          );
        }
        const handle = ensured.handle;

        const client = new XerjClient(handle.baseUrl);
        const latest = new LatestVersions({ logger, signal: shutdown.signal });
        // Eager mode asks the host for its model and its search provider; both
        // are optional, and the heuristic covers a missing model.
        const wanted =
          typeof input === "object" && input !== null && "eager" in input
            ? (input as { eager?: unknown }).eager
            : undefined;
        const askedKeywords =
          typeof input === "object" && input !== null && "keywords" in input
            ? (input as { keywords?: unknown }).keywords
            : undefined;
        const keywords = [
          ...config.prjdocs.eagerKeywords,
          ...(Array.isArray(askedKeywords)
            ? askedKeywords.filter((entry): entry is string => typeof entry === "string")
            : []),
        ];
        const eagerMode =
          (typeof wanted === "boolean" ? wanted : config.prjdocs.eager)
            ? {
                maxPages: config.prjdocs.eagerMaxPages,
                maxDepth: config.prjdocs.eagerMaxDepth,
                maxModelCalls: config.prjdocs.eagerModelCalls,
                keywords,
                generate: (prompt: string) =>
                  ctx.experimental.generate.text({ prompt }).then((answer) => answer.text),
                search: ctx.websearch,
              }
            : undefined;
        // The docs branch follows the wire version this node reports, so the
        // Elasticsearch reference matches the API the engine answers with.
        const banner = await client.info().catch(() => null);
        const indexer = new PrjdocsIndexer({
          client,
          builtin: {
            enabled: config.prjdocs.builtin,
            elasticsearchVersion: banner?.wireVersion ?? "8.13",
            xerjPages: config.prjdocs.builtinXerjPages,
            elasticsearchPages: config.prjdocs.builtinElasticsearchPages,
            refreshDays: config.prjdocs.builtinRefreshDays,
            eager: eagerMode !== undefined,
          },
          prefix: prjdocsPrefix(projectRoot),
          projectRoot,
          stateDir: join(nodeDir, "prjdocs"),
          logger,
          maxTargets: config.prjdocs.maxTargets,
          maxPages: config.prjdocs.maxPages > 0 ? config.prjdocs.maxPages : undefined,
          signal: shutdown.signal,
          latestVersion: (ref) => latest.resolve(ref),
          eager: eagerMode,
        });

        const summary = await indexer.run();
        counters.noteIndexRun();
        void registration.events.emit("updated", { updatedAt: Date.now() }).catch(() => {});
        logger.info("project docs indexed", {
          techs: summary.techs.length,
          targets: summary.targets,
          indexed: summary.indexed,
          pruned: summary.pruned,
        });
        return summary;
    };

    /** Git history as a corpus; cheap, so it runs with every index pass. */
    const runCommits = async (): Promise<CommitSummary | null> => {
      if (!config.index.git) return null;
      const handle = runtime.node ?? (await nodes.ensure().catch(() => null));
      if (handle === null) return null;

      const index = new CommitIndex({
        client: new XerjClient(handle.baseUrl),
        indexName: `${gitPrefix(projectRoot)}-docs`,
        projectRoot,
        statePath: join(nodeDir, "git", "commits.json"),
        logger,
        limit: config.index.gitLimit,
        signal: shutdown.signal,
      });
      const summary = await index.run().catch((error: unknown) => {
        logger.debug("could not index git history", String(error));
        return null;
      });
      if (summary !== null) runtime.search?.invalidate();
      return summary;
    };

    /** Turns, when the archive is on. Cheap: a few hundred small documents. */
    const runArchive = async (): Promise<void> => {
      if (archive === null) return;
      const handle = runtime.node ?? (await nodes.ensure().catch(() => null));
      if (handle === null) return;

      await new ArchiveIndex({
        client: new XerjClient(handle.baseUrl),
        indexName: `${archivePrefix(projectRoot)}-docs`,
        directory: join(nodeDir, "archive"),
        statePath: join(nodeDir, "archive", "index.json"),
        logger,
        signal: shutdown.signal,
      })
        .run()
        .then(() => runtime.search?.invalidate())
        .catch((error: unknown) => {
          logger.debug("could not index the turn archive", String(error));
        });
    };

    const runReindex = async () => {
      await Promise.all([
        runtime.corpus?.reindex(),
        runtime.web?.reindex(),
        runtime.hidden?.reindex(),
      ]);
      void runtime.brain?.runAll();
      void runCommits();
      void runArchive();
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
    };

    const runSysdocs = async () => {
        const ensured = runtime.node
          ? { handle: runtime.node, failure: null }
          : await nodes
              .ensure()
              .then((handle) => ({ handle, failure: null }))
              .catch((error: unknown) => ({ handle: null, failure: errorText(error) }));

        if (ensured.handle === null || runtime.binary === null) {
          throw new Error(
            ensured.failure === null
              ? "the XERJ node is not available"
              : `the XERJ node did not start: ${ensured.failure}`,
          );
        }
        const handle = ensured.handle;

        const client = new XerjClient(handle.baseUrl);
        const indexer = new SysdocIndexer({
          client,
          prefix: sysdocsPrefix(hostname()),
          stateDir: join(nodeDir, "sysdocs"),
          logger,
          maxDocs: config.sysdocs.maxDocs,
          maxBytesPerDoc: config.sysdocs.maxBytesPerDoc,
          manDirs: config.sysdocs.manDirs.length > 0 ? config.sysdocs.manDirs : undefined,
          infoDirs: config.sysdocs.infoDirs.length > 0 ? config.sysdocs.infoDirs : undefined,
        });

        const summary = await indexer.run();
        counters.noteIndexRun();
        void registration.events.emit("updated", { updatedAt: Date.now() }).catch(() => {});
        logger.info("system docs indexed", { ...summary });
        return summary;
    };

    const registration = await ctx.rpc.register(XerjRpc, {
      status: async () => {
        counters.noteRpc();
        runtime.lifecycle?.touch();
        return snapshot();
      },
      prjdocs: async (input: unknown) => {
        counters.noteRpc();
        runtime.lifecycle?.touch();
        return runPrjdocs(input).catch((error: unknown) => {
          logger.warn("project docs failed", errorText(error));
          throw error;
        });
      },
      sysdocs: async () => {
        counters.noteRpc();
        runtime.lifecycle?.touch();
        // A command that fails in another project has to leave a trace: the
        // toast is the user's only other view of it.
        return runSysdocs().catch((error: unknown) => {
          logger.warn("system docs failed", errorText(error));
          throw error;
        });
      },
      reindex: async () => {
        counters.noteRpc();
        runtime.lifecycle?.touch();
        return runReindex().catch((error: unknown) => {
          logger.warn("reindex failed", errorText(error));
          throw error;
        });
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
      // Compaction belongs to the host; this only asks for it now instead of
      // waiting for the harness to decide. Nothing is rewritten here.
      wrapup: async (input) => {
        counters.noteRpc();
        runtime.lifecycle?.touch();
        const args = input as { sessionID?: string };
        const sessionID =
          args.sessionID ?? runtime.lifecycle?.latestSession() ?? null;
        if (sessionID === null) {
          return { compacted: false, sessionID: null, detail: "no active session" };
        }

        try {
          await ctx.session.compact({ sessionID });
          return { compacted: true, sessionID, detail: "the host compacted this session" };
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return { compacted: false, sessionID, detail };
        }
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
      projectRoot,
      getArchive: () => archive,
      ledger,
      logger,
      getClient: () =>
        runtime.node === null ? null : new XerjClient(runtime.node.baseUrl),
      getSearch: () => runtime.search,
      getMemory: () => runtime.memory,
      getSpool: () => runtime.spool,
      getAnomaly: () => runtime.anomaly,
      snapshot,
    });

    // The documentation corpora are also tools: an agent should not have to ask
    // for a command to be run in the TUI.
    const docsTools = [
      {
        name: "reindex",
        description:
          "Run an incremental index pass over the project, the fetched pages, and the hidden folders now. Use it when search looks stale after edits.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "xerj" },
        execute: async () => {
          const result = await runReindex();
          return {
            content: `reindexed · ${result.records ?? "?"} records`,
            metadata: { xerj: { ...result } },
          };
        },
      },
      {
        name: "sysdocs",
        description:
          "Index this machine's man and info pages. Skips pages already indexed, prunes pages that vanished, and makes them searchable through xerj_search.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "xerj" },
        execute: async () => {
          const summary = await runSysdocs();
          return {
            content:
              `system docs: ${summary.indexed} indexed, ${summary.skipped} unchanged, ` +
              `${summary.pruned} pruned (${summary.discovered} discovered)`,
            metadata: { xerj: { ...summary } },
          };
        },
      },
      {
        name: "prjdocs",
        description:
          "Index official documentation for this project's languages, frameworks, and cloud APIs at the versions it uses and the latest. Prunes pages for versions no longer used.",
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
                "Extra terms to document even though the project does not use them, for example a library you plan to adopt. Eager mode only.",
            },
          },
          additionalProperties: false,
        },
        execute: async (input: unknown) => {
          const summary = await runPrjdocs(input);
          return {
            content:
              `project docs: ${summary.indexed} indexed, ${summary.skipped} unchanged, ` +
              `${summary.pruned} pruned across ${summary.techs.length} technologies`,
            metadata: { xerj: { ...summary } },
          };
        },
      },
    ];

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "xerj",
        description: "Local XERJ search over this project. Prefer it to reading whole files.",
      });
      for (const tool of [...tools, ...docsTools]) editor.add(tool as never);
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
    const shutdown = new AbortController();

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
      onPromptArchive: (sessionID, text) => void archive?.append(sessionID, "user", text),
      signal: shutdown.signal,
      projectRoot,
      recordQuery: (sessionID, paths, bytes, hits) =>
        ledger.recordQuery(sessionID, paths, bytes, hits),
    });

    // The compaction hook sees the window before the summary exists, so it is
    // the only place that can archive tool output a summary will compress away.
    if (archive !== null) {
      await registerCompactionArchive(ctx, {
        archive,
        logger,
        owns: (sessionID) => prompts.knows(sessionID),
      });
    }

    let client: XerjClient | null = null;
    let indexerStart: Promise<void> | null = null;

    /** Tells the UI that a corpus changed, so the sidebar refreshes. */
    const publishChange = (): void => {
      runtime.search?.invalidate();
      void registration.events
        .emit("updated", { updatedAt: Date.now() })
        .catch(() => {});
    };

    /**
     * Runs before any pass so a mode change rebuilds from an empty corpus
     * rather than mixing vectors from two embedders. A failure is logged and
     * indexing continues: an unreconciled mode is a warning, not a stop.
     */
    const reconcileMode = async (handle: NodeHandle): Promise<void> => {
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

      // A corpus built with `--no-graph` cannot be continued on the graph path;
      // the engine refuses rather than mixing two authorities. Switching
      // `index.graph` therefore rebuilds the project corpus once.
      const reshaped = await reconcileCorpusMode({
        client: new XerjClient(handle.baseUrl),
        nodeDir,
        stateDir: corpusLayout(projectRoot, prefix, stateRoot).stateDir,
        mode: config.index.graph ? "graph" : "flat",
        projectPrefix: prefix,
      }).catch((error: unknown) => {
        logger.warn("could not reconcile the corpus mode", {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      });
      if (reshaped) {
        logger.info("rebuilding the project corpus for graph mode", {
          graph: config.index.graph,
        });
      }
    };

    const startProjectIndexer = async (handle: NodeHandle): Promise<void> => {
      if (runtime.corpus !== null || overbroad) return;

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
        cpus: config.node.cpus,
        onRun: () => counters.noteIndexRun(),
        onChange: publishChange,
      });
      await runtime.corpus.start();
      // History and the turn archive are small and independent of the project
      // corpus, so they start after it and never delay it.
      void runCommits();
      void runArchive();
    };

    const startWebIndexer = async (handle: NodeHandle): Promise<void> => {
      if (runtime.web !== null || runtime.spool === null || client === null) return;

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
        cpus: config.node.cpus,
        onRun: () => counters.noteIndexRun(),
        onChange: publishChange,
      });
      await runtime.web.start();
    };

    const startHiddenIndexer = async (): Promise<void> => {
      if (runtime.hidden !== null || runtime.hiddenRoots.length === 0 || client === null) {
        return;
      }

      runtime.hidden = new HiddenIndex({
        client,
        projectRoot,
        prefix,
        roots: runtime.hiddenRoots,
        maxBytes: config.index.hiddenMaxBytes,
        logger,
        onRun: () => counters.noteIndexRun(),
        onChange: publishChange,
      });
      if (config.index.auto && !overbroad) await runtime.hidden.start();
    };

    const startBrainIndexer = (handle: NodeHandle): void => {
      if (runtime.brains.length === 0 || overbroad) return;

      runtime.brain = new BrainIndexer({
        binaryPath: runtime.binary?.path ?? "",
        nodeUrl: handle.baseUrl,
        stateRoot,
        config,
        specs: runtime.brains,
        logger,
        priority: config.node.priority,
        cpus: config.node.cpus,
        observer,
        onRun: () => counters.noteIndexRun(),
        onChange: publishChange,
      });

      // One-shot: graph indexing cannot run in watch mode. `index.auto` gates
      // startup runs only; an explicit reindex still works.
      if (config.index.auto) void runtime.brain.runAll();
    };

    /** Starts the indexers for a live node; idempotent per node lifetime. */
    const startIndexers = (handle: NodeHandle): Promise<void> => {
      if (indexerStart) return indexerStart;

      indexerStart = (async () => {
        await reconcileMode(handle);
        await startProjectIndexer(handle);
        await startWebIndexer(handle);
        await startHiddenIndexer();
        startBrainIndexer(handle);
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
      logMaxBytes: config.node.logMaxBytes,
      priority: config.node.priority,
      cpus: config.node.cpus,
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

    // The startup sequence is long because each step depends on the one above
    // it owning something (a node, a spool, a journal). Each step is named here
    // so the order is readable and a failure points at a step, not a line.

    /** Moves project state into `<project>/.xerj` once, before anything reads it. */
    const migrateLegacyState = async (): Promise<void> => {
      if (resolve(storageRoot) === resolve(root)) return;

      // A node still running from the old tree must stop first, or it keeps
      // writing into the directory being moved.
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
    };

    /**
     * Builds the document spool after the move: init creates the spool
     * directory, and an eagerly created empty target would make the migration
     * skip the legacy pages.
     */
    const startRemoteSpool = async (activeClient: XerjClient): Promise<void> => {
      if (!config.remote.enabled) return;

      const spool = new RemoteSpool({
        root: storageRoot,
        projectRoot,
        prefix: webPrefix(projectRoot),
        externalPrefix: externalPrefix(projectRoot),
        maxBytes: config.remote.maxBytes,
        client: activeClient,
        logger,
      });
      await spool.init();
      runtime.spool = spool;
    };

    /**
     * Memory cannot be rebuilt from the corpus, so carry it over before the
     * first start. A node that is already up has loaded its index list, so it
     * restarts once for the copied index to appear.
     */
    const migrateMemory = async (): Promise<void> => {
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
    };

    /**
     * A memory index built by a different embedder is refused by the node and
     * reports unhealthy rather than failing loudly, so repair it before the
     * first recall. Automatic memory is then bounded by its age and size caps.
     */
    const repairMemory = async (activeClient: XerjClient): Promise<void> => {
      if (!config.memory.enabled) return;

      await recoverMemoryIndex({
        client: activeClient,
        nodeDir,
        namespace: memoryNamespace(projectRoot),
        logger,
      }).catch((error: unknown) => {
        logger.warn("could not check the memory index", String(error));
      });

      // A corpus without a memory index means memories stored earlier are
      // gone. An empty store looks the same, so say it once at startup.
      const indices = await activeClient.indices().catch(() => []);
      if (memoryIndexMissing(indices, memoryNamespace(projectRoot), prefix)) {
        logger.warn(
          "the memory index is missing",
          "memories stored earlier were not found; the next remember recreates it",
        );
      }

      if (runtime.memory) {
        startRetention(runtime.memory, config.memory.retain, shutdown.signal, logger);
      }
    };

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
          gitPrefix(projectRoot),
          archivePrefix(projectRoot),
          webPrefix(projectRoot),
          externalPrefix(projectRoot),
          sysdocsPrefix(hostname()),
          ...runtime.brains.map((brain) => brain.prefix),
        ],
        logger,
        projectRoot,
        new BrainGraph({
          client,
          // Graph mode makes the project corpus itself a brain, so its hits get
          // the same one-hop expansion. Shadowing stays on the configured
          // brains: a hidden whole file is only replaced by a section from the
          // same folder, and projecting that onto the whole repo would drop
          // notes that the project corpus legitimately does not cover.
          brains: config.index.graph
            ? [
                ...runtime.brains,
                {
                  name: projectBrainName(projectRoot),
                  label: ".",
                  directory: projectRoot,
                  prefix,
                  // Measured on this repo: sequence edges (adjacent sections of
                  // one file) added tokens without adding answers, while
                  // pathcite edges are the cross-file references worth a hop.
                  pathciteOnly: true,
                },
              ]
            : runtime.brains,
          logger,
        }),
        runtime.brains,
        runtime.hiddenRoots.length > 0 ? `${prefix}-hidden-docs` : null,
      );
      runtime.memory = new MemoryStore(client, memoryNamespace(projectRoot), logger);
      runtime.anomaly = new AnomalyService(client, logger);

      // A memory that names a file which no longer exists is misleading, not
      // wrong: flag it and leave the text alone. Read-only, no model call.
      void verifyMemories({
        memory: runtime.memory,
        projectRoot,
        logger,
        signal: shutdown.signal,
      })
        .then((summary) => {
          runtime.staleMemories = summary.stale;
          if (summary.stale > 0) {
            logger.info("some memories name paths that no longer exist", {
              stale: summary.stale,
              checked: summary.checked,
            });
          }
        })
        .catch((error: unknown) => {
          logger.debug("memory verification failed", String(error));
        });

      // Restatements accumulate because each turn stores a summary. Exact
      // duplicates of generated prose are dropped; anything else is flagged.
      void curateMemories({
        memory: runtime.memory,
        logger,
        signal: shutdown.signal,
      })
        .then((summary) => {
          if (summary.merged > 0 || summary.flagged > 0) {
            logger.info("memory curated", {
              merged: summary.merged,
              flagged: summary.flagged,
              checked: summary.checked,
            });
          }
        })
        .catch((error: unknown) => {
          logger.debug("memory curation failed", String(error));
        });

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
            onAnswer: (sessionID, text) => void archive?.append(sessionID, "assistant", text),
          });
        }
      }

      // A refused root gets no node at startup: nothing will be indexed and the
      // process would only sit there until its idle timer.
      if (overbroad) {
        runtime.phase = "ready";
        logger.info("xerj is idle: the project root is too broad to index", { projectRoot });
        return;
      }

      await migrateLegacyState();

      // Start the heartbeat only after the legacy move: its first write creates
      // the node directory, and a non-empty target would make the migration
      // treat the empty project tree as already populated.
      lifecycle.start();
      startSessionTracking(ctx.event, lifecycle, shutdown.signal, logger);

      await startRemoteSpool(client);
      await migrateMemory();

      runtime.node = await nodes.ensure();
      await repairMemory(client);
      await startIndexers(runtime.node);

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

/**
 * Documentation per technology from the project-docs corpus. A `terms`
 * aggregation on `tech` counts documents; a `sum` of the stored body size
 * gives each technology its bytes, so the panel can show what each costs.
 */
async function frameworkRows(
  client: XerjClient,
  prefix: string,
): Promise<StatusSnapshot["frameworks"]> {
  const response = await client.post(
    `/${prefix}-docs/_search`,
    {
      size: 0,
      aggs: {
        techs: {
          terms: { field: "tech", size: 100 },
          aggs: { size: { sum: { field: "bytes" } } },
        },
      },
    },
    "could not read the documentation breakdown",
  );

  const buckets =
    (response as {
      aggregations?: { techs?: { buckets?: Array<{ key?: unknown; doc_count?: unknown; size?: { value?: unknown } }> } };
    }).aggregations?.techs?.buckets ?? [];

  return buckets
    .map((bucket) => ({
      tech: typeof bucket.key === "string" ? bucket.key : String(bucket.key ?? "unknown"),
      docs: typeof bucket.doc_count === "number" ? bucket.doc_count : 0,
      bytes: typeof bucket.size?.value === "number" ? Math.round(bucket.size.value) : 0,
    }))
    .sort((left, right) => right.bytes - left.bytes);
}

/**
 * What the project corpus holds, by record kind. A data map answers "what do
 * you know about this repository" in one line, which a document count cannot.
 */
async function recordKinds(
  client: XerjClient,
  prefix: string,
): Promise<StatusSnapshot["map"]> {
  const response = await client.post(
    `/${prefix}-docs/_search`,
    { size: 0, aggs: { kinds: { terms: { field: "kind", size: 12 } } } },
    "could not read the record map",
  );

  const buckets =
    (response as {
      aggregations?: { kinds?: { buckets?: Array<{ key?: unknown; doc_count?: unknown }> } };
    }).aggregations?.kinds?.buckets ?? [];

  return buckets
    .map((bucket) => ({
      kind: typeof bucket.key === "string" ? bucket.key : String(bucket.key ?? "unknown"),
      docs: typeof bucket.doc_count === "number" ? bucket.doc_count : 0,
    }))
    .sort((left, right) => right.docs - left.docs);
}

/** One line of an error, for the log ring. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/**
 * One row per corpus this instance maintains, so a corpus that fails to write
 * is visible even when its index is empty. State and errors come from the
 * running services; document counts are filled in from the index listing.
 */
function corpusHealth(runtime: Runtime): CorpusHealth[] {
  const rows: CorpusHealth[] = [
    {
      name: "project",
      state: runtime.corpus?.snapshot().state ?? "disabled",
      docs: null,
      lastRunAt: runtime.corpus?.snapshot().lastRun?.at ?? null,
      records: runtime.corpus?.snapshot().lastRun?.records ?? null,
      edges: null,
      error: runtime.corpus?.snapshot().lastError ?? null,
    },
  ];

  if (runtime.web !== null) {
    const run = runtime.web.snapshot();
    rows.push({
      name: "web",
      state: run.state,
      docs: null,
      lastRunAt: run.lastRun?.at ?? null,
      records: run.lastRun?.records ?? null,
      edges: null,
      error: run.lastError,
    });
  }

  // A brain is a corpus too: it writes documents and edges for its folder, and
  // its own failures belong in the same list as the others.
  for (const brain of brainStatus(runtime.brain, runtime.brains)) {
    rows.push({
      name: `brain:${brain.name}`,
      state:
        brain.error !== null
          ? "error"
          : brain.lastRunAt === null
            ? "starting"
            : "watching",
      docs: brain.docs,
      lastRunAt: brain.lastRunAt,
      records: null,
      edges: brain.edges,
      error: brain.error,
    });
  }

  if (runtime.hidden !== null) {
    const hidden = runtime.hidden.snapshot();
    rows.push({
      name: "hidden",
      state:
        hidden.error !== null
          ? "error"
          : hidden.lastRunAt === null
            ? "starting"
            : "watching",
      docs: hidden.docs,
      lastRunAt: hidden.lastRunAt,
      records: null,
      edges: null,
      error: hidden.error,
    });
  }

  return rows;
}

/** Groups the node's indices into the corpora this plugin maintains. */
function datasetRows(
  indices: ReadonlyArray<IndexSummary>,
  project: string,
  git: string,
  web: string,
  external: string,
  sysdocs: string,
  memoryNs: string,
  brains: ReadonlyArray<BrainSpec>,
): DatasetStatus[] {
  const groups = [
    {
      name: "project",
      matches: (index: string) =>
        index.startsWith(`${project}-`) &&
        !index.startsWith(`${project}-hidden-`) &&
        !index.startsWith(`${project}-prjdocs-`) &&
        !index.startsWith(`${project}-archive-`) &&
        !index.startsWith(`${git}-`),
    },
    { name: "git", matches: (index: string) => index.startsWith(`${git}-`) },
    {
      name: "archive",
      matches: (index: string) => index.startsWith(`${project}-archive-`),
    },
    {
      name: "hidden",
      matches: (index: string) => index.startsWith(`${project}-hidden-`),
    },
    {
      name: "prjdocs",
      matches: (index: string) => index.startsWith(`${project}-prjdocs-`),
    },
    { name: "web", matches: (index: string) => index.startsWith(`${web}-`) },
    {
      name: "external",
      matches: (index: string) => index.startsWith(`${external}-`),
    },
    {
      name: "sysdocs",
      matches: (index: string) => index.startsWith(`${sysdocs}-`),
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
