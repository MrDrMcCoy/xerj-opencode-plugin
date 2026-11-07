import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchService } from "../../src/search/service.ts";
import type { XerjClient } from "../../src/node/client.ts";
import type { Logger } from "../../src/log.ts";

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

interface SearchCall {
  index: string;
  body: Record<string, unknown>;
}

interface FakeClient {
  searches: SearchCall[];
  mappingCalls: number;
  mappingsResult: Record<string, Record<string, string>>;
  searchResults: Array<unknown>;
}

function fakeClient(overrides: Partial<FakeClient> = {}): XerjClient & FakeClient {
  const fake: FakeClient = {
    searches: [],
    mappingCalls: 0,
    mappingsResult: {
      "xop-p-docs": {
        body: "semantic_text",
        path: "keyword",
        start_line: "integer",
      },
    },
    searchResults: [],
    ...overrides,
  };

  return Object.assign(fake, {
    mappings: async () => {
      fake.mappingCalls += 1;
      return fake.mappingsResult;
    },
    search: async (index: string, body: Record<string, unknown>) => {
      fake.searches.push({ index, body });
      const result = fake.searchResults.shift() ?? { hits: { hits: [] } };
      return result;
    },
  }) as unknown as XerjClient & FakeClient;
}

function hit(
  overrides: {
    index?: string;
    id?: string;
    path?: string | null;
    text?: string;
    startLine?: number | null;
    startOffset?: number;
  } = {},
): unknown {
  return {
    _index: overrides.index ?? "xop-p-docs",
    _id: overrides.id ?? "h1",
    _score: 2,
    _source: {
      ax_path: overrides.path ?? "src/a.ts",
      start_line: overrides.startLine ?? null,
      body: overrides.text ?? "the watcher writes its journal state here",
    },
    fields: {
      _passage: [
        {
          text: overrides.text ?? "the watcher writes its journal state here",
          ordinal: 1,
          start_offset: overrides.startOffset ?? 0,
        },
      ],
    },
  };
}

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "xerj-search-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "alpha\nbeta gamma\ndelta\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

function service(
  client: XerjClient,
  overrides: {
    prefixes?: string[];
    brains?: null;
    brainSpecs?: Array<{ name: string; prefix: string; directory: string; label: string }>;
    hiddenIndex?: string | null;
  } = {},
): SearchService {
  return new SearchService(
    client,
    overrides.prefixes ?? ["xop-p"],
    logger,
    root,
    null,
    overrides.brainSpecs ?? [],
    overrides.hiddenIndex ?? null,
  );
}

