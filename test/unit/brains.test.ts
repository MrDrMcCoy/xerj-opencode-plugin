import { describe, expect, test } from "bun:test";
import { pickNeighbors } from "../../src/search/brains.ts";

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
