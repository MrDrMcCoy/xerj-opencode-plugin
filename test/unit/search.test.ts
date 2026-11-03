import { describe, expect, test } from "bun:test";
import {
  dropShadowedWholeFiles,
  fuse,
  newlinesBeforeMatch,
  projectDocumentPath,
  type ParsedHit,
  type SearchHit,
} from "../../src/search/service.ts";
import type { BrainSpec } from "../../src/paths.ts";

function hit(id: string, score = 1, passage = 0): ParsedHit {
  return {
    index: "idx",
    id,
    passage,
    path: `${id}.ts`,
    line: 1,
    title: null,
    kind: null,
    score,
    text: `text ${id}`,
    startLine: 1,
    startOffset: 0,
  };
}

function plain(index: string, path: string): SearchHit {
  return {
    index,
    id: path,
    passage: 0,
    path,
    line: 1,
    title: null,
    kind: null,
    score: 1,
    text: "text",
  };
}

describe("projectDocumentPath", () => {
  test("prefixes a brain-relative path", () => {
    expect(projectDocumentPath("/repo", "/repo/.agents", "plan.md")).toBe(
      ".agents/plan.md",
    );
  });

  test("leaves an already-relative or root path alone", () => {
    expect(projectDocumentPath("/repo", "/repo", "src/a.ts")).toBe("src/a.ts");
    expect(projectDocumentPath("/repo", "/repo/.agents", ".agents/plan.md")).toBe(
      ".agents/plan.md",
    );
  });
});

describe("dropShadowedWholeFiles", () => {
  const spec: BrainSpec = {
    name: "agents-abcd",
    label: ".agents",
    directory: "/repo/.agents",
    prefix: "xop-agents-abcd",
  };

  test("drops a hidden whole-file hit in favour of brain sections", () => {
    const hidden = plain("xop-demo-hidden-docs", ".agents/plan.md");
    const section = plain("xop-agents-abcd-docs", ".agents/plan.md");
    const other = plain("xop-demo-docs", "src/a.ts");

    const kept = dropShadowedWholeFiles(
      [hidden, section, other],
      "xop-demo-hidden-docs",
      [spec],
    );

    expect(kept).toEqual([section, other]);
  });

  test("keeps hidden documents no brain covers", () => {
    const hidden = plain("xop-demo-hidden-docs", ".agents/goals.md");
    expect(dropShadowedWholeFiles([hidden], "xop-demo-hidden-docs", [spec])).toEqual([
      hidden,
    ]);
  });

  test("does nothing without a hidden index", () => {
    const hidden = plain("xop-demo-hidden-docs", ".agents/plan.md");
    expect(dropShadowedWholeFiles([hidden], null, [spec])).toEqual([hidden]);
  });
});

describe("fuse", () => {
  test("rewards agreement between legs", () => {
    const lexical = [hit("a"), hit("b"), hit("c")];
    const semantic = [hit("b"), hit("d"), hit("a")];
    const fused = fuse([lexical, semantic], 4);

    // a: ranks 1 and 3; b: ranks 2 and 1. b wins on the better pair.
    expect(fused.map((entry) => entry.id)).toEqual(["b", "a", "d", "c"]);
  });

  test("keeps single-leg hits", () => {
    const fused = fuse([[hit("a")], [hit("b")]], 5);
    expect(fused.map((entry) => entry.id).sort()).toEqual(["a", "b"]);
  });

  test("deduplicates the same document and passage", () => {
    const fused = fuse([[hit("a")], [hit("a")]], 5);
    expect(fused).toHaveLength(1);
    expect(fused[0]?.score).toBeCloseTo(2 / 61, 5);
  });

  test("keeps different passages of one document apart", () => {
    const fused = fuse([[hit("a", 1, 0)], [hit("a", 1, 1)]], 5);
    expect(fused).toHaveLength(2);
  });

  test("cuts to k", () => {
    const fused = fuse([[hit("a"), hit("b"), hit("c")]], 2);
    expect(fused).toHaveLength(2);
  });
});

describe("newlinesBeforeMatch", () => {
  test("counts newlines to the first matching term", () => {
    expect(newlinesBeforeMatch("first line\nsecond line\nthird needle here", "needle")).toBe(2);
  });

  test("returns zero when the term is on the first line", () => {
    expect(newlinesBeforeMatch("needle first\nmore", "needle")).toBe(0);
  });

  test("returns null without a usable term", () => {
    expect(newlinesBeforeMatch("needle", "a b")).toBeNull();
  });
});
