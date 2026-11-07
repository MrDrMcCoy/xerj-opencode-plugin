// The server part is pure wiring: options in, services constructed, hooks and
// RPC registered. Both shipped faults in this layer were wiring mistakes that
// typechecking cannot see, so this drives the real setup against a stub host.

import { describe, expect, setSystemTime, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  readonly runToolHook: (name: string, event: unknown) => Promise<void>;
  readonly status: () => Promise<Record<string, unknown>>;
  emitters: Array<() => void>;
  disposed: number;
}

function stubHost(projectRoot: string, options: Record<string, unknown> = {}): Stub {
  const store = new Map<string, unknown>();
  const tools: string[] = [];
  const namespaces: string[] = [];
  const toolHooks: string[] = [];
  const toolHandlers = new Map<string, Handler>();
  const sessionHooks: string[] = [];
  const rpcMethods: string[] = [];
  const emitters: Array<() => void> = [];
  let status: () => Promise<Record<string, unknown>> = async () => ({});
  const handlersByName: Record<string, (input?: unknown) => Promise<unknown>> = {};

  const ctx = {
    // Telemetry writes to the real data root; these tests must not pollute it.
    options: {
      telemetry: { enabled: false },
      memory: { distill: { enabled: false } },
      ...options,
    },
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
        toolHandlers.set(name, handler);
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
    runToolHook: async (name, event) => {
      const handler = toolHandlers.get(name);
      if (handler === undefined) throw new Error(`${name} is not registered`);
      await handler(event);
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
    // A missing binary keeps the test to wiring: no download, no spawn.
    const host = stubHost(project, { binary: { path: join(project, "absent-xerj") } });

    try {
      const cleanup = (await plugin.setup(host.ctx as never)) as () => void;

      expect(host.namespaces).toEqual(["xerj"]);
      expect([...host.tools].sort()).toEqual([
        "anomaly",
        "ask",
        "ast",
        "callers",
        "code",
        "complexity",
        "dataset",
        "def",
        "dreamer",
        "expand",
        "find",
        "forget",
        "hub",
        "impact",
        "imports",
        "index",
        "inspect",
        "notes",
        "out",
        "outline",
        "prjdocs",
        "recall",
        "refs",
        "reindex",
        "remember",
        "run",
        "search",
        "status",
        "sysdocs",
        "telemetry",
        "zoom",
      ]);
      expect(host.tools.length).toBe(31);
      expect(host.toolHooks).toContain("execute.before");
      expect(host.toolHooks).toContain("execute.after");
      expect(host.sessionHooks).toContain("prompt");
      expect(host.sessionHooks).toContain("context");
      expect(host.rpcMethods.sort()).toEqual([
        "dreamer",
        "prjdocs",
        "reindex",
        "remember",
        "search",
        "status",
        "sysdocs",
        "uiLog",
        "wrapup",
      ]);

      const snapshot = await host.status();
      expect(snapshot.pluginVersion).toBeString();
      expect(snapshot.index).toBeDefined();

      // Every corpus this instance maintains reports its own health.
      const corpora = snapshot.corpora as Array<{ name: string; state: string }>;
      expect(corpora.map((row) => row.name)).toContain("project");

      cleanup?.();
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("surfaces a configuration warning without failing setup", async () => {
    const project = await mkdtemp(join(tmpdir(), "xerj-setup-"));
    const host = stubHost(project, {
      binary: { path: join(project, "absent-xerj"), target: "not-a-real-target" },
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
    const host = stubHost(home, { binary: { path: join(home, "absent-xerj") } });

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
      binary: { path: join(project, "absent-xerj") },
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
    const host = stubHost(project, {
      storage: { root: "/" },
      binary: { path: join(project, "absent-xerj") },
    });

    try {
      const cleanup = await plugin.setup(host.ctx as never);
      expect(typeof cleanup).toBe("function");
      (cleanup as () => void)();
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("bootstrap retry", () => {
  // A failed install or node start used to be final: the plugin stayed
  // `error` until the process restarted. A status call is the retry trigger.
  test("a later status call tries the bootstrap again", async () => {
    const project = await mkdtemp(join(tmpdir(), "xerj-setup-"));
    const script = join(project, "fake-xerj");
    const counter = join(project, "count");
    await writeFile(
      script,
      '#!/bin/sh\necho x >> "$(dirname "$0")/count"\nexit 1\n',
    );
    await chmod(script, 0o755);
    const host = stubHost(project, { binary: { path: script } });
    const realNow = Date.now();
    const attempts = async (): Promise<number> => {
      const raw = await readFile(counter, "utf8").catch(() => "");
      return raw.trim().split("\n").filter((line) => line.length > 0).length;
    };

    try {
      const cleanup = (await plugin.setup(host.ctx as never)) as () => void;
      await Bun.sleep(100);
      expect(await attempts()).toBe(1);

      // Past the one-minute cooldown; the next status read retries.
      setSystemTime(new Date(realNow + 61_000));
      await host.status();
      await Bun.sleep(150);
      expect(await attempts()).toBe(2);

      cleanup?.();
    } finally {
      setSystemTime();
      await rm(project, { recursive: true, force: true });
    }
  }, 10_000);
});

describe("cmd.blockPipes", () => {
  const event = (command: string, tool = "bash") => ({
    tool,
    input: { command },
  });

  test("is off by default", async () => {
    const project = await mkdtemp(join(tmpdir(), "xerj-setup-"));
    const host = stubHost(project, {
      binary: { path: join(project, "absent-xerj") },
    });

    try {
      const cleanup = (await plugin.setup(host.ctx as never)) as () => void;
      await expect(
        host.runToolHook("execute.before", event("npm test | head -5")),
      ).resolves.toBeUndefined();
      cleanup?.();
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("rejects a filtered host command when on", async () => {
    const project = await mkdtemp(join(tmpdir(), "xerj-setup-"));
    const host = stubHost(project, {
      binary: { path: join(project, "absent-xerj") },
      cmd: { blockPipes: true },
    });

    try {
      const cleanup = (await plugin.setup(host.ctx as never)) as () => void;
      await expect(
        host.runToolHook("execute.before", event("npm test | head -5")),
      ).rejects.toThrow(/xerj_run/);
      await expect(
        host.runToolHook("execute.before", event("npm test")),
      ).resolves.toBeUndefined();
      // The plugin's own runner is not a host bash call.
      await expect(
        host.runToolHook("execute.before", event("npm test | head", "xerj_run")),
      ).resolves.toBeUndefined();
      cleanup?.();
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("server rpc handlers", () => {
  test("reindex reports nothing queued when indexing is off", async () => {
    const project = await mkdtemp(join(tmpdir(), "xerj-setup-"));
    const host = stubHost(project, {
      index: { auto: false, watch: false },
      binary: { path: join(project, "absent-xerj") },
    });

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
    const host = stubHost(project, {
      index: { auto: false, watch: false },
      binary: { path: join(project, "absent-xerj") },
    });

    try {
      const cleanup = (await plugin.setup(host.ctx as never)) as () => void;

      const remember = await host.call("remember", { text: "a fact" }).catch((e: unknown) => e);
      expect(String(remember)).toContain("memory is not available");
      const search = await host.call("search", { query: "anything" }).catch((e: unknown) => e);
      expect(String(search)).toContain("search is not available");
      cleanup?.();
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("server setup failure paths", () => {
  test("a binary that cannot report a version fails cleanly", async () => {
    const project = await mkdtemp(join(tmpdir(), "xerj-setup-"));
    const fake = join(project, "fake-xerj");
    await writeFakeBinary(fake, "exit 1");

    try {
      const host = stubHost(project, { binary: { path: fake } });
      const cleanup = (await plugin.setup(host.ctx as never)) as () => void;

      // Bootstrap runs in the background; wait for it to settle.
      const deadline = Date.now() + 5_000;
      let phase = "starting";
      while (Date.now() < deadline && phase === "starting") {
        const snapshot = await host.status();
        phase = (snapshot.node as { phase: string }).phase;
        await Bun.sleep(50);
      }

      const snapshot = await host.status();
      const errors = snapshot.errors as string[];
      expect(phase).toBe("error");
      expect(errors.join("\n")).toContain("did not run");

      cleanup?.();
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("a visible storage.root inside the project is refused with a warning", async () => {
    const project = await mkdtemp(join(tmpdir(), "xerj-setup-"));

    try {
      const host = stubHost(project, {
        binary: { path: join(project, "absent-xerj") },
        storage: { root: join(project, "engine-data") },
      });
      const cleanup = (await plugin.setup(host.ctx as never)) as () => void;
      const snapshot = await host.status();

      expect((snapshot.warnings as string[]).join("\n")).toContain("not hidden");
      expect((snapshot.config as { storageRoot: string }).storageRoot).toContain(".xerj");
      cleanup?.();
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("an unwritable workspace reports an error instead of throwing", async () => {
    const project = await mkdtemp(join(tmpdir(), "xerj-setup-"));
    await chmod(project, 0o555);

    try {
      const host = stubHost(project, { binary: { path: join(project, "absent-xerj") } });
      const cleanup = (await plugin.setup(host.ctx as never)) as () => void;

      const deadline = Date.now() + 5_000;
      let phase = "starting";
      while (Date.now() < deadline && phase === "starting") {
        const snapshot = await host.status();
        phase = (snapshot.node as { phase: string }).phase;
        await Bun.sleep(50);
      }

      // A read-only root either fails the state write (error) or never gets
      // that far (starting); a throw out of setup is what must not happen.
      expect(["error", "ready", "starting"]).toContain(phase);
      const snapshot = await host.status();
      expect(Array.isArray(snapshot.errors)).toBe(true);
      cleanup?.();
    } finally {
      await chmod(project, 0o755);
      await rm(project, { recursive: true, force: true });
    }
  });
});

/** Writes a shell script that stands in for the engine binary. */
async function writeFakeBinary(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}
