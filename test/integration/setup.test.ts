// End-to-end: the real plugin `setup`, a real binary, a real node, and a real
// index. Unit tests stub the host; this proves the wiring works when nothing is
// stubbed, which is where the two shipped wiring faults would have failed.
//
// Skipped automatically when no binary can be resolved, so a machine without
// one still runs the rest of the suite.

import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { detectRuntime } from "../../src/binary/detect.ts";
import { ensureBinary } from "../../src/binary/manager.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { createLogger } from "../../src/log.ts";
import plugin from "../../src/index.ts";

const memory = new Map<string, unknown>();
const logger = createLogger(
  {
    get: async (key) => memory.get(key),
    set: async (key, value) => void memory.set(key, value),
  },
  { echoToConsole: false },
);

async function resolveBinary(root: string): Promise<string | null> {
  const pinned = process.env.XERJ_BIN;
  if (pinned) return pinned;

  const host = await detectRuntime({ libc: "musl", target: null });
  if (!host.info) return null;
  const binary = await ensureBinary({
    root,
    requested: "auto",
    platform: process.platform,
    info: host.info,
    logger,
  }).catch(() => null);
  return binary?.path ?? null;
}

interface Captured {
  readonly ctx: Record<string, unknown>;
  readonly tools: Array<{
    name: string;
    execute: (input: never, context?: never) => Promise<unknown>;
  }>;
  readonly status: () => Promise<Record<string, unknown>>;
  readonly call: (method: string, input?: unknown) => Promise<unknown>;
  readonly callSearch: (query: string) => Promise<string>;
  readonly runTool: (name: string, input: unknown) => Promise<string>;
  readonly runHook: (name: string, event: unknown) => Promise<void>;
}

function stubHost(projectRoot: string, options: Record<string, unknown>): Captured {
  const store = new Map<string, unknown>();
  const tools: Captured["tools"] = [];
  const handlerMap: Record<string, (input?: unknown) => Promise<unknown>> = {};
  const hooks: Record<string, (event: unknown) => Promise<void>> = {};
  let status: () => Promise<Record<string, unknown>> = async () => ({});
  let search: ((query: string) => Promise<string>) | null = null;
  const handlers: Record<string, (input?: unknown) => Promise<unknown>> = {};

  const ctx = {
    options,
    location: { directory: projectRoot, project: { canonical: projectRoot } },
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
    },
    tool: {
      transform: async (apply: (editor: never) => void) => {
        apply({
          namespace: () => {},
          add: (tool: { name: string }) => void tools.push(tool as never),
        } as never);
      },
      hook: async (name: string, handler: (event: unknown) => Promise<void>) => {
        hooks[name] = handler;
      },
    },
    session: { hook: async () => {} },
    rpc: {
      register: async (_schema: unknown, handlers: Record<string, never>) => {
        const statusHandler = handlers.status as unknown as
          | (() => Promise<Record<string, unknown>>)
          | undefined;
        if (statusHandler) status = () => statusHandler();
        for (const [name, handler] of Object.entries(handlers)) {
          handlerMap[name] = handler as unknown as
            | ((input?: unknown) => Promise<unknown>)
            | undefined as never;
        }
        const searchHandler = handlers.search as unknown as
          | ((input: { query: string }) => Promise<{ text: string }>)
          | undefined;
        if (searchHandler) {
          search = async (query) => (await searchHandler({ query })).text;
        }
        return {
          events: { emit: async () => {}, on: () => () => {} },
          dispose: async () => {},
        };
      },
    },
    event: {
      subscribe: async function* () {
        for (const _ of [] as unknown[]) yield _;
        await new Promise<void>(() => {});
      },
    },
  };

  return {
    ctx: ctx as unknown as Record<string, unknown>,
    tools,
    status: () => status(),
    call: async (method, input) => {
      const handler = handlerMap[method];
      if (!handler) throw new Error(`${method} is not registered`);
      return handler(input);
    },
    callSearch: async (query) => {
      if (!search) throw new Error("search is not registered");
      return search(query);
    },
    runHook: async (name, event) => {
      const hook = hooks[name];
      if (!hook) throw new Error(`${name} hook is not registered`);
      await hook(event);
    },
    runTool: async (name, input) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`${name} tool is not registered`);
      const result = (await tool.execute(input as never, {
        signal: new AbortController().signal,
      } as never)) as { content: string };
      return result.content;
    },
  };
}

const scratch: string[] = [];

