// Server part. Loads config, brings up the binary and node in the background,
// and registers tools, hooks, and RPC. Nothing here blocks plugin load: a slow
// download or a missing node must not delay OpenCode startup.

import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { Plugin } from "@opencode/plugin";
import { detectRuntime } from "./binary/detect.ts";
import { ensureBinary, externalBinary, type InstalledBinary } from "./binary/manager.ts";
import { loadConfig } from "./config.ts";
import { registerSessionHooks } from "./hooks/session.ts";
import { BrainIndexer, type BrainRun } from "./index/brain.ts";
import { HiddenIndex } from "./index/hidden.ts";
import { CorpusService, type CorpusSnapshot } from "./index/watcher.ts";
import { createLogger, type KeyValueStorage, type Logger } from "./log.ts";
import { XerjClient, type IndexSummary } from "./node/client.ts";
import {
  ensureNode,
  persistPort,
  readPersistedPort,
  type NodeHandle,
} from "./node/supervisor.ts";
import {
  brainSpecs,
  dataRoot,
  documentRoots,
  environmentFrom,
  externalPrefix,
  indexPrefix,
  memoryNamespace,
  projectStateDir,
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
import { RemoteSpool } from "./remote/spool.ts";
import { shellReadPaths } from "./remote/shell.ts";
import { BrainGraph } from "./search/brains.ts";
import { SearchService } from "./search/service.ts";
import { Ledger } from "./stats/ledger.ts";
import { AnomalyService } from "./telemetry/anomaly.ts";
import { buildTools } from "./tools/search.ts";

interface Runtime {
  phase: "starting" | "ready" | "error" | "disabled";
  binary: InstalledBinary | null;
  node: NodeHandle | null;
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
    const logger = createLogger(storage);
    for (const warning of warnings) logger.warn(warning);

    const root = dataRoot(environmentFrom(process.env));
    // The location may be a subdirectory of the project; index the project root
    // so a session opened in `docs/` does not create a second corpus.
    const projectRoot = ctx.location.project.canonical;
    const prefix = indexPrefix(projectRoot);
    const brains = brainSpecs(projectRoot, config.index.brain);
    const hiddenRoots = documentRoots(projectRoot, config.index.hidden);
    const runtime: Runtime = {
      phase: "starting",
      binary: null,
      node: null,
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
      warnings: [...warnings],
    };

    const ledger = new Ledger({
      storage,
      projectRoot,
      bytesPerToken: config.stats.bytesPerToken,
      maxBaselineBytes: config.stats.maxBaselineBytes,
      logger,
    });

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

    const snapshot = async (): Promise<StatusSnapshot> => {
      const usage = ledger.snapshot();
      const base: StatusSnapshot = {
        pluginVersion: PLUGIN_VERSION,
        updatedAt: Date.now(),
        node: {
          phase: runtime.phase,
          baseUrl: runtime.node?.baseUrl ?? null,
          serverVersion: runtime.node?.version ?? null,
          spawned: runtime.node?.spawned ?? false,
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
          topFiles: usage.topFiles,
        },
        memory: { namespace: memoryNs, count: 0 },
        brains: brainStatus(runtime.brain, runtime.brains),
        recent: await recentMessages(logger),
        warnings: runtime.warnings,
        errors: runtime.error ? [runtime.error] : [],
      };

      if (!runtime.node) return base;

      try {
        const client = new XerjClient(runtime.node.baseUrl);
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
      status: async () => snapshot(),
      reindex: async () => {
        await Promise.all([
          runtime.corpus?.reindex(),
          runtime.web?.reindex(),
          runtime.hidden?.reindex(),
        ]);
        void runtime.brain?.runAll();
        return {
          queued:
            runtime.corpus !== null ||
            runtime.web !== null ||
            runtime.hidden !== null ||
            runtime.brain !== null,
        };
      },
      remember: async (input) => {
        if (!runtime.memory) throw new Error("XERJ memory is not available yet");
        const args = input as { text: string };
        return runtime.memory.remember({ text: args.text });
      },
      search: async (input) => {
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
        "Prefer a cited passage over reading whole files.",
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

    await ctx.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed") return;

      // Any tool that fetched a URL (webfetch, MCP extract, search) can spool
      // its text. A short result is an error or a list, not a document. The
      // spool is fire-and-forget, like the other ingests: the write is local,
      // and a failure must not delay or fail the tool result.
      const urlInput = event.input as { url?: unknown } | null;
      const url = typeof urlInput?.url === "string" ? urlInput.url : null;
      const content = typeof event.result.content === "string" ? event.result.content : null;
      if (url !== null && content !== null && content.length >= 200 && runtime.spool) {
        void runtime.spool
          .ingestUrl(url, content)
          .then((stored) => {
            if (stored) runtime.search?.invalidate();
          })
          .catch((error: unknown) => {
            logger.debug("could not spool a fetched document", String(error));
          });
      }

      // Bash reads are invisible per file, so parse the command for literal
      // file references and index only existing files outside the project.
      if (event.tool === "bash" || event.tool === "shell") {
        const bashInput = event.input as {
          command?: unknown;
          cwd?: unknown;
          workdir?: unknown;
          directory?: unknown;
        } | null;
        const command = typeof bashInput?.command === "string" ? bashInput.command : null;
        const spool = runtime.spool;
        if (command === null || !spool) return;

        const read = await shellReadPaths(command, toolCwd(bashInput, projectRoot));
        const paths = read.filter((path) => isOutside(projectRoot, path));
        if (paths.length === 0) return;

        void Promise.all(
          paths.map((path) =>
            spool.ingestExternalFile(path, { skipUnchanged: true }).catch(() => null),
          ),
        )
          .then((stored) => {
            if (stored.some((entry) => entry !== null)) runtime.search?.invalidate();
          })
          .catch((error: unknown) => {
            logger.debug("could not index a shell-read file", String(error));
          });
        return;
      }

      if (event.tool !== "read") return;

      // OpenCode's built-in read uses `filePath`; other tool packs use `path`.
      const input = event.input as { filePath?: unknown; path?: unknown } | null;
      const filePath =
        typeof input?.filePath === "string"
          ? input.filePath
          : typeof input?.path === "string"
            ? input.path
            : null;
      if (filePath === null) return;
      await ledger.recordRead(event.sessionID, filePath, contentBytes(event.result.content));

      // A read outside the project is the only signal that the file matters.
      // Index it in the background so the read itself is not delayed.
      if (runtime.spool && isOutside(projectRoot, filePath)) {
        void runtime.spool
          .ingestExternalFile(filePath, { skipUnchanged: true })
          .then((stored) => {
            if (stored) runtime.search?.invalidate();
          })
          .catch((error: unknown) => {
            logger.debug("could not index an external file", String(error));
          });
      }
    });

    await registerSessionHooks(ctx, {
      config,
      logger,
      getSearch: () => runtime.search,
      getMemory: () => runtime.memory,
      summarize,
      recordQuery: (sessionID, paths, bytes, hits) =>
        ledger.recordQuery(sessionID, paths, bytes, hits),
    });

    const shutdown = new AbortController();

    const bootstrap = async (): Promise<void> => {
      try {
        if (!info && !config.binary.path) return;

        // Project state is created before the first tool call so a read-only
        // workspace surfaces here, not mid-session.
        await ensureProjectState(projectRoot);

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

        runtime.node = await ensureNode({
          binaryPath: binary.path,
          binaryVersion: binary.version,
          root,
          dataDir: config.node.dataDir,
          preferredPort: config.node.port,
          persistedPort: await readPersistedPort(root),
          explicitUrl: config.node.url,
          onPort: (port) => persistPort(root, port),
          logger,
        });

        const client = new XerjClient(runtime.node.baseUrl);
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

        if (config.remote.enabled) {
          const spool = new RemoteSpool({
            root,
            projectRoot,
            prefix: webPrefix(projectRoot),
            externalPrefix: externalPrefix(projectRoot),
            maxBytes: config.remote.maxBytes,
            client,
            logger,
          });
          await spool.init();
          runtime.spool = spool;

          runtime.web = new CorpusService({
            binaryPath: runtime.binary.path,
            nodeUrl: runtime.node.baseUrl,
            projectRoot: spool.directory,
            prefix: webPrefix(projectRoot),
            dataRoot: root,
            config,
            storage,
            logger,
            onChange: () => {
              runtime.search?.invalidate();
              void registration.events
                .emit("updated", { updatedAt: Date.now() })
                .catch(() => {});
            },
          });
          await runtime.web.start();
        }

        runtime.phase = "ready";
        logger.info("xerj is ready", {
          url: runtime.node.baseUrl,
          version: runtime.node.version,
        });

        runtime.corpus = new CorpusService({
          binaryPath: runtime.binary.path,
          nodeUrl: runtime.node.baseUrl,
          projectRoot,
          prefix,
          dataRoot: root,
          config,
          storage,
          logger,
          onChange: () => {
            runtime.search?.invalidate();
            void registration.events
              .emit("updated", { updatedAt: Date.now() })
              .catch(() => {});
          },
        });
        await runtime.corpus.start();

        if (runtime.hiddenRoots.length > 0) {
          runtime.hidden = new HiddenIndex({
            client,
            projectRoot,
            prefix,
            roots: runtime.hiddenRoots,
            maxBytes: config.index.hiddenMaxBytes,
            logger,
            onChange: () => {
              runtime.search?.invalidate();
              void registration.events
                .emit("updated", { updatedAt: Date.now() })
                .catch(() => {});
            },
          });

          if (config.index.auto) await runtime.hidden.start();
        }

        if (runtime.brains.length > 0) {
          runtime.brain = new BrainIndexer({
            binaryPath: binary.path,
            nodeUrl: runtime.node.baseUrl,
            dataRoot: root,
            config,
            specs: runtime.brains,
            logger,
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

        await registration.events.emit("updated", { updatedAt: Date.now() });
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
      const corpus = runtime.corpus;
      const web = runtime.web;
      const hidden = runtime.hidden;
      runtime.corpus = null;
      runtime.web = null;
      runtime.hidden = null;

      void Promise.all([corpus?.stop(), web?.stop(), hidden?.stop()])
        .then(() => ledger.flush())
        .then(() => logger.flush())
        .then(() => registration.dispose())
        .catch(() => {});
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
  "state" | "lastRunAt" | "lastGeneration" | "lastRecords" | "restarts" | "lastError"
> {
  const snapshot: CorpusSnapshot | null = corpus?.snapshot() ?? null;
  return {
    state: snapshot?.state ?? "disabled",
    lastRunAt: snapshot?.lastRun?.at ?? null,
    lastGeneration: snapshot?.lastRun?.generation ?? null,
    lastRecords: snapshot?.lastRun?.records ?? null,
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

function toolCwd(input: unknown, fallback: string): string {
  if (typeof input !== "object" || input === null) return fallback;

  const record = input as Record<string, unknown>;
  for (const key of ["cwd", "workdir", "directory"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return isAbsolute(value) ? resolve(value) : resolve(fallback, value);
    }
  }
  return fallback;
}

function isOutside(root: string, filePath: string): boolean {
  const base = resolve(root);
  const absolute = resolve(filePath);
  return absolute !== base && !absolute.startsWith(base + sep);
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

async function recentMessages(logger: Logger): Promise<string[]> {
  const entries = await logger.entries().catch(() => []);
  return entries
    .filter((entry) => entry.level === "warn" || entry.level === "error")
    .slice(-4)
    .map((entry) => `${entry.level}: ${entry.message}`);
}

function contentBytes(content: unknown): number {
  if (typeof content === "string") return Buffer.byteLength(content, "utf8");
  if (!Array.isArray(content)) return 0;

  return content.reduce((total, entry) => {
    if (typeof entry === "object" && entry !== null && "text" in entry) {
      const text = (entry as { text?: unknown }).text;
      if (typeof text === "string") return total + Buffer.byteLength(text, "utf8");
    }
    return total;
  }, 0);
}

function asStorage(storage: Plugin.Context["storage"]): KeyValueStorage {
  return {
    get: (key) => storage.get(key),
    // The logger and ledger only ever write JSON values.
    set: (key, value) => storage.set(key, value as never),
  };
}
