import { describe, expect, test } from "bun:test";
import { XerjRpc, type StatusSnapshot } from "../../src/rpc.ts";
import {
  formatAge,
  formatBytes,
  formatCount,
  formatPercent,
  formatTokens,
  panelSections,
  sidebarLines,
  sidebarRowLayout,
  sidebarView,
} from "../../src/ui/format.ts";

const NOW = 1_120_000;

type SchemaNode = {
  readonly properties?: Record<string, unknown>;
  readonly items?: unknown;
};

/**
 * What the host hands the TUI: the response rebuilt from the declared output
 * schema, so a field the type declares but the schema omits never arrives.
 */
function toSchema(value: unknown, schema: unknown): unknown {
  const node = (schema ?? {}) as SchemaNode;
  if (Array.isArray(value)) return value.map((entry) => toSchema(entry, node.items));
  if (value === null || typeof value !== "object" || node.properties === undefined) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(node.properties)) {
    if (!(key in value)) continue;
    out[key] = toSchema((value as Record<string, unknown>)[key], child);
  }
  return out;
}

function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  const base: StatusSnapshot = {
    pluginVersion: "0.1.1",
    updatedAt: NOW,
    node: {
      phase: "ready",
      baseUrl: "http://127.0.0.1:9200",
      serverVersion: "1.0.0-rc.100",
      spawned: false,
      state: "running",
      pid: 4242,
      idleAt: NOW + 1_800_000,
      sessions: 1,
      error: null,
    },
    binary: {
      version: "1.0.0-rc.100",
      path: "/bin/xerj",
      upgraded: false,
      target: "x86_64-unknown-linux-musl",
    },
    index: {
      prefix: "xop-demo-1a2b3c4d",
      docs: 437,
      bytes: 1_048_576,
      indices: 2,
      state: "watching",
      lastRunAt: 1_000_000,
      lastGeneration: 12,
      lastRecords: 437,
      lastFiles: 40,
      restarts: 0,
      lastError: null,
      datasets: [
        { name: "project", docs: 436, bytes: 1_000_000 },
        { name: "web", docs: 1, bytes: 15_000 },
      ],
    },
    config: {
      indexRoot: "/repo",
      storageRoot: "/repo/.xerj",
      brain: [],
      watch: true,
      contextEnabled: true,
    prjdocsKeywords: [],
    },
    usage: {
      queries: 12,
      hits: 9,
      hitRate: 0.75,
      bytesReturned: 20_000,
      bytesRead: 50_000,
      baselineBytes: 200_000,
      savedBytes: 180_000,
      tokensSaved: 45_000,
      tokensCost: 3_000,
      netTokens: 42_000,
      topFiles: [{ path: "src/a.ts", citations: 3, bytes: 4_000 }],
    },
    memory: {
      namespace: "proj-demo-1a2b3c4d",
      count: 2,
      exists: true,
      stale: 0,
      tuning: {
        threshold: 0.2,
        autotuned: true,
        tunedAt: "2026-11-07T10:00:00.000Z",
        f1: 0.88,
      },
    },
    brains: [],
    disk: { engineBytes: 1024, logBytes: 2048 },
    map: [],
    frameworks: [],
  docs: { prjdocs: { lastRunAt: null, pages: 0 }, sysdocs: { lastRunAt: null, pages: 0 } },
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
    distill: { promoted: 0, heuristic: 0, model: 0, local: 0, recalled: 0, calls: 0, chars: 0 },
    disabled: null,
  },
    corpora: [
      { name: "project", state: "watching", docs: 12, lastRunAt: 1, records: 40, edges: null, error: null },
      { name: "hidden", state: "watching", docs: 4, lastRunAt: 1, records: null, edges: null, error: null },
    ],
    counters: {
      rpcCalls: 42,
      injectedTurns: 7,
      nodeSpawns: 1,
      http429: 0,
      indexRuns: 9,
      noiseSkips: 3,
    },
    recent: ["warn: retry"],
    warnings: [],
    errors: [],
  };

  return { ...base, ...overrides };
}

describe("formatBytes", () => {
  test("scales and keeps bytes whole", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(15_000)).toBe("14.6 KB");
    expect(formatBytes(1_048_576)).toBe("1.0 MB");
  });
});

