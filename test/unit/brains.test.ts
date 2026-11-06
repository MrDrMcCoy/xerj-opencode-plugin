import { describe, expect, test } from "bun:test";
import { BrainGraph, pickNeighbors } from "../../src/search/brains.ts";
import type { XerjClient } from "../../src/node/client.ts";
import type { BrainSpec } from "../../src/paths.ts";

const seed = "seed-id";

function edge(
  dst: string,
  type: string,
  weight = 0.5,
  invalid_at: number | null = null,
): Record<string, unknown> {
  return { src: seed, dst, type, weight, invalid_at };
}

describe("pickNeighbors", () => {
  test("keeps citations ahead of sequence edges", () => {
    const ego = {
      edges: [edge("seq", "sequence", 0.9), edge("cite", "pathcite", 0.6)],
    };

    expect(pickNeighbors(ego, [seed], 2)).toEqual([
      { id: "cite", type: "pathcite" },
      { id: "seq", type: "sequence" },
    ]);
  });

  test("drops same_dir, invalidated, and seed edges", () => {
    const ego = {
      edges: [
        edge("dir", "same_dir"),
        edge("old", "pathcite", 0.9, 123),
        edge(seed, "pathcite"),
        edge("keep", "pathcite"),
      ],
    };

    expect(pickNeighbors(ego, [seed], 2)).toEqual([{ id: "keep", type: "pathcite" }]);
  });

  test("follows an edge into the seed from either direction", () => {
    const ego = {
      edges: [{ src: "other", dst: seed, type: "sequence", weight: 0.8, invalid_at: null }],
    };

    expect(pickNeighbors(ego, [seed], 1)).toEqual([{ id: "other", type: "sequence" }]);
  });

  test("honours the limit and tolerates malformed input", () => {
    const ego = {
      edges: [edge("a", "pathcite"), edge("b", "pathcite"), edge("c", "pathcite")],
    };

    expect(pickNeighbors(ego, [seed], 2)).toHaveLength(2);
    expect(pickNeighbors(null, [seed], 2)).toEqual([]);
    expect(pickNeighbors({ edges: "nope" }, [seed], 2)).toEqual([]);
  });
});

const spec: BrainSpec = {
  name: "brain",
  label: "docs",
  directory: "/project/docs",
  prefix: "xop-brain",
};

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as never;

/** Minimal client: records requests and answers from a fixed table. */
function stubClient(answers: {
  ego?: (path: string) => unknown;
  search?: (body: Record<string, unknown>) => unknown;
}): { client: XerjClient; calls: string[] } {
  const calls: string[] = [];
  const client = {
    get: async (path: string) => {
      calls.push(`get ${path}`);
      return answers.ego ? answers.ego(path) : { edges: [] };
    },
    search: async (_index: string, body: Record<string, unknown>) => {
      calls.push("search");
      return answers.search ? answers.search(body) : null;
    },
  } as unknown as XerjClient;
  return { client, calls };
}

function hit(id: string) {
  return {
    index: "xop-brain-docs",
    id,
    passage: 0,
    path: "a.md",
    line: 1,
    title: "A",
    kind: "text",
    score: 1,
    text: "seed",
  };
}

describe("BrainGraph expansion", () => {
  test("queries each seed separately, because a comma list returns no edges", async () => {
    const { client, calls } = stubClient({});
    const graph = new BrainGraph({ client, brains: [spec], logger });

    await graph.related([hit("one"), hit("two")]);

    const egoCalls = calls.filter((call) => call.startsWith("get "));
    expect(egoCalls).toHaveLength(2);
    expect(egoCalls[0]).toContain("node=one");
    expect(egoCalls[1]).toContain("node=two");
    expect(egoCalls.some((call) => call.includes("%2C"))).toBe(false);
  });

  test("falls back to a section when the cited file record has no body", async () => {
    const { client, calls } = stubClient({
      ego: () => ({
        edges: [{ src: "one", dst: "file", type: "pathcite", weight: 1, invalid_at: null }],
      }),
      search: (body) => {
        // The ids query answers with the whole-file record, which has no body.
        if (JSON.stringify(body).includes('"ids"')) {
          return {
            hits: {
              hits: [
                { _id: "file", _index: "xop-brain-docs", _source: { ax_path: "b.md" } },
              ],
            },
          };
        }
        // The section query answers with the first text-bearing section.
        return {
          hits: {
            hits: [
              {
                _id: "section",
                _index: "xop-brain-docs",
                _source: { ax_path: "b.md", start_line: 1, body: "answer text" },
              },
            ],
          },
        };
      },
    });

    const graph = new BrainGraph({ client, brains: [spec], logger });
    const related = await graph.related([hit("one")]);

    expect(related).toHaveLength(1);
    expect(related[0]?.path).toBe("b.md");
    expect(related[0]?.kind).toBe("via pathcite");
    expect(related[0]?.text).toBe("answer text");
    expect(calls.filter((call) => call === "search")).toHaveLength(2);
  });
});

describe("project-wide brain", () => {
  test("hidden documents are not expanded as graph nodes", async () => {
    const queried: string[] = [];
    const client = {
      get: async (path: string) => {
        queried.push(path);
        return null;
      },
      search: async () => ({ hits: { hits: [] } }),
    } as never;

    const graph = new BrainGraph({
      client,
      brains: [
        {
          name: "proj",
          label: ".",
          directory: "/proj",
          prefix: "xop-proj",
        },
      ],
      logger,
    });

    const related = await graph.related([
      {
        index: "xop-proj-hidden-docs",
        id: "abc",
        passage: 0,
        path: ".agents/plan.md",
        line: 1,
        title: "plan",
        kind: "hidden",
        score: 1,
        text: "hidden",
      },
    ]);

    expect(related).toEqual([]);
    expect(queried).toEqual([]);
  });
});

describe("pathcite-only specs", () => {
  test("sequence edges are skipped but citations still expand", () => {
    const ego = {
      edges: [
        { type: "sequence", src: "seed", dst: "next", invalid_at: null },
        { type: "pathcite", src: "seed", dst: "cited", invalid_at: null },
      ],
    };

    const both = pickNeighbors(ego, ["seed"], 2);
    const citations = pickNeighbors(ego, ["seed"], 2, new Set(["pathcite"]));

    expect(both.map((neighbor) => neighbor.id)).toContain("next");
    expect(citations.map((neighbor) => neighbor.id)).toEqual(["cited"]);
  });
});