describe("search legs", () => {
  test("runs a lexical and a semantic leg when body is semantic_text", async () => {
    const client = fakeClient({
      searchResults: [{ hits: { hits: [hit()] } }, { hits: { hits: [] } }],
    });
    const result = await service(client).search("watcher journal");

    expect(client.searches).toHaveLength(2);
    expect(client.searches[0]!.body.query).toMatchObject({ match: { body: "watcher journal" } });
    expect(client.searches[1]!.body.query).toMatchObject({
      semantic: { field: "body", query: "watcher journal" },
    });
    expect(result.strategy).toBe("hybrid");
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ path: "src/a.ts", line: null });
  });

  test("the semantic leg covers only indices whose body is semantic_text", async () => {
    // A `semantic` query is refused for the whole pattern when one index maps
    // body as plain text, which used to lose the semantic leg entirely once the
    // docs and commit corpora joined the search.
    const client = fakeClient({
      mappingsResult: {
        "xop-p-docs": { body: "semantic_text", path: "keyword", start_line: "integer" },
        "xop-p-prjdocs-docs": { body: "text", title: "keyword" },
        "xop-p-git-docs": { body: "text", subject: "text" },
      },
      searchResults: [{}, {}, {}],
    });
    await service(client).search("watcher journal");

    const lexical = client.searches[0]!;
    const semantic = client.searches.find((call) => "semantic" in (call.body.query as object));

    expect(lexical.index.split(",")).toContain("xop-p-prjdocs-docs");
    expect(semantic?.index).toBe("xop-p-docs");
  });

  test("stays lexical when body is not semantic_text", async () => {
    const client = fakeClient({
      mappingsResult: { "xop-p-docs": { body: "text", path: "keyword" } },
      searchResults: [{ hits: { hits: [] } }],
    });
    const result = await service(client).search("watcher journal");

    expect(client.searches).toHaveLength(1);
    expect(result.strategy).toBe("lexical");
    expect(result.text).toBe("");
  });

  test("keeps the lexical result when the semantic leg fails", async () => {
    const client = fakeClient();
    const raw = client as unknown as FakeClient & {
      search: (index: string, body: Record<string, unknown>) => Promise<unknown>;
    };
    let call = 0;
    raw.search = async (index: string, body: Record<string, unknown>) => {
      call += 1;
      if (call === 1) {
        raw.searches.push({ index, body });
        return { hits: { hits: [hit()] } };
      }
      throw new Error("semantic is down");
    };

    // The semantic leg contributed nothing, so the run reports as lexical.
    const result = await service(client).search("watcher journal");
    expect(result.strategy).toBe("lexical");
    expect(result.hits).toHaveLength(1);
  });

  test("fuses duplicate hits from both legs into one entry", async () => {
    const client = fakeClient({
      searchResults: [
        {
          hits: {
            hits: [hit({ id: "a" }), hit({ id: "b", text: "second passage text here" })],
          },
        },
        { hits: { hits: [hit({ id: "b", text: "second passage text here" }), hit({ id: "a" })] } },
      ],
    });
    const result = await service(client).search("watcher journal");

    expect(result.hits).toHaveLength(2);
    // `a` ranks first in one leg and second in the other; `b` mirrors it, so
    // their fused scores are equal and both survive above any third hit.
    expect(result.hits.map((entry) => entry.id).sort()).toEqual(["a", "b"]);
    expect(result.hits[0]!.score).toBeCloseTo(result.hits[1]!.score);
  });

  test("an excluded hit never reaches the result or the budget", async () => {
    const client = fakeClient({
      searchResults: [
        { hits: { hits: [hit({ id: "a" }), hit({ id: "b", text: "second passage text" })] } },
        { hits: { hits: [] } },
      ],
    });
    const excluded: string[] = [];
    const result = await service(client).search("watcher journal", {
      surface: "tool",
      exclude: (entry) => {
        excluded.push(entry.id);
        return entry.id === "a";
      },
    });

    expect(excluded).toContain("a");
    expect(result.hits.map((entry) => entry.id)).toEqual(["b"]);
    expect(result.text).not.toContain("first passage");
  });

  test("sums the narrowing bytes of both legs", async () => {
    const client = fakeClient({
      searchResults: [
        { _savings: { bytes: 120 }, hits: { hits: [] } },
        { _savings: { bytes: 34 }, hits: { hits: [] } },
      ],
    });
    const result = await service(client).search("watcher journal");
    expect(result.narrowingBytes).toBe(154);
  });

  test("answers an empty query with an empty lexical result", async () => {
    const client = fakeClient();
    const result = await service(client).search("   ");
    expect(result.text).toBe("");
    expect(result.hits).toHaveLength(0);
    expect(client.searches).toHaveLength(0);
  });

  test("caches mappings between searches and invalidates on demand", async () => {
    const client = fakeClient({ searchResults: [{ hits: { hits: [] } }, { hits: { hits: [] } }] });
    const instance = service(client);
    await instance.search("watcher journal");
    await instance.search("watcher journal");
    expect(client.mappingCalls).toBe(1);

    instance.invalidate();
    await instance.search("watcher journal");
    expect(client.mappingCalls).toBe(2);
  });
});