describe("formatTokens", () => {
  test("compacts thousands and millions", () => {
    expect(formatTokens(0)).toBe("~0");
    expect(formatTokens(999)).toBe("~999");
    expect(formatTokens(45_000)).toBe("~45.0K");
    expect(formatTokens(1_900_000)).toBe("~1.9M");
  });
});

describe("formatAge", () => {
  test("covers the useful ranges", () => {
    expect(formatAge(NOW, null)).toBe("never");
    expect(formatAge(NOW, NOW)).toBe("just now");
    expect(formatAge(NOW, NOW - 65_000)).toBe("1m ago");
    expect(formatAge(NOW, NOW - 3_700_000)).toBe("1h ago");
    expect(formatAge(NOW, NOW - 90_000_000)).toBe("1d ago");
  });
});

describe("formatCount and formatPercent", () => {
  test("groups numbers and rounds ratios", () => {
    expect(formatCount(1284)).toBe("1,284");
    expect(formatPercent(0.769)).toBe("77%");
    expect(formatPercent(0)).toBe("0%");
  });
});

describe("sidebarLines", () => {
  test("renders four compact lines", () => {
    const lines = sidebarLines(snapshot(), NOW);

    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("ready");
    expect(lines[0]).toContain("437 docs");
    expect(lines[1]).toContain("hit 75%");
    expect(lines[1]).toContain("~45.0K tok saved");
    expect(lines[2]).toContain("2m ago");
    expect(lines[2]).toContain("40 files");
    expect(lines[3]).toContain("/xerj");
  });

  test("reports a node that is still starting", () => {
    const base = snapshot();
    const lines = sidebarLines(
      {
        ...base,
        node: { ...base.node, phase: "starting" },
        index: { ...base.index, docs: 0 },
        state: { ...base.state, name: "starting" },
      },
      NOW,
    );

    expect(lines[0]).toContain("starting");
  });
});

describe("panelSections", () => {
  test("shows the local judge floor and its autotune result", () => {
    const base = snapshot();
    const sections = panelSections(
      {
        ...base,
        memory: {
          ...base.memory,
          tuning: {
            threshold: 0.2,
            autotuned: true,
            tunedAt: "2026-11-07T10:00:00.000Z",
            f1: 0.88,
          },
        },
      },
      NOW,
    );
    const memory = sections.find((section) => section.title === "Memory");
    expect(memory?.lines.join("\n")).toContain(
      "judge floor 0.20 · autotuned · 2026-11-07 · F1 88%",
    );
  });

  test("the index section reports what the data occupies", () => {
    const index = panelSections(snapshot(), NOW).find((section) => section.title === "Index");
    const text = index?.lines.join("\n") ?? "";

    expect(text).toContain("engine 1.0 KB");
    expect(text).toContain("log 2.0 KB");
  });

  test("covers every section of the details panel", () => {
    const sections = panelSections(snapshot(), NOW);
    const titles = sections.map((section) => section.title);
    const body = sections.flatMap((section) => section.lines).join("\n");

    expect(titles).toEqual([
      "State",
      "Node",
      "Binary",
      "Index",
      "Corpora",
      "Datasets",
      "Node load",
      "Telemetry",
      "Memory",
      "Usage",
      "Counters",
      "Top cited",
      "Health",
    ]);
    expect(body).toContain("x86_64-unknown-linux-musl");
    expect(body).toContain("web  1 docs · 14.6 KB");
    expect(body).toContain("2 entries");
    expect(body).toContain("src/a.ts ×3");
    expect(body).toContain("9 index runs · 7 injections");
    expect(body).toContain("warn: retry");
  });

  test("does not present shared watcher ownership as a state", () => {
    const sections = panelSections(
      snapshot({ index: { ...snapshot().index, state: "shared" } }),
      NOW,
    );
    const index = sections.find((section) => section.title === "Index");

    expect(index?.lines[0]).toContain("watching (shared)");
  });

  test("lists configured brains with edges and freshness", () => {
    const sections = panelSections(
      snapshot({
        brains: [
          {
            name: "agents",
            prefix: "xop-agents-abcdef",
            docs: 12,
            edges: 20,
            lastRunAt: NOW - 60_000,
            error: null,
          },
        ],
      }),
      NOW,
    );
    const brains = sections.find((section) => section.title === "Brains");

    expect(brains?.lines[0]).toContain("agents  12 docs");
    expect(brains?.lines[0]).toContain("20 edges");
    expect(brains?.lines[0]).toContain("1m ago");
  });

  test("shows the last pass as files mapped to records", () => {
    const index = panelSections(snapshot(), NOW).find((section) => section.title === "Index");
    expect(index?.lines[2]).toContain("40 files → 437 records");
  });

  test("says when there is nothing to show", () => {
    const sections = panelSections(
      snapshot({
        index: {
          ...snapshot().index,
          docs: 0,
          bytes: 0,
          indices: 0,
          datasets: [],
          lastRunAt: null,
          lastRecords: null,
          lastFiles: null,
        },
        usage: { ...snapshot().usage, topFiles: [], tokensSaved: 0 },
        recent: [],
      }),
      NOW,
    );
    const body = sections.flatMap((section) => section.lines).join("\n");

    expect(body).toContain("none yet");
    expect(body).toContain("no warnings");
    expect(body).toContain("never");
  });
});

