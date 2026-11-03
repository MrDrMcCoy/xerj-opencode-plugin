// Server part. Loads config, brings up the binary and node in the background,
// and registers tools, hooks, and RPC. Nothing here blocks plugin load: a slow
// download or a missing node must not delay OpenCode startup.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin";
import { ensureBinary, type InstalledBinary } from "./binary/manager.ts";
import { loadConfig } from "./config.ts";
import { registerSessionHooks } from "./hooks/session.ts";
import { CorpusService, type CorpusSnapshot } from "./index/watcher.ts";
import { createLogger, type KeyValueStorage } from "./log.ts";
import { XerjClient } from "./node/client.ts";
import {
  ensureNode,
  persistPort,
  readPersistedPort,
  type NodeHandle,
} from "./node/supervisor.ts";
import { dataRoot, environmentFrom, indexPrefix, projectStateDir } from "./paths.ts";
import { releaseTarget } from "./platform.ts";
import { PLUGIN_VERSION, XerjRpc, type StatusSnapshot } from "./rpc.ts";
import { SearchService } from "./search/service.ts";
import { Ledger } from "./stats/ledger.ts";
import { buildTools } from "./tools/search.ts";

interface Runtime {
  phase: "starting" | "ready" | "error" | "disabled";
  binary: InstalledBinary | null;
  node: NodeHandle | null;
  corpus: CorpusService | null;
  search: SearchService | null;
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
    const runtime: Runtime = {
      phase: "starting",
      binary: null,
      node: null,
      corpus: null,
      search: null,
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

    const info = releaseTarget(process.platform, process.arch);
    if (!info) {
      runtime.phase = "disabled";
      runtime.error = `unsupported platform: ${process.platform}/${process.arch}`;
      logger.error(runtime.error);
    }

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
        },
        index: {
          prefix,
          docs: 0,
          bytes: 0,
          indices: 0,
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
          tokensSaved: usage.tokensSaved,
        },
        warnings: runtime.warnings,
        errors: runtime.error ? [runtime.error] : [],
      };

      if (!runtime.node) return base;

      try {
        const client = new XerjClient(runtime.node.baseUrl);
        const indices = await client.indices();
        const mine = indices.filter((entry) => entry.index.startsWith(`${prefix}-`));
        return {
          ...base,
          index: {
            prefix,
            docs: mine.reduce((total, entry) => total + entry.docs, 0),
            bytes: mine.reduce((total, entry) => total + entry.bytes, 0),
            indices: mine.length,
            ...corpusStatus(runtime.corpus),
          },
        };
      } catch (error) {
        return { ...base, errors: [...base.errors, String(error)] };
      }
    };

    const registration = await ctx.rpc.register(XerjRpc, {
      status: async () => snapshot(),
      reindex: async () => {
        await runtime.corpus?.reindex();
        return { queued: runtime.corpus !== null };
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
      if (event.tool !== "read" || event.status !== "completed") return;

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
    });

    await registerSessionHooks(ctx, {
      config,
      logger,
      getSearch: () => runtime.search,
      summarize,
      recordQuery: (sessionID, paths, bytes, hits) =>
        ledger.recordQuery(sessionID, paths, bytes, hits),
    });

    const shutdown = new AbortController();

    const bootstrap = async (): Promise<void> => {
      try {
        if (!info) return;

        // Project state is created before the first tool call so a read-only
        // workspace surfaces here, not mid-session.
        await ensureProjectState(projectRoot);

        runtime.binary = await ensureBinary({
          root,
          requested: config.binary.version,
          platform: process.platform,
          info,
          logger,
        });

        runtime.node = await ensureNode({
          binaryPath: runtime.binary.path,
          binaryVersion: runtime.binary.version,
          root,
          dataDir: config.node.dataDir,
          preferredPort: config.node.port,
          persistedPort: await readPersistedPort(root),
          explicitUrl: config.node.url,
          onPort: (port) => persistPort(root, port),
          logger,
        });

        runtime.search = new SearchService(
          new XerjClient(runtime.node.baseUrl),
          prefix,
          logger,
          projectRoot,
        );

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
            void registration.events
              .emit("updated", { updatedAt: Date.now() })
              .catch(() => {});
          },
        });
        await runtime.corpus.start();

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
      runtime.corpus = null;

      void (corpus?.stop() ?? Promise.resolve())
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
