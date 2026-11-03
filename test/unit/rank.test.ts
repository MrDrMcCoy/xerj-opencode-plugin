// Generated-file demotion. The motivating case is a rare-term query ranking
// `package-lock.json` above the source file that holds the exact match.
import { describe, expect, test } from "bun:test";
import { demoteGenerated, isGeneratedPath } from "../../src/search/rank.ts";
import type { ParsedHit } from "../../src/search/service.ts";

function hit(path: string | null, score: number): ParsedHit {
  return {
    index: "xop-demo-docs",
    id: path ?? "none",
    passage: 0,
    path,
    line: null,
    title: path,
    kind: "doc",
    score,
    text: "",
    startLine: null,
    startOffset: 0,
  };
}

describe("isGeneratedPath", () => {
  test("recognizes lockfiles", () => {
    expect(isGeneratedPath("package-lock.json")).toBe(true);
    expect(isGeneratedPath("app/yarn.lock")).toBe(true);
    expect(isGeneratedPath("Cargo.lock")).toBe(true);
    expect(isGeneratedPath("go.sum")).toBe(true);
  });

  test("recognizes minified and build output", () => {
    expect(isGeneratedPath("public/app.min.js")).toBe(true);
    expect(isGeneratedPath("src/a.ts.map")).toBe(true);
    expect(isGeneratedPath("dist/index.js")).toBe(true);
    expect(isGeneratedPath("vendor/lib.go")).toBe(true);
  });

  test("leaves authored files alone", () => {
    expect(isGeneratedPath("src/search/service.ts")).toBe(false);
    expect(isGeneratedPath(".agents/plan.md")).toBe(false);
    expect(isGeneratedPath("docs/lockfile.md")).toBe(false);
  });
});

describe("demoteGenerated", () => {
  test("moves a lockfile below an authored match", () => {
    const ranked = demoteGenerated(
      [hit("package-lock.json", 0.03), hit("src/search/service.ts", 0.02)],
      "reciprocal rank fusion",
    );

    expect(ranked[0]?.path).toBe("src/search/service.ts");
    expect(ranked[1]?.path).toBe("package-lock.json");
  });

  test("keeps the lockfile on top when the query names it", () => {
    const ranked = demoteGenerated(
      [hit("package-lock.json", 0.03), hit("src/search/service.ts", 0.02)],
      "package-lock.json dependency",
    );

    expect(ranked[0]?.path).toBe("package-lock.json");
  });

  test("leaves authored hits in their original order", () => {
    const ranked = demoteGenerated(
      [hit("a.md", 0.03), hit("b.md", 0.02)],
      "anything",
    );

    expect(ranked.map((entry) => entry.path)).toEqual(["a.md", "b.md"]);
  });

  test("keeps hits with no path", () => {
    const ranked = demoteGenerated([hit(null, 0.01)], "anything");

    expect(ranked).toHaveLength(1);
  });
});
