import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { buildTools } from "../../src/tools/search.ts";
import type { SearchService } from "../../src/search/service.ts";
import type { StatusSnapshot } from "../../src/rpc.ts";

const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;

function snapshot(overrides: Partial<StatusSnapshot["index"]> = {}): StatusSnapshot {
  return {
    index: {
      prefix: "xop-proj-abc",
      docs: 891,
      bytes: 1000,
      indices: 1,
      datasets: [],
      state: "watching",
      lastRunAt: null,
      lastGeneration: 3,
      lastRecords: 891,
      lastFiles: 75,
      restarts: 0,
      lastError: null,
      ...overrides,
    },
  } as unknown as StatusSnapshot;
}

function toolFor(
  search: SearchService | null,
  status: StatusSnapshot = snapshot(),
  overrides: {
    memory?: unknown;
    spool?: unknown;
    anomaly?: unknown;
  } = {},
): {
  run: (input: unknown) => Promise<{ content: string; metadata: Record<string, any> }>;
  recorded: Array<{ paths: string[]; bytes: number; hits: number }>;
} {
  const recorded: Array<{ paths: string[]; bytes: number; hits: number }> = [];
  const tools = buildTools({
    config: DEFAULT_CONFIG,
    getSearch: () => search,
    getMemory: () => (overrides.memory ?? null) as never,
    getSpool: () => (overrides.spool ?? null) as never,
    getAnomaly: () => (overrides.anomaly ?? null) as never,
    snapshot: async () => status,
    ledger: {
      recordQuery: async (_session: string, paths: string[], bytes: number, hits: number) => {
        recorded.push({ paths: [...paths], bytes, hits });
      },
    } as never,
  });
  const searchTool = tools.find((tool) => tool.name === "search");
  if (searchTool === undefined) throw new Error("search tool is missing");
  return {
    recorded,
    run: (input: unknown) =>
      searchTool.execute(input, {
        sessionID: "s1",
        signal: new AbortController().signal,
      }) as Promise<{ content: string; metadata: Record<string, any> }>,
  };
}

function fakeSearch(result: Record<string, unknown>): SearchService {
  return { search: async () => result } as unknown as SearchService;
}

describe("xerj_search tool", () => {
  test("returns the passages and their metadata", async () => {
    const { run, recorded } = toolFor(
      fakeSearch({
        hits: [{ path: "src/a.ts", line: 1, text: "code" }],
        text: "[1] src/a.ts:1\ncode",
        bytes: 20,
        strategy: "hybrid",
        narrowingBytes: 5,
      }),
    );
    const result = await run({ query: "where is the watcher" });

    expect(result.content).toBe("[1] src/a.ts:1\ncode");
    expect(result.metadata.xerj).toMatchObject({ hits: 1, bytes: 20, strategy: "hybrid" });
    expect(recorded).toEqual([{ paths: ["src/a.ts"], bytes: 20, hits: 1 }]);
  });

  test("an empty result says what the index holds and what to try next", async () => {
    const { run } = toolFor(
      fakeSearch({ hits: [], text: "", bytes: 0, strategy: "hybrid", narrowingBytes: 0 }),
    );
    const result = await run({ query: "nothing matches this" });

    expect(result.content).toContain("No passages matched");
    expect(result.content).toContain("891 records");
    expect(result.content).toContain("75 files");
    expect(result.content).toContain("xerj_def");
    expect(result.metadata.xerj).toMatchObject({ hits: 0, bytes: 0 });
  });

  test("reports an index that is still building", async () => {
    const { run } = toolFor(
      fakeSearch({ hits: [], text: "", bytes: 0, strategy: "lexical", narrowingBytes: 0 }),
      snapshot({ docs: 0, state: "starting", lastFiles: 0 }),
    );
    const result = await run({ query: "where is the watcher" });

    expect(result.content).toContain("still indexing");
  });

  test("answers when the search service is not ready", async () => {
    const { run, recorded } = toolFor(null);
    const result = await run({ query: "where is the watcher" });

    expect(result.content).toContain("not ready");
    expect(result.metadata.xerj).toMatchObject({ ready: false });
    expect(recorded).toEqual([]);
  });
});

