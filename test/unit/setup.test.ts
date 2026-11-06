// The server part is pure wiring: options in, services constructed, hooks and
// RPC registered. Both shipped faults in this layer were wiring mistakes that
// typechecking cannot see, so this drives the real setup against a stub host.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../../src/index.ts";

type Handler = (event: unknown) => Promise<void> | void;

interface Stub {
  readonly ctx: Record<string, unknown>;
  readonly tools: string[];
  readonly namespaces: string[];
  readonly toolHooks: string[];
  readonly sessionHooks: string[];
  readonly rpcMethods: string[];
  readonly call: (method: string, input?: unknown) => Promise<unknown>;
  readonly status: () => Promise<Record<string, unknown>>;
  emitters: Array<() => void>;
  disposed: number;
}

function stubHost(projectRoot: string, options: Record<string, unknown> = {}): Stub {
  const store = new Map<string, unknown>();
  const tools: string[] = [];
  const namespaces: string[] = [];
  const toolHooks: string[] = [];
  const sessionHooks: string[] = [];
  const rpcMethods: string[] = [];
  const emitters: Array<() => void> = [];
  let status: () => Promise<Record<string, unknown>> = async () => ({});
  const handlersByName: Record<string, (input?: unknown) => Promise<unknown>> = {};

  const ctx = {
    options,
    location: {
      directory: projectRoot,
      project: { canonical: projectRoot },
    },
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    },
    tool: {
      transform: async (apply: (editor: { namespace: (ns: { name: string }) => void; add: (tool: { name: string }) => void }) => void) => {
        apply({
          namespace: (namespace) => {
            namespaces.push(namespace.name);
          },
          add: (tool) => {
            tools.push(tool.name);
          },
        });
      },
      hook: async (name: string, handler: Handler) => {
        toolHooks.push(name);
        void handler;
      },
    },
    session: {
      hook: async (name: string) => {
        sessionHooks.push(name);
      },
    },
    rpc: {
      register: async (
        _schema: unknown,
        handlers: Record<string, (...args: never[]) => Promise<unknown>>,
      ) => {
        for (const name of Object.keys(handlers)) {
          rpcMethods.push(name);
          const handler = handlers[name];
          if (handler !== undefined) {
            handlersByName[name] = (input?: unknown) => handler(input as never);
          }
        }
        const statusHandler = handlers.status;
        if (statusHandler !== undefined) {
          status = async () => (await statusHandler()) as Record<string, unknown>;
        }
        return {
          events: {
            emit: async () => {},
            on: () => () => {},
          },
          dispose: async () => {
            stubState.disposed += 1;
          },
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

  const stubState: Stub = {
    ctx,
    tools,
    namespaces,
    toolHooks,
    sessionHooks,
    rpcMethods,
    call: async (method, input) => {
      const handler = handlersByName[method];
      if (handler === undefined) throw new Error(`${method} is not registered`);
      return handler(input);
    },
    status: () => status(),
    emitters,
    disposed: 0,
  };
  return stubState;
}

describe("server setup wiring", () => {
  test("registers the tools, hooks, and rpc methods", async () => {
    const project = await mkdtemp(join(tmpdir(), "xerj-setup-"));
    const host = stubHost(project);

    try {
      const cleanup = (await plugin.setup(host.ctx as never)) as () => void;

      expect(host.namespaces).toEqual(["xerj"]);
      expect([...host.tools].sort()).toEqual([
        "anomaly",
        "def",
        "forget",
        "index",
        "recall",
        "remember",
        "search",
        "status",
      ]);
      expect(host.tools.length).toBe(8);
      expect(host.toolHooks).toContain("execute.after");
      expect(host.sessionHooks).toContain("prompt");
      expect(host.sessionHooks).toContain("context");
      expect(host.rpcMethods.sort()).toEqual(["reindex", "remember", "search", "status"]);

      const snapshot = await host.status();
      expect(snapshot.pluginVersion).toBeString();
      expect(snapshot.index).toBeDefined();

      cleanup?.();
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("surfaces a configuration warning without failing setup", async () => {
    const project = await mkdtemp(join(tmpdir(), "xerj-setup-"));
    const host = stubHost(project, {
      binary: { target: "not-a-real-target" },
    });

    try {
      const cleanup = (await plugin.setup(host.ctx as never)) as () => void;
      const snapshot = await host.status();
      const warnings = snapshot.warnings as string[];

      expect(warnings.join("\n")).toContain("binary.target");
      cleanup?.();
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("refuses to index the home directory", async () => {
    const home = process.env.HOME ?? "/root";
    const host = stubHost(home);

    try {
      const cleanup = (await plugin.setup(host.ctx as never)) as () => void;
      const snapshot = await host.status();
      const warnings = snapshot.warnings as string[];

      expect(warnings.join("\n")).toContain("too broad");
      cleanup?.();
    } finally {
      // Nothing was created under the home directory by this instance.
    }
  });

  test("honours a disabled index without starting a corpus", async () => {
    const project = await mkdtemp(join(tmpdir(), "xerj-setup-"));
    const host = stubHost(project, {
      binary: { target: "not-a-real-target" },
      index: { auto: false, watch: false },
    });

    try {
      const cleanup = (await plugin.setup(host.ctx as never)) as () => void;
      const snapshot = await host.status();
      const index = snapshot.index as { state: string };

      // No corpus exists when indexing is off, so the state reports disabled.
      expect(index.state).toBe("disabled");
      cleanup?.();
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("setup never throws and returns a cleanup function", async () => {
    const project = await mkdtemp(join(tmpdir(), "xerj-setup-"));
    const host = stubHost(project, { storage: { root: "/" } });

    try {
      const cleanup = await plugin.setup(host.ctx as never);
      expect(typeof cleanup).toBe("function");
      (cleanup as () => void)();
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("server rpc handlers", () => {
  test("reindex reports nothing queued when indexing is off", async () => {
    const project = await mkdtemp(join(tmpdir(), "xerj-setup-"));
    const host = stubHost(project, { index: { auto: false, watch: false } });

    try {
      const cleanup = (await plugin.setup(host.ctx as never)) as () => void;
      const result = (await host.call("reindex")) as { queued: boolean; records: number | null };

      expect(result.queued).toBe(false);
      expect(result.records).toBeNull();
      cleanup?.();
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("remember and search answer clearly before the node exists", async () => {
    const project = await mkdtemp(join(tmpdir(), "xerj-setup-"));
    const host = stubHost(project, { index: { auto: false, watch: false } });

    try {
      const cleanup = (await plugin.setup(host.ctx as never)) as () => void;

      const remember = host.call("remember", { text: "a fact" });
      await expect(remember).rejects.toThrow("memory is not available");
      const search = host.call("search", { query: "anything" });
      await expect(search).rejects.toThrow("search is not available");
      cleanup?.();
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});
