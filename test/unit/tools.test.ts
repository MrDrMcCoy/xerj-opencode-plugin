import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    projectRoot: process.cwd(),
    getArchive: () => null,
    logger: { debug() {}, info() {}, warn() {}, error() {}, entries: async () => [], flush: async () => {} },
    getClient: () => null,
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
      projectRoot: process.cwd(),
      getArchive: () => null,
    logger: { debug() {}, info() {}, warn() {}, error() {}, entries: async () => [], flush: async () => {} },
    getClient: () => null,
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

  test("expand says the archive is off when it is disabled", async () => {
    const run = allTools();
    const result = await run("expand", { sessionID: "s1" });

    expect(result.content).toContain("archive is disabled");
    expect(result.metadata.xerj.available).toBe(false);
  });

  test("ast explains how to get ast-grep when it is missing", async () => {
    // This machine has no ast-grep; the tool must say so rather than fail.
    const run = allTools();
    const result = await run("ast", { pattern: "console.log($A)", lang: "ts" });

    if (result.metadata.xerj.available === false) {
      expect(result.content).toContain("ast-grep is not installed");
      expect(result.content).toContain("xerj_find");
    } else {
      expect(result.content).toMatch(/structural/);
    }
  });

  test("find reports matches with paths and lines", async () => {
    const run = allTools();
    const result = await run("find", { pattern: "createServer|somethingUnlikelyToExist", limit: 5 });

    expect(result.metadata.xerj.kind).toBe("find");
    expect(result.content.length).toBeGreaterThan(0);
  });

  test("find rejects an invalid pattern without throwing", async () => {
    const run = allTools();
    const result = await run("find", { pattern: "([" });

    expect(result.content).toContain("Invalid pattern");
    expect(result.metadata.xerj.error).toBe(true);
  });

  test("find lists paths when asked for files only", async () => {
    const run = allTools();
    const result = await run("find", { pattern: "**/*.md", files_only: true, limit: 5 });

    expect(result.metadata.xerj.kind).toBe("find");
    expect(result.content.length).toBeGreaterThan(0);
  });

  test("imports reports cycles", async () => {
    const run = allTools();
    const result = await run("imports", {});

    expect(result.content).toMatch(/import cycle|No import cycles/);
    expect(result.metadata.xerj.kind).toBe("imports");
  });

  test("imports lists one file's specifiers", async () => {
    const run = allTools();
    const result = await run("imports", { action: "file", path: "package.json" });

    expect(result.content.length).toBeGreaterThan(0);
  });

  test("imports needs a path for action=file", async () => {
    const run = allTools();
    const result = await run("imports", { action: "file" });

    expect(result.content).toContain("needs a path");
  });

  test("refs lists the declarations that use a symbol", async () => {
    const calls: Array<{ symbol: string; k?: number }> = [];
    const run = allTools({
      search: {
        references: async (symbol: string, options: { k?: number }) => {
          calls.push({ symbol, k: options.k });
          return { hits: [{ path: "src/a.ts", line: 12 }], text: "1. src/a.ts:12", bytes: 15 };
        },
      } as unknown as SearchService,
    });
    const result = await run("refs", { symbol: "buildTools" });

    expect(result.content).toContain("src/a.ts:12");
    expect(result.metadata.xerj).toMatchObject({ hits: 1 });
    expect(calls).toEqual([{ symbol: "buildTools", k: undefined }]);
  });

  test("refs says so when the symbol is unused", async () => {
    const run = allTools({
      search: {
        references: async () => ({ hits: [], text: "", bytes: 0 }),
      } as unknown as SearchService,
    });
    const result = await run("refs", { symbol: "unusedThing" });

    expect(result.content).toContain("No declaration in the index uses unusedThing");
  });

  test("outline lists a file's symbols", async () => {
    const run = allTools({
      search: {
        outline: async () => ({
          hits: [{ path: "src/a.ts", line: 3 }],
          text: "1. src/a.ts:3 [function] run",
          bytes: 30,
        }),
      } as unknown as SearchService,
    });
    const result = await run("outline", { path: "src/a.ts" });

    expect(result.content).toContain("src/a.ts:3");
    expect(result.metadata.xerj).toMatchObject({ hits: 1 });
  });

  test("outline reports a file with no indexed symbols", async () => {
    const run = allTools({
      search: { outline: async () => ({ hits: [], text: "", bytes: 0 }) } as unknown as SearchService,
    });
    const result = await run("outline", { path: "notes.md" });

    expect(result.content).toContain("No symbols indexed for notes.md");
  });

  test("zoom returns one declaration and caps k", async () => {
    const seen: Array<{ path: string; name: string; k?: number }> = [];
    const run = allTools({
      search: {
        symbol: async (path: string, name: string, options: { k?: number }) => {
          seen.push({ path, name, k: options.k });
          return { hits: [{ path, line: 7 }], text: "[1] src/a.ts:7\nfunction run() {}", bytes: 40 };
        },
      } as unknown as SearchService,
    });
    const result = await run("zoom", { path: "src/a.ts", symbol: "run", k: 40 });

    expect(result.content).toContain("function run()");
    expect(seen[0]?.k).toBe(10);
  });

  test("zoom reports a missing symbol", async () => {
    const run = allTools({
      search: {
        symbol: async () => ({ hits: [], text: "", bytes: 0 }),
      } as unknown as SearchService,
    });
    const result = await run("zoom", { path: "src/a.ts", symbol: "nope" });

    expect(result.content).toContain("No declaration named nope in src/a.ts");
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

describe("dataset tool", () => {
  /** A client good enough for the dataset actions under test. */
  function datasetClient(): {
    calls: string[];
    client: unknown;
  } {
    const calls: string[] = [];
    const client = {
      indices: async () => [
        { index: "my-notes", docs: 3, bytes: 2048 },
        { index: "xop-project-1234-docs", docs: 9, bytes: 4096 },
      ],
      mappings: async () => ({ "my-notes": { properties: { body: { type: "text" } } } }),
      put: async (path: string) => void calls.push(`put ${path}`),
      deleteIndex: async (index: string) => void calls.push(`delete ${index}`),
      search: async () => ({
        hits: { hits: [{ _id: "1", _source: { body: "x" } }] },
      }),
      bulk: async (index: string) => void calls.push(`bulk ${index}`),
    };
    return { calls, client };
  }

  function toolsWith(getClient: () => unknown): ReadonlyArray<{
    name: string;
    execute: (input: unknown, context: unknown) => Promise<unknown>;
  }> {
    return buildTools({
      config: DEFAULT_CONFIG,
      projectRoot: process.cwd(),
      getArchive: () => null,
      ledger: {} as never,
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
        entries: async () => [],
        flush: async () => {},
      },
      getClient: getClient as never,
      getSearch: () => null,
      getMemory: () => null,
      getSpool: () => null,
      getAnomaly: () => null,
      snapshot: async () => ({}) as never,
    }) as never;
  }

  async function run(
    getClient: () => unknown,
    input: Record<string, unknown>,
  ): Promise<{ content: string }> {
    const tool = toolsWith(getClient).find((candidate) => candidate.name === "dataset");
    expect(tool).toBeDefined();
    return (await tool?.execute(input, {})) as { content: string };
  }

  test("lists indexes and marks the managed ones", async () => {
    const { client } = datasetClient();
    const result = await run(() => client, { action: "list" });

    expect(result.content).toContain("my-notes · 3 docs");
    expect(result.content).toContain("managed");
  });

  test("describes one index with its mapping", async () => {
    const { client } = datasetClient();
    const result = await run(() => client, { action: "describe", index: "my-notes" });

    expect(result.content).toContain("my-notes");
    expect(result.content).toContain('"body"');
  });

  test("a missing index says so", async () => {
    const { client } = datasetClient();
    const result = await run(() => client, { action: "describe", index: "absent" });

    expect(result.content).toContain("no index named");
  });

  test("deleting a managed index explains that force is needed", async () => {
    const { client, calls } = datasetClient();
    const result = await run(() => client, {
      action: "delete",
      index: "xop-project-1234-docs",
    });

    expect(result.content).toContain("force");
    expect(calls).toEqual([]);
  });

  test("creating an index is reported", async () => {
    const { client, calls } = datasetClient();
    const result = await run(() => client, { action: "create", index: "fresh" });

    expect(result.content).toContain("created fresh");
    expect(calls).toContain("put /fresh");
  });

  test("an unknown action is reported, not thrown", async () => {
    const { client } = datasetClient();
    const result = await run(() => client, { action: "explode" });

    expect(result.content).toContain("unknown dataset action");
  });

  test("a missing client reports that the node is not ready", async () => {
    const result = await run(() => null, { action: "list" });
    expect(result.content).toContain("not available");
  });

  test("export and import require a path", async () => {
    const { client } = datasetClient();
    expect((await run(() => client, { action: "export", index: "x" })).content).toContain(
      "needs index and path",
    );
    expect((await run(() => client, { action: "import" })).content).toContain(
      "needs a path",
    );
  });
});

describe("dataset tool export and import", () => {
  test("export writes a dump and reports the count", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xerj-dataset-tool-"));
    const path = join(dir, "dump.ndjson");
    const client = {
      indices: async () => [{ index: "notes", docs: 2, bytes: 100 }],
      search: async () => ({
        hits: {
          hits: [
            { _id: "1", _source: { body: "one" } },
            { _id: "2", _source: { body: "two" } },
          ],
        },
      }),
    };

    const tools = buildTools({
      config: DEFAULT_CONFIG,
      projectRoot: process.cwd(),
      getArchive: () => null,
      ledger: {} as never,
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
        entries: async () => [],
        flush: async () => {},
      },
      getClient: () => client as never,
      getSearch: () => null,
      getMemory: () => null,
      getSpool: () => null,
      getAnomaly: () => null,
      snapshot: async () => ({}) as never,
    });
    const tool = tools.find((candidate) => candidate.name === "dataset");
    const result = (await tool?.execute(
      { action: "export", index: "notes", path },
      {},
    )) as { content: string };

    expect(result.content).toContain("exported 2 documents");
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(4);

    await rm(dir, { recursive: true, force: true });
  });

  test("import reports the created index and skipped lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xerj-dataset-tool-"));
    const path = join(dir, "dump.ndjson");
    await writeFile(
      path,
      ['{"index":{"_index":"fresh","_id":"1"}}', '{"body":"x"}', "junk", ""].join("\n"),
    );

    const created: string[] = [];
    const client = {
      indices: async () => [],
      put: async (index: string) => void created.push(index),
      bulk: async () => {},
    };

    const tools = buildTools({
      config: DEFAULT_CONFIG,
      projectRoot: process.cwd(),
      getArchive: () => null,
      ledger: {} as never,
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
        entries: async () => [],
        flush: async () => {},
      },
      getClient: () => client as never,
      getSearch: () => null,
      getMemory: () => null,
      getSpool: () => null,
      getAnomaly: () => null,
      snapshot: async () => ({}) as never,
    });
    const tool = tools.find((candidate) => candidate.name === "dataset");
    const result = (await tool?.execute({ action: "import", path }, {})) as {
      content: string;
    };

    expect(result.content).toContain("imported 1 documents into fresh");
    expect(result.content).toContain("index created");
    expect(result.content).toContain("lines skipped");
    expect(created).toContain("/fresh");

    await rm(dir, { recursive: true, force: true });
  });
});