describe("line resolution", () => {
  test("resolves the exact line from a whole-file record offset", async () => {
    // "beta gamma" starts at byte 6; the passage match is on its first line.
    const client = fakeClient({
      searchResults: [
        { hits: { hits: [hit({ text: "beta gamma\ndelta", startOffset: 6, startLine: 1 })] } },
      ],
    });
    const result = await service(client).search("gamma");
    expect(result.hits[0]!.line).toBe(2);
  });

  test("keeps the section start line when no term matches the passage", async () => {
    const client = fakeClient({
      searchResults: [
        { hits: { hits: [hit({ text: "unrelated text", startLine: 41 })] } },
      ],
    });
    const result = await service(client).search("gamma");
    expect(result.hits[0]!.line).toBe(41);
  });

  test("falls back to the start line when the file cannot be read", async () => {
    const client = fakeClient({
      searchResults: [
        {
          hits: {
            hits: [
              hit({ path: "src/missing.ts", text: "beta gamma", startOffset: 6, startLine: 1 }),
            ],
          },
        },
      ],
    });
    const result = await service(client).search("gamma");
    expect(result.hits[0]!.line).toBe(1);
  });

  // The line cache used to outlive an edit, so a citation kept the line
  // number from the text the first search saw. Every corpus run invalidates
  // the service, and that has to drop the file bodies too.
  test("invalidate drops stale file text so a moved line resolves again", async () => {
    const path = "src/line-cache.txt";
    const file = join(root, "src", "line-cache.txt");
    await writeFile(file, "one\nterm here\n");

    const client = fakeClient({
      searchResults: [
        { hits: { hits: [hit({ path, text: "term here", startOffset: 4, startLine: 1 })] } },
      ],
    });
    const instance = service(client);
    const first = await instance.search("term");
    expect(first.hits[0]!.line).toBe(2);

    // A new line above the passage: the cached text would still say line 2.
    await writeFile(file, "zero\none\nterm here\n");
    client.searchResults.push({
      hits: { hits: [hit({ path, text: "term here", startOffset: 9, startLine: 1 })] },
    });
    instance.invalidate();
    const second = await instance.search("term");
    expect(second.hits[0]!.line).toBe(3);
  });

  test("clamps a trailing offset to the end of the file", async () => {
    const client = fakeClient({
      searchResults: [
        { hits: { hits: [hit({ text: "beta gamma", startOffset: 99_000, startLine: 1 })] } },
      ],
    });
    const result = await service(client).search("gamma");
    // The file has three newlines, so the clamped offset puts the match on 4.
    expect(result.hits[0]!.line).toBe(4);
  });
});

describe("generated files", () => {
  test("the context surface drops generated files unless the query names them", async () => {
    const client = fakeClient({
      searchResults: [
        {
          hits: {
            hits: [
              hit({ id: "gen", path: "package-lock.json" }),
              hit({ id: "src", path: "src/a.ts" }),
            ],
          },
        },
      ],
    });
    const dropped = await service(client).search("watcher journal", { surface: "context" });
    expect(dropped.hits.map((entry) => entry.path)).toEqual(["src/a.ts"]);

    const named = fakeClient({
      searchResults: [
        {
          hits: {
            hits: [
              hit({ id: "gen", path: "package-lock.json" }),
              hit({ id: "src", path: "src/a.ts" }),
            ],
          },
        },
      ],
    });
    // Naming the lockfile keeps it; `src/a.ts` now fails the coverage gate
    // because its passage shares no term with that query.
    const kept = await service(named).search("package-lock.json hash", { surface: "context" });
    expect(kept.hits.map((entry) => entry.path)).toEqual(["package-lock.json"]);

    const tools = fakeClient({
      searchResults: [
        {
          hits: {
            hits: [
              hit({ id: "gen", path: "package-lock.json" }),
              hit({ id: "src", path: "src/a.ts" }),
            ],
          },
        },
      ],
    });
    const toolResult = await service(tools).search("watcher journal", { surface: "tool" });
    expect(toolResult.hits).toHaveLength(2);
  });
});

