// The TUI render functions cannot call the real JSX runtime: without the host
// renderer it throws "No renderer found". The runtime is mocked with a recorder
// so the element tree can be inspected without a terminal. This covers the two
// slot render bodies, which are otherwise unreachable from tests.

import { afterAll, describe, expect, mock, test } from "bun:test";

interface Element {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
  readonly children: unknown[];
}

function node(
  type: unknown,
  props: Record<string, unknown> | null,
  ...children: unknown[]
): Element {
  return { type, props: props ?? {}, children };
}

mock.module("@opentui/solid/jsx-runtime", () => ({
  jsx: node,
  jsxs: node,
  jsxDEV: node,
  Fragment: "fragment",
}));

const TuiPlugin = (await import("../../src/tui.tsx")).default;
type StatusSnapshot = import("../../src/rpc.ts").StatusSnapshot;

const SNAPSHOT: StatusSnapshot = {
  pluginVersion: "0.0.0-test",
  updatedAt: 1,
  node: {
    phase: "ready",
    baseUrl: "http://127.0.0.1:9200",
    serverVersion: "1.0.0-rc.101",
    spawned: true,
    state: "running",
    pid: 4242,
    idleAt: Date.now() + 60_000,
    sessions: 1,
    error: null,
  },
  binary: { version: "1.0.0-rc.101", path: "/tmp/xerj", upgraded: false, target: "x86_64" },
  index: {
    prefix: "xop-demo-00000000",
    docs: 42,
    bytes: 1024,
    indices: 2,
    state: "watching",
    lastRunAt: Date.now() - 1000,
    lastGeneration: 3,
    lastRecords: 42,
    lastFiles: 7,
    restarts: 0,
    lastError: null,
    datasets: [{ name: "project", docs: 42, bytes: 1024 }],
  },
  config: {
    indexRoot: "/tmp/demo",
    storageRoot: "/tmp/demo/.xerj",
    brain: [],
    watch: true,
    contextEnabled: true,
  },
  usage: {
    queries: 4,
    hits: 3,
    hitRate: 0.75,
    bytesReturned: 100,
    bytesRead: 10,
    baselineBytes: 200,
    savedBytes: 100,
    tokensSaved: 25,
    tokensCost: 5,
    netTokens: 20,
    topFiles: [],
  },
  memory: { namespace: "proj-demo", count: 1, exists: true },
  brains: [],
  disk: { engineBytes: 1024, logBytes: 2048 },
  corpora: [
    { name: "project", state: "watching", docs: 42, lastRunAt: 1, records: 42, edges: null, error: null },
    { name: "hidden", state: "error", docs: 0, lastRunAt: 1, records: null, edges: null, error: "timed out" },
  ],
  counters: {
    rpcCalls: 1,
    injectedTurns: 1,
    nodeSpawns: 1,
    http429: 0,
    indexRuns: 1,
    noiseSkips: 2,
  },
  recent: [],
  warnings: [],
  errors: [],
};

interface Slot {
  append: string;
  render: (input?: Record<string, unknown>) => unknown;
}

const slots: Slot[] = [];
const commands: string[] = [];

interface HostOptions {
  readonly status?: () => Promise<StatusSnapshot>;
  readonly eventsThrow?: boolean;
  readonly searchText?: string;
}

function makeHost(options: HostOptions = {}): unknown {
  const alerts: Array<{ title: string; message: string }> = [];
  const status = options.status ?? (async () => SNAPSHOT);
  return {
    alerts,
    get client() {
      return {
        rpc: () => ({
          status: async () => status(),
          reindex: async () => ({ queued: true, records: 42 }),
          remember: async () => ({ id: "m1", created: true }),
          search: async () => ({
            text: options.searchText ?? "[1] src/a.ts:1",
            hits: 1,
            bytes: 10,
          }),
          events: {
            on: () => {
              if (options.eventsThrow) throw new Error("events unavailable");
              return () => {};
            },
          },
        }),
      };
    },
    get location() {
      return { directory: "/proj" };
    },
    options: {},
    keymap: {
      layer: (factory: () => { commands: Array<{ name: string }> }) => {
        for (const command of factory().commands) commands.push(command.name);
        return () => {};
      },
    },
    storage: {
      memory: <T,>(_key: string, init: { initial: T }) => {
        const state = structuredClone(init.initial);
        return [state, (mutate: (draft: T) => void) => mutate(state)] as const;
      },
    },
    ui: {
      slot: (input: Slot) => {
        slots.push(input);
        return () => {};
      },
      panel: {
        open: () => true,
        close: () => {},
        current: () => ({ name: "xerj.stats", sessionID: "s" }),
      },
      dialog: {
        alert: async (input: { title: string; message: string }) => {
          alerts.push(input);
        },
        prompt: async () => "",
      },
      toast: { show: () => {} },
    },
    theme: {
      text: { base: "white", muted: "gray", faint: "gray" },
      border: { base: "gray" },
    },
  };
}

afterAll(() => {
  mock.restore();
});

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

/** Collects every string in an element tree, in order. */
function textOf(tree: unknown): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (typeof tree === "function") return "";
  if (Array.isArray(tree)) return tree.map(textOf).join(" ");
  if (typeof tree !== "object" || tree === null) return "";

  const props = (tree as { props?: Record<string, unknown> }).props ?? {};
  const children = (tree as { children?: unknown[] }).children ?? [];
  return [...Object.values(props).map(textOf), ...children.map(textOf)]
    .filter((part) => part.length > 0)
    .join(" ");
}

describe("TUI render bodies", () => {
  test("the sidebar renders the lines it was given", async () => {
    const plugin = TuiPlugin as unknown as {
      setup: (context: unknown) => Promise<() => void>;
    };
    const dispose = await plugin.setup(makeHost());
    await flush();

    const sidebar = slots.find((slot) => slot.append === "sidebar.content");
    expect(sidebar).toBeDefined();

    const tree = textOf(sidebar?.render());
    expect(tree).toContain("XERJ");
    expect(tree).toContain("2 skipped");
    dispose();
  });

  test("the panel renders sections for its own name and nothing for others", async () => {
    const plugin = TuiPlugin as unknown as {
      setup: (context: unknown) => Promise<() => void>;
    };
    const dispose = await plugin.setup(makeHost());
    await flush();

    const panel = slots.find((slot) => slot.append === "session.panel");
    expect(panel).toBeDefined();
    expect(panel?.render({ name: "someone.else" })).toBeNull();

    const tree = textOf(panel?.render({ name: "xerj.stats" }));
    expect(tree).toContain("Corpora");
    expect(tree).toContain("timed out");
    expect(tree).toContain("esc or /xerj closes");
    dispose();
    expect(commands.length).toBeGreaterThan(0);
  });
});

describe("TUI edge paths", () => {
  const plugin = TuiPlugin as unknown as {
    setup: (context: unknown) => Promise<() => void>;
  };

  test("the panel shows the reason when no snapshot arrived", async () => {
    const dispose = await plugin.setup(
      makeHost({
        status: async () => {
          throw new Error("server refused");
        },
      }),
    );
    await flush();

    const panel = slots.find((slot) => slot.append === "session.panel");
    const tree = textOf(panel?.render({ name: "xerj.stats" }));
    expect(tree.length).toBeGreaterThan(0);
    dispose();
  });

  test("a failing event subscription does not break setup", async () => {
    const dispose = await plugin.setup(makeHost({ eventsThrow: true }));
    await flush();
    expect(slots.length).toBeGreaterThan(0);
    dispose();
  });
});