describe("corpus health", () => {
  test("a failing corpus shows its state, count and error", () => {
    const view = snapshot({
      corpora: [
        { name: "project", state: "watching", docs: 900, lastRunAt: NOW, records: 900, edges: null, error: null },
        { name: "hidden", state: "error", docs: 0, lastRunAt: NOW, records: null, edges: null, error: "timed out" },
      ],
    });

    const corpora = panelSections(view, NOW).find((section) => section.title === "Corpora");
    expect(corpora?.lines[1]).toContain("hidden");
    expect(corpora?.lines[1]).toContain("error: timed out");
    expect(corpora?.lines[0]).toContain("900 docs");
  });

  test("no corpora reads as none yet", () => {
    const view = snapshot({ corpora: [] });
    const corpora = panelSections(view, NOW).find((section) => section.title === "Corpora");
    expect(corpora?.lines).toEqual(["none yet"]);
  });
});

describe("sidebar noise count", () => {
  test("appears only when the gate skipped something", () => {
    const quiet = sidebarLines(
      snapshot({
        counters: {
          rpcCalls: 1,
          injectedTurns: 1,
          nodeSpawns: 1,
          http429: 0,
          indexRuns: 1,
          noiseSkips: 0,
        },
      }),
      NOW,
    ).join("\n");
    expect(quiet).not.toContain("skipped");

    const noisy = sidebarLines(
      snapshot({
        counters: {
          rpcCalls: 1,
          injectedTurns: 0,
          nodeSpawns: 1,
          http429: 0,
          indexRuns: 1,
          noiseSkips: 37,
        },
      }),
      NOW,
    ).join("\n");
    expect(noisy).toContain("37 skipped");
  });
});

describe("brain corpus rows", () => {
  test("a brain appears in the corpora list with its edges", () => {
    const view = snapshot({
      corpora: [
        { name: "project", state: "watching", docs: 900, lastRunAt: NOW, records: 900, edges: null, error: null },
        { name: "brain:agents-1a2b", state: "watching", docs: 28, lastRunAt: NOW, records: null, edges: 33, error: null },
      ],
    });

    const corpora = panelSections(view, NOW).find((section) => section.title === "Corpora");
    expect(corpora?.lines[1]).toContain("brain:agents-1a2b");
    expect(corpora?.lines[1]).toContain("28 docs");
    expect(corpora?.lines[1]).toContain("33 edges");
  });
});

describe("corpus and memory honesty", () => {
  function withRows(corpora: StatusSnapshot["corpora"], memory: StatusSnapshot["memory"]) {
    const base = snapshot();
    return { ...base, corpora, memory };
  }

  test("a corpus whose index vanished reports missing, not stale counts", () => {
    const view = withRows(
      [
        { name: "web", state: "missing", docs: 0, lastRunAt: NOW, records: 0, edges: null, error: "index is missing; the last pass wrote 5 records" },
      ],
      { namespace: "ns", count: 0, exists: false, stale: 0 },
    );

    const body = panelSections(view, NOW)
      .flatMap((section) => section.lines)
      .join("\n");

    // The row reports what is stored (nothing) and why, instead of claiming
    // the records of a pass whose index is gone.
    expect(body).toContain("web  missing · 0 docs");
    expect(body).toContain("index is missing");
  });

  test("a memory store with no index says so", () => {
    const view = withRows([], { namespace: "ns", count: 0, exists: false, stale: 0 });
    const body = panelSections(view, NOW)
      .flatMap((section) => section.lines)
      .join("\n");

    expect(body).toContain("index missing");
  });

  test("a healthy memory store does not claim a missing index", () => {
    const view = withRows([], { namespace: "ns", count: 4, exists: true, stale: 0 });
    const body = panelSections(view, NOW)
      .flatMap((section) => section.lines)
      .join("\n");

    expect(body).toContain("4 entries");
    expect(body).not.toContain("index missing");
  });
});

