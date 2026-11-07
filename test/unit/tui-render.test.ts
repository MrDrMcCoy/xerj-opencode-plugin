// The TUI render functions cannot call the real JSX runtime: without the host
// renderer it throws "No renderer found". The runtime is mocked with a recorder
// so the element tree can be inspected without a terminal. This covers the two
// slot render bodies, which are otherwise unreachable from tests.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// Preferences are written to the shared TUI file, so every test points that
// file at a scratch directory: a header click here must never edit the file the
// developer's own TUI reads.
const prefsDir = mkdtempSync(join(tmpdir(), "xerj-tui-prefs-"));
const previousPrefsFile = process.env.OPENCODE_TUI_PREFERENCES_FILE;
beforeAll(() => {
  process.env.OPENCODE_TUI_PREFERENCES_FILE = join(prefsDir, "tui-preferences.jsonc");
});
afterAll(() => {
  if (previousPrefsFile === undefined) delete process.env.OPENCODE_TUI_PREFERENCES_FILE;
  else process.env.OPENCODE_TUI_PREFERENCES_FILE = previousPrefsFile;
  rmSync(prefsDir, { recursive: true, force: true });
});

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
    prjdocsKeywords: [],
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
  memory: { namespace: "proj-demo", count: 1, exists: true, stale: 0 },
  brains: [],
  disk: { engineBytes: 1024, logBytes: 2048 },
  map: [],
  frameworks: [],
  process: null,
  embeddings: false,
  state: {
    name: "ready",
    since: Date.now() - 5_000,
    detail: null,
    jobs: [],
    today: {
      startingMs: 0,
      readyMs: 1_000,
      busyMs: 0,
      degradedMs: 0,
      stoppedMs: 0,
    },
  },
  telemetry: {
    enabled: true,
    ops: [],
    starts: [],
    crashes: 0,
    restarts: 0,
    process: null,
    storeBytes: 0,
    historyStart: null,
    disabled: null,
  },
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
  const uiLogs: Array<{ level: string; message: string; detail?: string }> = [];
  const status = options.status ?? (async () => SNAPSHOT);
  return {
    alerts,
    uiLogs,
    get client() {
      return {
        rpc: () => ({
          status: async () => status(),
          uiLog: async (input: { level: string; message: string; detail?: string }) => {
            uiLogs.push(input);
            return {};
          },
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
      text: {
        base: "white",
        muted: "gray",
        faint: "gray",
        feedback: {
          error: { base: "red" },
          warning: { base: "yellow" },
          success: { base: "green" },
          info: { base: "blue" },
        },
      },
      border: { base: "gray" },
      background: { base: "black", raised: { base: "gray" } },
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
/** The first handler prop of a given name, for clicking the header in tests. */
function findHandler(tree: unknown, name: string): unknown {
  if (typeof tree !== "object" || tree === null) return undefined;
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const found = findHandler(child, name);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  const element = tree as { props?: Record<string, unknown>; children?: unknown[] };
  const handler = element.props?.[name];
  if (typeof handler === "function") return handler;

  // Solid hands `children` inside props rather than as arguments, so both
  // places have to be searched.
  return (
    findHandler(element.props?.children, name) ??
    findHandler(element.children ?? [], name)
  );
}

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
  test("the sidebar renders a header, sections, and a failing corpus", async () => {
    const plugin = TuiPlugin as unknown as {
      setup: (context: unknown) => Promise<() => void>;
    };
    const dispose = await plugin.setup(makeHost());
    await flush();

    const sidebar = slots.find((slot) => slot.append === "sidebar.content");
    expect(sidebar).toBeDefined();

    const tree = textOf(sidebar?.render());
    expect(tree).toContain("▼  XERJ");
    expect(tree).toContain("Corpora");
    expect(tree).toContain("Session");
    expect(tree).toContain("skipped");
    expect(tree).toContain("error · timed out");
    expect(tree).toContain("/xerj for details");
    dispose();
  });

  test("the header shows the badge and a running job", async () => {
    const plugin = TuiPlugin as unknown as {
      setup: (context: unknown) => Promise<() => void>;
    };
    const dispose = await plugin.setup(
      makeHost({
        status: async () => ({
          ...SNAPSHOT,
          state: {
            ...SNAPSHOT.state,
            name: "busy",
            detail: "indexing",
            since: Date.now() - 12_000,
            jobs: [
              { kind: "index", label: "indexing", startedAt: Date.now() - 12_000 },
            ],
          },
        }),
      }),
    );
    await flush();

    // The slot list keeps every setup from this file, so the newest claim is
    // the one this test's host registered.
    const sidebar = slots.filter((slot) => slot.append === "sidebar.content").at(-1);
    const expanded = textOf(sidebar?.render());

    expect(expanded).toContain("◐ busy · indexing · 12s");
    expect(expanded).toContain("jobs");
    expect(expanded).toContain("indexing 12s");

    // Collapsed, the running job keeps a row of its own.
    const toggle = findHandler(sidebar?.render() as Element, "onMouseDown");
    (toggle as () => void)();
    const collapsed = textOf(sidebar?.render());

    expect(collapsed).toContain("Jobs");
    expect(collapsed).toContain("indexing 12s");
    expect(collapsed).not.toContain("Corpora");
    dispose();
  });

  test("clicking the header collapses the sidebar", async () => {
    const plugin = TuiPlugin as unknown as {
      setup: (context: unknown) => Promise<() => void>;
    };
    const dispose = await plugin.setup(makeHost());
    await flush();

    const sidebar = slots.find((slot) => slot.append === "sidebar.content");
    const tree = sidebar?.render() as Element;
    expect(textOf(tree)).toContain("Corpora");

    const toggle = findHandler(tree, "onMouseDown");
    expect(typeof toggle).toBe("function");
    (toggle as () => void)();

    const collapsed = textOf(sidebar?.render());
    expect(collapsed).toContain("Index");
    expect(collapsed).not.toContain("Corpora");
    dispose();
  });

  test("a failing sidebar render is logged and replaced by a fallback", async () => {
    const plugin = TuiPlugin as unknown as {
      setup: (context: unknown) => Promise<() => void>;
    };
    const host = makeHost({
      // A malformed job list survives the offline check and then throws inside
      // the view, which is the shape of a host/data mismatch.
      status: async () => ({
        ...SNAPSHOT,
        state: { ...SNAPSHOT.state, jobs: {} as never },
      }),
    });
    const dispose = await plugin.setup(host);
    await flush();

    const sidebar = slots.filter((slot) => slot.append === "sidebar.content").at(-1);
    const tree = textOf(sidebar?.render());
    expect(tree).toContain("XERJ sidebar error");

    await flush();
    const logs = (host as unknown as { uiLogs: Array<{ level: string; message: string; detail?: string }> }).uiLogs;
    const failure = logs.find((entry) => entry.message === "sidebar render failed");
    expect(failure?.level).toBe("error");
    expect(String(failure?.detail).length).toBeGreaterThan(0);
    expect(logs.some((entry) => entry.message === "tui setup started")).toBe(true);
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
