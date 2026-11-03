// Server part. Loads config, brings up the binary and node in the background,
// and registers the tool and RPC surface. Nothing here blocks plugin load: a
// slow download or a missing node must not delay OpenCode startup.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin";
import { ensureBinary, type InstalledBinary } from "./binary/manager.ts";
import { loadConfig } from "./config.ts";
import { createLogger, type KeyValueStorage } from "./log.ts";
import { dataRoot, environmentFrom, indexPrefix, projectStateDir } from "./paths.ts";
import { releaseTarget } from "./platform.ts";
import {
  ensureNode,
  persistPort,
  readPersistedPort,
  type NodeHandle,
} from "./node/supervisor.ts";
import { XerjClient } from "./node/client.ts";
import { PLUGIN_VERSION, XerjRpc, type StatusSnapshot } from "./rpc.ts";

interface Runtime {
  phase: "starting" | "ready" | "error" | "disabled";
  binary: InstalledBinary | null;
  node: NodeHandle | null;
  error: string | null;
  warnings: string[];
}

const STATUS_TOOL = {
  name: "status",
  description:
    "Report the XERJ search node, project index, and retrieval counters. Use it to check whether local search is available before falling back to reading files.",
  input: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
} as const;

export default Plugin.define({
  id: "xerj",
  async setup(ctx) {
    const { config, warnings } = loadConfig(ctx.options, process.env);
    const storage = asStorage(ctx.storage);
    const logger = createLogger(storage);
    for (const warning of warnings) logger.warn(warning);

    const root = dataRoot(environmentFrom(process.env));
    const prefix = indexPrefix(ctx.location.directory);
    const runtime: Runtime = {
      phase: "starting",
      binary: null,
      node: null,
      error: null,
      warnings: [...warnings],
    };

    const info = releaseTarget(process.platform, process.arch);
    if (!info) {
      runtime.phase = "disabled";
      runtime.error = `unsupported platform: ${process.platform}/${process.arch}`;
      logger.error(runtime.error);
    }

    const snapshot = async (): Promise<StatusSnapshot> => {
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
        index: { prefix, docs: 0, bytes: 0, indices: 0 },
        usage: { queries: 0, hits: 0, hitRate: 0, bytesReturned: 0, tokensSaved: 0 },
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
          },
        };
      } catch (error) {
        return { ...base, errors: [...base.errors, String(error)] };
      }
    };

    const registration = await ctx.rpc.register(XerjRpc, {
      status: async () => snapshot(),
    });

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "xerj",
        description: "Local XERJ search over this project. Prefer it to reading whole files.",
      });
      editor.add({
        ...STATUS_TOOL,
        options: { namespace: "xerj" },
        execute: async () => ({
          content: JSON.stringify(await snapshot(), null, 2),
          metadata: { xerj: { kind: "status" } },
        }),
      });
    });

    const shutdown = new AbortController();

    const bootstrap = async (): Promise<void> => {
      try {
        if (!info) return;

        // Project state is created before the first tool call so the journal
        // and the read-only-workspace error both surface here, not mid-session.
        await ensureProjectState(ctx.location.directory);

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

        runtime.phase = "ready";
        logger.info("xerj is ready", {
          url: runtime.node.baseUrl,
          version: runtime.node.version,
        });
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
      logger
        .flush()
        .then(() => registration.dispose())
        .catch(() => {});
    };
  },
});

/** `.xerj/` holds the journal and caches; it must never be committed. */
async function ensureProjectState(projectRoot: string): Promise<void> {
  const directory = projectStateDir(projectRoot);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, ".gitignore"), "*\n", { flag: "wx" }).catch(() => {});
}

function asStorage(storage: Plugin.Context["storage"]): KeyValueStorage {
  return {
    get: (key) => storage.get(key),
    // The logger only ever writes JSON values.
    set: (key, value) => storage.set(key, value as never),
  };
}