describe("shadowed whole files", () => {
  test("a hidden whole-file hit yields to a brain section of the same path", async () => {
    const brainSpecs = [
      { name: "agents-1234", prefix: "xop-agents-5678", directory: join(root, ".agents"), label: ".agents" },
    ];
    const client = fakeClient({
      searchResults: [
        {
          hits: {
            hits: [
              hit({ id: "whole", index: "xop-p-hidden-docs", path: ".agents/plan.md" }),
              hit({ id: "section", index: "xop-agents-5678-docs", path: "plan.md" }),
            ],
          },
        },
      ],
    });
    const result = await service(client, { brainSpecs, hiddenIndex: "xop-p-hidden-docs" }).search(
      "watcher journal",
    );

    expect(result.hits.map((entry) => entry.id)).toEqual(["section"]);
    // The brain-relative path was rewritten to the project.
    expect(result.hits[0]!.path).toBe(".agents/plan.md");
  });
});

describe("definition", () => {
  test("queries only indices that carry code", async () => {
    const client = fakeClient({
      mappingsResult: {
        "xop-p-docs": { body: "semantic_text" },
        "xop-p-symbols": { "symbols.name": "keyword", code: "text" },
      },
      searchResults: [
        {
          hits: {
            hits: [
              hit({
                index: "xop-p-symbols",
                text: "export function watcher() {}",
                startLine: 12,
              }),
            ],
          },
        },
      ],
    });
    const result = await service(client).definition("watcher");

    expect(client.searches).toHaveLength(1);
    expect(client.searches[0]!.index).toBe("xop-p-symbols");
    expect(client.searches[0]!.body.query).toMatchObject({ bool: { minimum_should_match: 1 } });
    expect(result.strategy).toBe("definition");
    expect(result.hits[0]).toMatchObject({ path: "src/a.ts", line: 12 });
  });

  test("answers empty without code indices", async () => {
    const client = fakeClient({
      mappingsResult: { "xop-p-docs": { body: "semantic_text" } },
    });
    const result = await service(client).definition("watcher");
    expect(result.hits).toHaveLength(0);
    expect(result.text).toBe("");
    expect(client.searches).toHaveLength(0);
  });

  test("answers empty for a blank symbol", async () => {
    const client = fakeClient();
    const result = await service(client).definition("  ");
    expect(result.hits).toHaveLength(0);
  });
});

describe("symbol and title leg", () => {
  test("runs a third leg when the mapping has a name field", async () => {
    const client = fakeClient({
      mappingsResult: {
        "xop-p-docs": { body: "semantic_text", name: "text", title: "text", path: "keyword" },
      },
      searchResults: [
        { hits: { hits: [hit({ id: "lex", path: "README.md" })] } },
        { hits: { hits: [hit({ id: "sme", path: "docs/guide.md" })] } },
        { hits: { hits: [hit({ id: "nam", path: "src/platform.ts" })] } },
      ],
    });

    const service = new SearchService(client, ["xop-p"], logger, process.cwd());
    const result = await service.search("how is a target chosen", { k: 5 });

    expect(client.searches).toHaveLength(3);
    const legs = client.searches.map((call) => JSON.stringify(call.body.query));
    expect(legs.some((body) => body.includes("multi_match"))).toBe(true);
    expect(legs.some((body) => body.includes('"name^3"'))).toBe(true);
    expect(result.hits.map((entry) => entry.path)).toContain("src/platform.ts");
  });

  test("skips the leg when there is no name field", async () => {
    const client = fakeClient({
      searchResults: [{ hits: { hits: [hit({ path: "src/a.ts" })] } }],
    });

    const service = new SearchService(client, ["xop-p"], logger, process.cwd());
    await service.search("where is the config", { k: 5 });

    // Lexical plus semantic; no third leg without a `name` field.
    expect(client.searches).toHaveLength(2);
    expect(client.searches.some((call) => "multi_match" in (call.body.query as object))).toBe(
      false,
    );
  });

  test("a failing name leg leaves the other legs working", async () => {
    let calls = 0;
    const base = fakeClient({
      mappingsResult: {
        "xop-p-docs": { body: "text", name: "text", path: "keyword" },
      },
    });
    const client = Object.assign(base, {
      search: async (index: string, body: Record<string, unknown>) => {
        calls += 1;
        if (calls === 2) throw new Error("leg refused");
        return { hits: { hits: [hit({ path: "src/a.ts" })] } };
      },
    });

    const service = new SearchService(client, ["xop-p"], logger, process.cwd());
    const result = await service.search("where is the config", { k: 5 });

    expect(result.hits.length).toBeGreaterThan(0);
  });
});

