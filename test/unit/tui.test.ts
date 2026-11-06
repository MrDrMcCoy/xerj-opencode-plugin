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
    lastFiles: 1,
    restarts: 0,
    lastError: null,
    datasets: [{ name: "project", docs: 3, bytes: 512 }],
  },
  config: {
    indexRoot: "/proj",
    storageRoot: "/proj/.xerj",
    brain: [],
    watch: true,
    contextEnabled: true,
  },
  usage: {
    queries: 1,
    hits: 1,
    hitRate: 1,
    bytesReturned: 64,
    bytesRead: 0,
    baselineBytes: 512,
    savedBytes: 448,
    tokensSaved: 112,
    tokensCost: 0,
    netTokens: 112,
    topFiles: [{ path: "a.md", citations: 1, bytes: 512 }],
  },
  memory: { namespace: "proj-demo", count: 0 },
  brains: [],
  disk: { engineBytes: 1024, logBytes: 2048 },
  corpora: [
    { name: "project", state: "watching", docs: 12, lastRunAt: 1, records: 40, error: null },
  ],
  counters: {
    rpcCalls: 0,
    injectedTurns: 0,
    nodeSpawns: 1,
    http429: 0,
    indexRuns: 2,
    noiseSkips: 1,
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

interface Toast {
  message: string;
  variant?: string;
}

interface Host {
  readonly calls: Call[];
  readonly commands: Command[];
  readonly toasts: Toast[];
  readonly alerts: Array<{ title: string; message: string }>;
  readonly closes: () => number;
  setStatus(handler: () => Promise<StatusSnapshot>): void;
  setLocation(directory: string | undefined): void;
  setPanel(open: boolean): void;
  swapClient(): void;
  setReindex(handler: () => Promise<unknown>): void;
  setRemember(handler: () => Promise<unknown>): void;
  setSearch(handler: () => Promise<unknown>): void;
  setDialogAnswer(answer: string): void;
  setPanelOpenResult(opens: boolean): void;
  readonly slots: Array<{ append: string; render: (input?: Record<string, unknown>) => unknown }>;
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
  const toasts: Toast[] = [];
  const alerts: Array<{ title: string; message: string }> = [];
  let dialogAnswer = "";
  let panelOpens = true;
  const slots: Array<{ append: string; render: (input?: Record<string, unknown>) => unknown }> = [];
  let reindex = async (): Promise<unknown> => ({ queued: true, records: 900 });
  let remember = async (): Promise<unknown> => ({ id: "mem-1", created: true });
  let search = async (): Promise<unknown> => ({ text: "[1] src/a.ts:1\ncode", hits: 1, bytes: 20 });

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
        return reindex();
      },
      remember: async (_input: unknown, options?: CallOptions) => {
        record("remember", options);
        return remember();
      },
      search: async (_input: unknown, options?: CallOptions) => {
        record("search", options);
        return search();
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
      slot: (input: { append: string; render: (value?: Record<string, unknown>) => unknown }) => {
        slots.push(input);
        return () => {};
      },
      panel: {
        open: () => {
          panelOpen = panelOpens;
          return panelOpens;
        },
        close: () => {
          panelOpen = false;
          closeCount += 1;
        },
        current: () =>
          panelOpen ? { name: "xerj.stats", sessionID: "s" } : undefined,
      },
      dialog: {
        alert: async (options: { title: string; message: string }) => {
          alerts.push(options);
        },
        prompt: async () => dialogAnswer,
      },
      toast: {
        show: (toast: Toast) => {
          toasts.push(toast);
        },
      },
    },
    theme: {
      text: { base: "white", muted: "gray", faint: "gray" },
      border: { base: "gray" },
    },
  };

  const host: Host = {
    calls,
    commands,
    toasts,
    alerts,
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
    setReindex: (handler) => {
      reindex = handler;
    },
    setRemember: (handler) => {
      remember = handler;
    },
    setSearch: (handler) => {
      search = handler;
    },
    setDialogAnswer: (answer) => {
      dialogAnswer = answer;
    },
    setPanelOpenResult: (opens) => {
      panelOpens = opens;
    },
    slots,
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

describe("tui commands", () => {
  function byId(host: Host, id: string): Command {
    const command = host.commands.find((candidate) => candidate.id === id);
    if (!command) throw new Error(`${id} not registered`);
    return command;
  }

  test("reindex reports the record count of the finished pass", async () => {
    const host = makeHost();
    const { dispose } = await setup(host);
    await flush();

    await byId(host, "xerj.reindex").run();
    dispose();

    expect(host.toasts.at(-1)).toEqual({
      message: "XERJ reindexed · 900 records",
      variant: "success",
    });
  });

  test("reindex says when indexing is disabled", async () => {
    const host = makeHost();
    host.setReindex(async () => ({ queued: false }));
    const { dispose } = await setup(host);
    await flush();

    await byId(host, "xerj.reindex").run();
    dispose();

    expect(host.toasts.at(-1)).toEqual({
      message: "XERJ indexing is disabled",
      variant: "info",
    });
  });

  test("reindex reports a failure instead of staying silent", async () => {
    const host = makeHost();
    host.setReindex(async () => {
      throw new Error("node is down");
    });
    const { dispose } = await setup(host);
    await flush();

    await byId(host, "xerj.reindex").run();
    dispose();

    expect(host.toasts.at(-1)).toEqual({
      message: "XERJ is not available",
      variant: "error",
    });
  });

  test("remember uses the typed text and confirms the id", async () => {
    const host = makeHost();
    const { dispose } = await setup(host);
    await flush();

    await byId(host, "xerj.remember").run("the node idles for 30 minutes");

    expect(host.calls.some((call) => call.method.startsWith("remember"))).toBe(true);
    expect(host.toasts.at(-1)).toEqual({
      message: "Remembered as mem-1",
      variant: "success",
    });
    dispose();
  });

  test("remember asks for text when none is given", async () => {
    const host = makeHost();
    host.setDialogAnswer("a decision made earlier");
    const { dispose } = await setup(host);
    await flush();

    await byId(host, "xerj.remember").run();
    dispose();

    expect(host.toasts.at(-1)?.message).toBe("Remembered as mem-1");
  });

  test("remember shows the already-remembered variant", async () => {
    const host = makeHost();
    host.setRemember(async () => ({ id: "mem-9", created: false }));
    const { dispose } = await setup(host);
    await flush();

    await byId(host, "xerj.remember").run("same fact");
    dispose();

    expect(host.toasts.at(-1)).toEqual({
      message: "Already remembered as mem-9",
      variant: "info",
    });
  });

  test("search opens a dialog with the cited passages", async () => {
    const host = makeHost();
    const { dispose } = await setup(host);
    await flush();

    await byId(host, "xerj.search").run("where is the watcher");
    dispose();

    const alert = host.alerts.at(-1);
    expect(alert?.title).toContain("1 hit");
    expect(alert?.message).toContain("src/a.ts:1");
  });

  test("search reports when nothing matched", async () => {
    const host = makeHost();
    host.setSearch(async () => ({ text: "", hits: 0, bytes: 0 }));
    const { dispose } = await setup(host);
    await flush();

    await byId(host, "xerj.search").run("unfindable");
    dispose();

    expect(host.alerts.at(-1)?.message).toBe("No passages matched.");
  });

  test("the /xerj subcommands dispatch and reject unknown ones", async () => {
    const host = makeHost();
    const { run, dispose } = await setup(host);
    await flush();

    await run("reindex");
    expect(host.toasts.at(-1)?.message).toContain("reindexed");

    await run("remember a durable fact");
    expect(host.toasts.at(-1)?.message).toContain("Remembered");

    await run("search the watcher");
    expect(host.alerts.at(-1)?.title).toContain("XERJ search");

    await run("nonsense");
    expect(host.toasts.at(-1)).toEqual({
      message: "Unknown XERJ command: nonsense",
      variant: "warning",
    });
    dispose();
  });

  test("every command carries the location on its rpc call", async () => {
    const host = makeHost();
    const { dispose } = await setup(host);
    await flush();

    await byId(host, "xerj.reindex").run();
    await byId(host, "xerj.remember").run("a fact");
    await byId(host, "xerj.search").run("a query");
    dispose();

    for (const method of ["reindex", "remember", "search"]) {
      const call = host.calls.find((entry) => entry.method.startsWith(method));
      expect(call?.options.location?.directory).toBe("/proj");
    }
  });
});

describe("tui failures and rendering", () => {
  function byId(host: Host, id: string): Command {
    const command = host.commands.find((candidate) => candidate.id === id);
    if (!command) throw new Error(`${id} not registered`);
    return command;
  }

  test("remember reports a memory failure", async () => {
    const host = makeHost();
    host.setRemember(async () => {
      throw new Error("node is down");
    });
    const { dispose } = await setup(host);
    await flush();

    await byId(host, "xerj.remember").run("a fact");
    dispose();

    expect(host.toasts.at(-1)).toEqual({
      message: "XERJ memory is not available",
      variant: "error",
    });
  });

  test("search reports a search failure", async () => {
    const host = makeHost();
    host.setSearch(async () => {
      throw new Error("node is down");
    });
    const { dispose } = await setup(host);
    await flush();

    await byId(host, "xerj.search").run("anything");
    dispose();

    expect(host.toasts.at(-1)).toEqual({
      message: "XERJ search is not available",
      variant: "error",
    });
  });

  test("falls back to an alert when no panel can host the details", async () => {
    const host = makeHost();
    host.setPanelOpenResult(false);
    const { run, dispose } = await setup(host);
    await flush();

    await run("");
    dispose();

    expect(host.alerts.at(-1)?.title).toBe("XERJ");
  });

  test("reports a queued pass that returned no count", async () => {
    const host = makeHost();
    host.setReindex(async () => ({ queued: true }));
    const { dispose } = await setup(host);
    await flush();

    await byId(host, "xerj.reindex").run();
    dispose();

    expect(host.toasts.at(-1)?.message).toBe("XERJ reindex queued");
  });

});