describe("panel detail additions", () => {
  function view(extra: Partial<StatusSnapshot>): StatusSnapshot {
    return { ...snapshot(), ...extra };
  }

  test("datasets are ordered by size with their share", () => {
    const base = snapshot();
    const body = panelSections(
      view({
        index: {
          ...base.index,
          datasets: [
            { name: "small", docs: 1, bytes: 1_000 },
            { name: "large", docs: 10, bytes: 9_000 },
          ],
        },
      }),
      NOW,
    )
      .flatMap((section) => section.lines)
      .join("\n");

    const large = body.indexOf("large");
    const small = body.indexOf("small");
    expect(large).toBeGreaterThan(-1);
    expect(large).toBeLessThan(small);
    expect(body).toContain("90%");
    expect(body).toContain("10%");
  });

  test("the node load section reports cpu, memory, and embeddings", () => {
    const body = panelSections(
      view({ process: { cpuPercent: 12.5, memoryBytes: 64 * 1024 * 1024 }, embeddings: true }),
      NOW,
    )
      .flatMap((section) => section.lines)
      .join("\n");

    expect(body).toContain("12.5% cpu");
    expect(body).toContain("64.0 MB rss");
    expect(body).toContain("building embeddings now");
  });

  test("a platform without counters says so", () => {
    const body = panelSections(view({ process: null }), NOW)
      .flatMap((section) => section.lines)
      .join("\n");

    expect(body).toContain("no counters on this platform");
    expect(body).toContain("not embedding");
  });

  test("frameworks list each technology with docs and size", () => {
    const sections = panelSections(
      view({
        frameworks: [
          { tech: "typescript", docs: 20, bytes: 800_000 },
          { tech: "elasticsearch", docs: 632, bytes: 1_200_000 },
        ],
      }),
      NOW,
    );
    const frameworks = sections.find((section) => section.title === "Frameworks");
    const body = frameworks?.lines.join("\n") ?? "";

    expect(body).toContain("2 documented in");
    expect(body).toContain("elasticsearch  632 docs · 1.1 MB");
    expect(body).toContain("typescript  20 docs · 781 KB");
    // Largest first, whatever order the status returned.
    expect(body.indexOf("elasticsearch")).toBeLessThan(body.indexOf("typescript"));
  });
});

describe("sidebar and panel branches", () => {
  test("a run that never happened says no runs", () => {
    const base = snapshot();
    const lines = sidebarLines(
      { ...base, index: { ...base.index, lastRunAt: null, lastFiles: null, lastRecords: null } },
      NOW,
    );

    expect(lines.join("\n")).toContain("no runs");
  });

  test("records stand in when the file count is unknown", () => {
    const base = snapshot();
    const lines = sidebarLines(
      { ...base, index: { ...base.index, lastFiles: null, lastRecords: 42 } },
      NOW,
    );

    expect(lines.join("\n")).toContain("42 records");
  });

  test("the sidebar says embedding during a pass", () => {
    const base = snapshot();
    const lines = sidebarLines({ ...base, embeddings: true }, NOW);

    expect(lines.join("\n")).toContain("embedding");
  });

  test("an idle stop two days out is shown in days", () => {
    const base = snapshot();
    const body = panelSections(
      { ...base, node: { ...base.node, idleAt: NOW + 3 * 86_400_000 } },
      NOW,
    )
      .flatMap((section) => section.lines)
      .join("\n");

    expect(body).toMatch(/idle stop in \d+d/);
  });

  test("one session is singular", () => {
    const base = snapshot();
    const body = panelSections({ ...base, node: { ...base.node, sessions: 1 } }, NOW)
      .flatMap((section) => section.lines)
      .join("\n");

    expect(body).toContain("1 session");
    expect(body).not.toContain("1 sessions");
  });

  test("a negative net is reported as costing more than it saves", () => {
    const base = snapshot();
    const body = panelSections(
      { ...base, usage: { ...base.usage, netTokens: -500 } },
      NOW,
    )
      .flatMap((section) => section.lines)
      .join("\n");

    expect(body).toContain("costing more than it saves");
  });
});

