import { describe, expect, test } from "bun:test";
import type { StatusSnapshot } from "../../src/rpc.ts";
import {
  formatAge,
  formatBytes,
  formatCount,
  formatPercent,
  formatTokens,
  panelSections,
  sidebarLines,
} from "../../src/ui/format.ts";

const NOW = 1_120_000;

function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  const base: StatusSnapshot = {
    pluginVersion: "0.1.1",
    updatedAt: NOW,
    node: {
      phase: "ready",
      baseUrl: "http://127.0.0.1:9200",
      serverVersion: "1.0.0-rc.100",
      spawned: false,
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
      restarts: 0,
      lastError: null,
      datasets: [
        { name: "project", docs: 436, bytes: 1_000_000 },
        { name: "web", docs: 1, bytes: 15_000 },
      ],
    },
    config: { indexRoot: "/repo", brain: [], watch: true, contextEnabled: true },
    usage: {
      queries: 12,
      hits: 9,
      hitRate: 0.75,
      bytesReturned: 20_000,
      bytesRead: 50_000,
      baselineBytes: 200_000,
      savedBytes: 180_000,
      tokensSaved: 45_000,
      topFiles: [{ path: "src/a.ts", citations: 3, bytes: 4_000 }],
    },
    memory: { namespace: "proj-demo-1a2b3c4d", count: 2 },
    brains: [],
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
    expect(lines[2]).toContain("437 records");
    expect(lines[3]).toContain("/xerj");
  });

  test("reports a node that is still starting", () => {
    const lines = sidebarLines(
      snapshot({
        node: { ...snapshot().node, phase: "starting" },
        index: { ...snapshot().index, docs: 0 },
      }),
      NOW,
    );

    expect(lines[0]).toContain("starting");
  });
});

describe("panelSections", () => {
  test("covers every section of the details panel", () => {
    const sections = panelSections(snapshot(), NOW);
    const titles = sections.map((section) => section.title);
    const body = sections.flatMap((section) => section.lines).join("\n");

    expect(titles).toEqual([
      "Node",
      "Binary",
      "Index",
      "Datasets",
      "Memory",
      "Usage",
      "Top cited",
      "Health",
    ]);
    expect(body).toContain("x86_64-unknown-linux-musl");
    expect(body).toContain("web  1 docs · 14.6 KB");
    expect(body).toContain("2 entries");
    expect(body).toContain("src/a.ts ×3");
    expect(body).toContain("warn: retry");
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