describe("the rest of the tool surface", () => {
  function allTools(overrides: {
    memory?: unknown;
    spool?: unknown;
    anomaly?: unknown;
    search?: SearchService | null;
  } = {}) {
    const tools = buildTools({
      config: DEFAULT_CONFIG,
      getSearch: () => overrides.search ?? null,
      getMemory: () => (overrides.memory ?? null) as never,
      getSpool: () => (overrides.spool ?? null) as never,
      getAnomaly: () => (overrides.anomaly ?? null) as never,
      snapshot: async () => snapshot(),
      ledger: { recordQuery: async () => {} } as never,
    });
    return (name: string, input: unknown) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (tool === undefined) throw new Error(`${name} is missing`);
      return tool.execute(input, {
        sessionID: "s1",
        signal: new AbortController().signal,
      }) as Promise<{ content: string; metadata: Record<string, any> }>;
    };
  }

  test("def returns the declaration text", async () => {
    const run = allTools({
      search: {
        definition: async () => ({
          hits: [{ path: "src/a.ts", line: 3, text: "function run()" }],
          text: "[1] src/a.ts:3 [function]\nfunction run()",
          bytes: 40,
        }),
      } as unknown as SearchService,
    });
    const result = await run("def", { symbol: "run" });

    expect(result.content).toContain("src/a.ts:3");
    expect(result.metadata.xerj).toMatchObject({ hits: 1 });
  });

  test("remember reports whether it was new", async () => {
    const run = allTools({
      memory: {
        remember: async () => ({ id: "abc123", created: false }),
      },
    });
    const result = await run("remember", { text: "a fact" });

    expect(result.content).toBe("Already remembered as abc123.");
    expect(result.metadata.xerj).toMatchObject({ memory: "abc123", created: false });
  });

  test("recall formats memories and counts them", async () => {
    const run = allTools({
      memory: {
        recall: async () => [
          { id: "a", text: "the node idles for thirty minutes", metadata: {}, score: 1 },
        ],
      },
    });
    const result = await run("recall", { query: "idle timeout" });

    expect(result.content).toContain("thirty minutes");
    expect(result.metadata.xerj).toMatchObject({ memories: 1 });
  });

  test("recall says so when nothing matches", async () => {
    const run = allTools({ memory: { recall: async () => [] } });
    const result = await run("recall", { query: "unrelated" });

    expect(result.content).toBe("No memories matched.");
    expect(result.metadata.xerj).toMatchObject({ memories: 0 });
  });

  test("forget distinguishes a retraction from a miss", async () => {
    const run = allTools({ memory: { forget: async (id: string) => id === "known" } });

    expect((await run("forget", { id: "known" })).content).toBe("Forgot known.");
    expect((await run("forget", { id: "gone" })).content).toBe("No memory with id gone.");
  });

  test("index stores an external file through the spool", async () => {
    const run = allTools({
      spool: {
        ingestExternalFile: async () => ({ path: "/tmp/notes.md", bytes: 512 }),
      },
    });
    const result = await run("index", { path: "/tmp/notes.md" });

    expect(result.content).toBe("Indexed /tmp/notes.md (512 bytes).");
    expect(result.metadata.xerj).toMatchObject({ indexed: true, bytes: 512 });
  });

  test("index explains an unreadable file instead of claiming success", async () => {
    const run = allTools({ spool: { ingestExternalFile: async () => null } });
    const result = await run("index", { path: "/tmp/binary.bin" });

    expect(result.content).toContain("Could not index");
    expect(result.metadata.xerj).toMatchObject({ indexed: false });
  });

  test("anomaly returns the flagged buckets", async () => {
    const run = allTools({
      anomaly: {
        score: async () => ({
          detector: "det-1",
          index: "metrics",
          anomalyCount: 1,
          buckets: 16,
          threshold: 3,
          points: [
            { timestamp: "2026-11-05T12:00:00Z", actual: 96, expected: 20, zScore: 65, score: 100 },
          ],
        }),
      },
    });
    const result = await run("anomaly", { index: "metrics", function: "count" });

    expect(result.metadata.xerj).toMatchObject({ anomalyCount: 1, detector: "det-1" });
    expect(result.content).toContain("96");
  });

  test("status answers with the snapshot", async () => {
    const run = allTools();
    const result = await run("status", {});

    expect(JSON.parse(result.content).index.docs).toBe(891);
    expect(result.metadata.xerj).toMatchObject({ kind: "status" });
  });

  test("every tool reports not-ready rather than throwing", async () => {
    const run = allTools();
    for (const [name, input] of [
      ["def", { symbol: "run" }],
      ["remember", { text: "x" }],
      ["recall", { query: "x" }],
      ["forget", { id: "x" }],
      ["index", { path: "/tmp/x.md" }],
      ["anomaly", { index: "metrics" }],
    ] as const) {
      const result = await run(name, input);
      expect(result.content).toContain("not ready");
    }
  });
});
