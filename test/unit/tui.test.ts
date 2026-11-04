// The TUI half fails silently when it captures a stale client or omits the
// location, so this drives the real plugin against a stub host and asserts the
// properties a live terminal cannot show in a test.
import { describe, expect, test } from "bun:test";
import TuiPlugin from "../../src/tui.tsx";
import type { StatusSnapshot } from "../../src/rpc.ts";

type CallOptions = { location?: { directory: string } };
type Call = { method: string; options: CallOptions };

const SNAPSHOT: StatusSnapshot = {
  pluginVersion: "0.0.0-test",
  updatedAt: 0,
  node: {
    phase: "ready",
    baseUrl: "http://127.0.0.1:9200",
    serverVersion: "1.0.0-rc.100",
    spawned: false,
    state: "running",
    pid: 4242,
    idleAt: 1_800_000,
    sessions: 1,
    error: null,
  },
  binary: { version: "1.0.0-rc.100", path: "/b", upgraded: false, target: "t" },
  index: {
    prefix: "xop-demo-00000000",
    docs: 3,
    bytes: 512,
    indices: 1,
    state: "watching",
    lastRunAt: 1,
    lastGeneration: 1,
    lastRecords: 3,
    restarts: 0,
    lastError: null,
    datasets: [{ name: "project", docs: 3, bytes: 512 }],
  },
  config: { indexRoot: "/proj", brain: [], watch: true, contextEnabled: true },
  usage: {
    queries: 1,
    hits: 1,
    hitRate: 1,
    bytesReturned: 64,
    bytesRead: 0,
    baselineBytes: 512,
    savedBytes: 448,
    tokensSaved: 112,
    topFiles: [{ path: "a.md", citations: 1, bytes: 512 }],
  },
  memory: { namespace: "proj-demo", count: 0 },
  brains: [],
  counters: {
    rpcCalls: 0,
    injectedTurns: 0,
    nodeSpawns: 1,
    http429: 0,
    indexRuns: 2,
  },
  recent: [],
  warnings: [],
  errors: [],
};

type Command = {
  id: string;
  enabled?: boolean | (() => boolean);
  run: (input?: string) => Promise<unknown>;
};

interface Host {
  readonly calls: Call[];
  readonly commands: Command[];
  readonly closes: () => number;
  setStatus(handler: () => Promise<StatusSnapshot>): void;
  setLocation(directory: string | undefined): void;
  setPanel(open: boolean): void;
  swapClient(): void;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeHost(): Host {
  const calls: Call[] = [];
  const commands: Command[] = [];
  let status = async () => SNAPSHOT;
  let location: { directory: string } | undefined = { directory: "/proj" };
  let generation = 0;
  let panelOpen = false;
  let closeCount = 0;

  const rpc = () => {
    const tag = generation;
    const record = (method: string, options?: CallOptions): void => {
      calls.push({ method: `${method}#${tag}`, options: options ?? {} });
    };
    return {
      status: async (_input: unknown, options?: CallOptions) => {
        record("status", options);
        return status();
      },
      reindex: async (_input: unknown, options?: CallOptions) => {
        record("reindex", options);
        return { queued: true };
      },
      remember: async (_input: unknown, options?: CallOptions) => {
        record("remember", options);
        return { id: "x", created: true };
      },
      search: async (_input: unknown, options?: CallOptions) => {
        record("search", options);
        return { text: "", hits: 0, bytes: 0 };
      },
      events: { on: () => () => {} },
    };
  };

  const context = {
    get client() {
      return { rpc };
    },
    get location() {
      return location;
    },
    options: {},
    keymap: {
      layer: (factory: () => { commands: Command[] }) => {
        commands.push(...factory().commands);
        return () => {};
      },
    },
    storage: {
      memory: <T,>(_key: string, init: { initial: T }) => {
        const state = structuredClone(init.initial);
        const update = (mutate: (draft: T) => void) => mutate(state);
        return [state, update] as const;
      },
    },
    ui: {
      slot: () => () => {},
      panel: {
        open: () => {
          panelOpen = true;
          return true;
        },
        close: () => {
          panelOpen = false;
          closeCount += 1;
        },
        current: () =>
          panelOpen ? { name: "xerj.stats", sessionID: "s" } : undefined,
      },
      dialog: { alert: async () => {}, prompt: async () => "" },
      toast: { show: () => {} },
    },
    theme: {
      text: { base: "white", muted: "gray", faint: "gray" },
      border: { base: "gray" },
    },
  };

  const host: Host = {
    calls,
    commands,
    closes: () => closeCount,
    setStatus: (handler) => {
      status = handler;
    },
    setLocation: (directory) => {
      location = directory === undefined ? undefined : { directory };
    },
    setPanel: (open) => {
      panelOpen = open;
    },
    swapClient: () => {
      generation += 1;
    },
  };

  Object.assign(host, { context });
  return host;
}

async function setup(host: Host): Promise<{
  run: (input?: string) => Promise<unknown>;
  dispose: () => void;
}> {
  const context = (host as unknown as { context: never }).context;
  const cleanup = await TuiPlugin.setup(context);
  const status = host.commands.find((command) => command.id === "xerj.status");
  if (!status) throw new Error("status command not registered");
  return { run: status.run, dispose: (cleanup as () => void) ?? (() => {}) };
}

describe("tui rpc access", () => {
  test("passes the active location on every call", async () => {
    const host = makeHost();
    const { run, dispose } = await setup(host);
    await run("");
    await flush();
    dispose();

    const call = host.calls.find((entry) => entry.method.startsWith("status"));
    expect(call?.options.location?.directory).toBe("/proj");
  });

  test("reads the client again after a server restart", async () => {
    const host = makeHost();
    let failing = true;
    host.setStatus(async () => {
      if (failing) throw new Error("connection reset");
      return SNAPSHOT;
    });

    const { run, dispose } = await setup(host);
    await run("");
    await flush();
    expect(host.calls.some((entry) => entry.method === "status#0")).toBe(true);

    failing = false;
    host.swapClient();
    await run("");
    await flush();
    dispose();

    expect(host.calls.some((entry) => entry.method === "status#1")).toBe(true);
  });

  test("omits the location when the host has none", async () => {
    const host = makeHost();
    host.setLocation(undefined);
    const { run, dispose } = await setup(host);
    await run("");
    await flush();
    dispose();

    const call = host.calls.find((entry) => entry.method.startsWith("status"));
    expect(call).toBeDefined();
    expect(call?.options.location).toBeUndefined();
  });
});

describe("tui panel close", () => {
  test("binds a close command only while the panel is open", async () => {
    const host = makeHost();
    const { run, dispose } = await setup(host);

    const close = host.commands.find((command) => command.id === "xerj.close");
    expect(close).toBeDefined();
    const enabled = close?.enabled;
    expect(typeof enabled === "function" ? enabled() : enabled).toBe(false);

    await run("");
    await flush();
    await close?.run();
    const closedByCommand = host.closes();
    dispose();

    expect(closedByCommand).toBe(1);
  });

  test("re-running the command closes the open panel", async () => {
    const host = makeHost();
    const { run, dispose } = await setup(host);

    await run("");
    await flush();
    await run("");
    await flush();
    dispose();

    expect(host.closes()).toBe(1);
  });
});
