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
): {
  run: (input: unknown) => Promise<{ content: string; metadata: Record<string, any> }>;
  recorded: Array<{ paths: string[]; bytes: number; hits: number }>;
} {
  const recorded: Array<{ paths: string[]; bytes: number; hits: number }> = [];
  const tools = buildTools({
    config: DEFAULT_CONFIG,
    getSearch: () => search,
    getMemory: () => null,
    getSpool: () => null,
    getAnomaly: () => null,
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