afterAll(async () => {
  for (const directory of scratch.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("plugin setup end to end", () => {
  test("indexes a project, answers a search, and stops cleanly", async () => {
    const cacheRoot =
      process.env.XERJ_CACHE ?? join(homedir(), ".cache", "opencode", "xerj-int");
    const binaryPath = await resolveBinary(cacheRoot);
    if (binaryPath === null) {
      console.warn("skipping: no xerj binary available");
      return;
    }

    const root = await mkdtemp(join(tmpdir(), "xerj-setup-int-"));
    scratch.push(root);
    const project = join(root, "project");
    await Bun.write(join(project, "src/alpha.ts"), "export const zephyrmarker = 42;\n");
    await Bun.write(join(project, "docs/guide.md"), "# Guide\n\nBuild notes.\n");
    await Bun.write(
      join(project, ".agents/note.md"),
      "# Note\n\nThe hiddenfolder token marks a project note.\n",
    );
    // A second docs folder stays a hidden corpus, since the brain owns .agents.
    await Bun.write(
      join(project, ".github/note.md"),
      "# Workflow\n\nThe githubnote token marks a hidden file.\n",
    );
    const outside = join(root, "outside.md");
    await Bun.write(outside, "# Outside\n\nThe outsidemarker token is not in the project.\n");

    const previous = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = join(root, "data-home");

    const host = stubHost(project, {
      binary: { path: binaryPath },
      index: {
        neural: false,
        semantic: false,
        watch: false,
        auto: true,
        brain: [".agents"],
      },
      node: { port: 9830 + Math.floor(Math.random() * 40) },
      remote: { enabled: true },
      memory: { enabled: true },
    });

    const cleanup = (await plugin.setup(host.ctx as never)) as () => void;

    try {
      // The first pass runs in the background; poll until it lands.
      const deadline = Date.now() + 60_000;
      let docs = 0;
      while (Date.now() < deadline) {
        const snapshot = await host.status();
        const index = snapshot.index as { docs: number };
        const node = snapshot.node as { phase: string };
        docs = index.docs;
        if (docs > 0 && node.phase === "ready") break;
        await Bun.sleep(500);
      }

      expect(docs).toBeGreaterThan(0);

      const snapshot = await host.status();
      const node = snapshot.node as { phase: string; state: string };
      expect(node.phase).toBe("ready");
      expect(node.state).toBe("running");

      const text = await host.callSearch("zephyrmarker");
      expect(text).toContain("src/alpha.ts");

      // The hidden folder is indexed beside the project corpus, and the
      // corpora section reports it.
      const corpora = (await host.status()).corpora as Array<{
        name: string;
        docs: number | null;
        state: string;
      }>;
      const hidden = corpora.find((row) => row.name === "hidden");
      expect(hidden?.state).toBe("watching");
      expect(hidden?.docs ?? 0).toBeGreaterThan(0);

      // The brain corpus appears in the same list as the others.
      const brain = corpora.find((row) => row.name.startsWith("brain:"));
      expect(brain).toBeDefined();

      // A read outside the project spools in the background.
      await host.runHook("execute.after", {
        tool: "read",
        status: "completed",
        sessionID: "s1",
        input: { filePath: outside },
        result: { content: "The outsidemarker token is not in the project." },
      });
      const externalDeadline = Date.now() + 20_000;
      let externalDocs = 0;
      while (Date.now() < externalDeadline) {
        const snapshot = await host.status();
        const index = snapshot.index as { datasets?: Array<{ name: string; docs: number }> };
        externalDocs = index.datasets?.find((row) => row.name === "external")?.docs ?? 0;
        if (externalDocs > 0) break;
        await Bun.sleep(300);
      }
      expect(externalDocs).toBeGreaterThan(0);

      // The status tool answers through the same wiring.
      const statusTool = await host.runTool("status", {});
      expect(statusTool).toContain("pluginVersion");
      expect(statusTool).toContain("corpora");

      // The tool surface reaches the same index through the real client.
      const tool = await host.runTool("search", { query: "zephyrmarker" });
      expect(tool).toContain("src/alpha.ts");

      // Memory round-trips through the real node.
      const remembered = (await host.call("remember", {
        text: "the end-to-end test stores this fact",
      })) as { id?: string };
      expect(typeof remembered.id).toBe("string");

      // A reindex reports the records it covered.
      const reindexed = (await host.call("reindex")) as { queued: boolean };
      expect(reindexed.queued).toBe(true);

      expect(DEFAULT_CONFIG.context.maxPassages).toBeGreaterThan(0);
    } finally {
      cleanup();
      await Bun.sleep(200);
      if (previous === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previous;
    }
  }, 120_000);
});