describe("symbol navigation", () => {
  const codeMappings = {
    "xop-p-docs": { ax_path: "keyword", code: "text", name: "keyword", start_line: "integer" },
  };

  function codeHit(name: string, line: number, code = "export function x() {}"): unknown {
    return {
      _index: "xop-p-docs",
      _id: `id-${name}-${line}`,
      _score: 3,
      _source: {
        ax_path: "src/a.ts",
        name,
        kind: "function",
        start_line: line,
        code,
      },
    };
  }

  test("references list the declarations that use a symbol", async () => {
    const client = fakeClient({
      mappingsResult: codeMappings,
      searchResults: [{ hits: { hits: [codeHit("caller", 12), codeHit("other", 40)] } }],
    });

    const result = await service(client).references("buildTools");

    expect(result.strategy).toBe("references");
    expect(result.text).toContain("src/a.ts:12");
    expect(result.text).toContain("src/a.ts:40");
    expect(result.hits).toHaveLength(2);
    const body = client.searches[0]?.body as { query?: unknown };
    expect(body.query).toEqual({ match: { code: "buildTools" } });
  });

  test("an outline is ordered by line and carries kind and name", async () => {
    const client = fakeClient({
      mappingsResult: codeMappings,
      searchResults: [{ hits: { hits: [codeHit("second", 40), codeHit("first", 3)] } }],
    });

    const result = await service(client).outline("src/a.ts");

    expect(result.strategy).toBe("outline");
    const rows = result.text.split("\n");
    expect(rows[0]).toContain("src/a.ts:3");
    expect(rows[0]).toContain("first");
    expect(rows[1]).toContain("src/a.ts:40");
    const body = client.searches[0]?.body as { query?: unknown };
    expect(body.query).toEqual({ term: { ax_path: "src/a.ts" } });
  });

  test("zoom returns one declaration's source", async () => {
    const client = fakeClient({
      mappingsResult: codeMappings,
      searchResults: [
        { hits: { hits: [codeHit("buildTools", 7, "export function buildTools(options) {")] } },
      ],
    });

    const result = await service(client).symbol("src/a.ts", "buildTools");

    expect(result.strategy).toBe("symbol");
    expect(result.text).toContain("src/a.ts:7");
    expect(result.text).toContain("export function buildTools");
    const body = client.searches[0]?.body as { query?: { bool?: unknown } };
    expect(body.query?.bool).toEqual({
      must: [{ term: { ax_path: "src/a.ts" } }, { term: { name: "buildTools" } }],
    });
  });

  test("an absolute path inside the project becomes relative", async () => {
    const client = fakeClient({
      mappingsResult: codeMappings,
      searchResults: [{ hits: { hits: [] } }],
    });

    await service(client).outline(join(root, "src", "a.ts"));

    const body = client.searches[0]?.body as { query?: unknown };
    expect(body.query).toEqual({ term: { ax_path: "src/a.ts" } });
  });

  test("a path outside the project is used as given", async () => {
    const client = fakeClient({
      mappingsResult: codeMappings,
      searchResults: [{ hits: { hits: [] } }],
    });

    await service(client).outline("/elsewhere/notes.md");

    const body = client.searches[0]?.body as { query?: unknown };
    expect(body.query).toEqual({ term: { ax_path: "/elsewhere/notes.md" } });
  });

  test("an index without a code field answers nothing", async () => {
    const client = fakeClient({
      mappingsResult: { "xop-p-docs": { body: "semantic_text" } },
    });

    expect((await service(client).references("x")).hits).toEqual([]);
    expect((await service(client).outline("src/a.ts")).hits).toEqual([]);
    expect((await service(client).symbol("src/a.ts", "x")).hits).toEqual([]);
  });

  test("an empty symbol or path makes no request", async () => {
    const client = fakeClient({ mappingsResult: codeMappings });

    await service(client).references("   ");
    await service(client).outline("");
    await service(client).symbol("src/a.ts", "  ");

    expect(client.searches).toEqual([]);
  });
});