describe("node line without an idle deadline", () => {
  test("a node with no idle time reports only its sessions", () => {
    const base = snapshot();
    const body = panelSections(
      { ...base, node: { ...base.node, idleAt: null, sessions: 2 } },
      NOW,
    )
      .flatMap((section) => section.lines)
      .join("\n");

    expect(body).toContain("2 sessions");
    expect(body).not.toContain("idle stop");
  });
});

describe("data map and keywords", () => {
  function view(extra: Partial<StatusSnapshot>): StatusSnapshot {
    return { ...snapshot(), ...extra };
  }

  test("the index section lists record kinds", () => {
    const body = panelSections(
      view({
        map: [
          { kind: "function", docs: 545 },
          { kind: "section", docs: 401 },
        ],
      }),
      NOW,
    )
      .flatMap((section) => section.lines)
      .join("\n");

    expect(body).toContain("records: function 545 · section 401");
  });

  test("the map is omitted when the corpus reports no kinds", () => {
    const body = panelSections(view({ map: [] }), NOW)
      .flatMap((section) => section.lines)
      .join("\n");

    expect(body).not.toContain("records:");
  });

  test("configured prjdocs keywords are shown", () => {
    const base = snapshot();
    const body = panelSections(
      view({ config: { ...base.config, prjdocsKeywords: ["fastapi", "polars"] } }),
      NOW,
    )
      .flatMap((section) => section.lines)
      .join("\n");

    expect(body).toContain("prjdocs keywords: fastapi, polars");
  });

  test("no keyword line when none are configured", () => {
    const body = panelSections(view({}), NOW)
      .flatMap((section) => section.lines)
      .join("\n");

    expect(body).not.toContain("prjdocs keywords");
  });
});

describe("status output schema", () => {
  // The host rebuilds the status response from this schema. A field that the
  // type declares but the schema forgets is dropped before the TUI sees it,
  // and `snapshot.process` reading as undefined is what took the sidebar down.
  test("every field the panels read survives the schema", () => {
    const delivered = toSchema(
      snapshot(),
      XerjRpc.methods.status.output,
    ) as StatusSnapshot;

    expect(delivered.process).not.toBeUndefined();
    expect(delivered.frameworks).not.toBeUndefined();
    expect(delivered.memory.exists).not.toBeUndefined();
    expect(delivered.memory.stale).not.toBeUndefined();
    expect(delivered.memory.tuning).not.toBeUndefined();
    expect(delivered.embeddings).not.toBeUndefined();
    expect(() => sidebarView(delivered, NOW, {
      corpora: true,
      session: true,
      savings: true,
      runtime: true,
      health: true,
    })).not.toThrow();
    expect(() => panelSections(delivered, NOW)).not.toThrow();
  });
});

describe("sidebar row guards", () => {
  test("short rows stay inline and long rows stack", () => {
    expect(sidebarRowLayout({ label: "Memory", value: "2" })).toBe("inline");
    expect(
      sidebarRowLayout({ label: "Corpora", value: "error · " + "x".repeat(80) }),
    ).toBe("stacked");
  });
});

describe("sidebarView", () => {
  const all = {
    corpora: true,
    session: true,
    savings: true,
    runtime: true,
    health: true,
  };

  // A long `today` value used to be appended straight after its label, which
  // printed `todayready 0s · ...`. The label column is exactly as wide as the
  // longest label, so a row without a gap has nowhere to put a space.
  test("the State today row stacks instead of touching its label", () => {
    const base = snapshot();
    const view = sidebarView(
      snapshot({
        state: {
          ...base.state,
          today: {
            startingMs: 0,
            readyMs: 0,
            busyMs: 0,
            degradedMs: 60_000,
            stoppedMs: 0,
          },
        },
      }),
      NOW,
      all,
    );

    const state = view.sections.find((section) => section.title === "State");
    const today = state?.rows.find((row) => row.label === "today");
    expect(today).toBeDefined();
    expect(sidebarRowLayout(today!)).toBe("stacked");
  });

  test("collapsed rows name the index, savings and memory", () => {
    const view = sidebarView(snapshot(), NOW, all);

    expect(view.label).toBe("XERJ");
    expect(view.version).toBe("0.1.1");
    expect(view.collapsed.map((row) => row.label)).toEqual(["Index", "Saved", "Memory"]);
    expect(view.collapsed[0]?.value).toContain("437 docs");
    expect(view.collapsed[1]?.value).toContain("75% hit");
  });

  test("a running job shows in the collapsed rows and the badge counts up", () => {
    const base = snapshot();
    const view = sidebarView(
      snapshot({
        state: {
          ...base.state,
          name: "busy",
          detail: "indexing",
          since: NOW - 12_000,
          jobs: [
            { kind: "index", label: "indexing", startedAt: NOW - 12_000 },
            { kind: "web", label: "web index", startedAt: NOW - 3_000 },
            { kind: "git", label: "commits", startedAt: NOW - 1_000 },
          ],
        },
      }),
      NOW,
      all,
    );

    expect(view.badge).toBe("◐ busy · indexing · 12s");
    const jobs = view.collapsed.find((row) => row.label === "Jobs");
    // Two labels fit; the rest are counted so a burst cannot wrap the block.
    expect(jobs?.value).toBe("indexing 12s · web index 3.0s · +1");
    expect(jobs?.tone).toBe("warn");
  });

  test("no jobs row and no elapsed badge while ready", () => {
    const view = sidebarView(snapshot(), NOW, all);

    expect(view.badge).toBe("● ready");
    expect(view.collapsed.map((row) => row.label)).toEqual(["Index", "Saved", "Memory"]);
  });

  test("sections carry label/value rows", () => {
    const view = sidebarView(snapshot(), NOW, all);
    const titles = view.sections.map((section) => section.title);

    expect(titles).toEqual([
      "State",
      "Corpora",
      "Session",
      "Savings",
      "Runtime",
      "Health",
    ]);
    const session = view.sections.find((section) => section.title === "Session");
    expect(session?.rows.map((row) => row.label)).toContain("skipped");
    const savings = view.sections.find((section) => section.title === "Savings");
    expect(savings?.rows.map((row) => row.label)).toEqual(["saved", "cost", "net", "returned"]);
  });

  test("a disabled section is omitted", () => {
    const view = sidebarView(snapshot(), NOW, { ...all, savings: false, health: false });

    expect(view.sections.map((section) => section.title)).toEqual([
      "State",
      "Corpora",
      "Session",
      "Runtime",
    ]);
  });

  test("a failing corpus is marked bad and names its error", () => {
    const base = snapshot();
    const view = sidebarView(
      snapshot({
        corpora: [
          { name: "hidden", state: "error", docs: 0, lastRunAt: null, records: null, edges: null, error: "timed out" },
          ...base.corpora,
        ],
      }),
      NOW,
      all,
    );
    const corpora = view.sections.find((section) => section.title === "Corpora");

    expect(corpora?.rows[0]).toMatchObject({ label: "hidden", tone: "bad" });
    expect(corpora?.rows[0]?.value).toContain("timed out");
  });

  test("a negative net cost is marked bad", () => {
    const base = snapshot();
    const view = sidebarView(
      snapshot({ usage: { ...base.usage, netTokens: -1200 } }),
      NOW,
      all,
    );
    const savings = view.sections.find((section) => section.title === "Savings");
    const net = savings?.rows.find((row) => row.label === "net");

    expect(net?.tone).toBe("bad");
  });
});

describe("distillation in the panel", () => {
  test("reports promoted, per-judge, calls, and recalled", () => {
    const base = snapshot();
    const view = snapshot({
      telemetry: {
        ...base.telemetry,
        distill: {
          promoted: 3,
          heuristic: 2,
          model: 1,
          local: 0,
          recalled: 2,
          calls: 3,
          chars: 4_000,
        },
      },
    });
    const telemetry = panelSections(view, NOW).find(
      (section) => section.title === "Telemetry",
    );
    const text = telemetry?.lines.join("\n") ?? "";

    expect(text).toContain(
      "distilled 3 · heuristic 2 · model 1 · 3 calls · recalled 2",
    );
  });

  test("says nothing when no memory was distilled", () => {
    const telemetry = panelSections(snapshot(), NOW).find(
      (section) => section.title === "Telemetry",
    );
    expect(telemetry?.lines.join("\n")).not.toContain("distilled");
  });
});
