// Generated-file demotion. The motivating case is a rare-term query ranking
// `package-lock.json` above the source file that holds the exact match.
import { describe, expect, test } from "bun:test";
import {
  contentTerms,
  demoteGenerated,
  dropGenerated,
  dropUncovered,
  isGeneratedPath,
} from "../../src/search/rank.ts";
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

  test("treats license boilerplate as generated", () => {
    expect(isGeneratedPath("LICENSE")).toBe(true);
    expect(isGeneratedPath("docs/LICENSE.md")).toBe(true);
    expect(isGeneratedPath("COPYING")).toBe(true);
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

describe("dropGenerated", () => {
  test("removes an unnamed lockfile from the injected block", () => {
    const hits = [hit("src/search/rank.ts", 0.5), hit("package-lock.json", 0.4)];
    const kept = dropGenerated(hits, "where is ranking applied");
    expect(kept.map((entry) => entry.path)).toEqual(["src/search/rank.ts"]);
  });

  test("keeps a lockfile the query names", () => {
    expect(dropGenerated([hit("package-lock.json", 0.4)], "package-lock.json entries")).toHaveLength(1);
  });

  test("keeps authored files untouched", () => {
    expect(dropGenerated([hit("src/index.ts", 0.9)], "plugin entry")).toHaveLength(1);
  });
});

describe("contentTerms", () => {
  test("drops function words and conversational filler", () => {
    expect(contentTerms("push to github, i will handle npm")).toEqual([
      "push",
      "github",
      "handle",
      "npm",
    ]);
    expect(contentTerms("please continue with that")).toEqual([]);
  });

  test("keeps identifiers and dedupes", () => {
    expect(contentTerms("where is ensureProjectState called? ensureProjectState")).toEqual([
      "ensureprojectstate",
      "called",
    ]);
  });
});

describe("dropUncovered", () => {
  function passage(path: string, text: string): ParsedHit {
    return { ...hit(path, 1), text };
  }

  test("drops a passage that shares only incidental terms with the prompt", () => {
    const lock = passage("bun.lock", "npm registry https://github.com/foo/bar");
    const kept = dropUncovered([lock], "push to github, i will handle npm");
    expect(kept).toEqual([]);
  });

  test("keeps a passage that covers most of the prompt's terms", () => {
    const code = passage(
      "src/lifecycle.ts",
      "// Stops the project node when the last session closes.",
    );
    const kept = dropUncovered([code], "how does the plugin decide when to stop the project node");
    expect(kept).toHaveLength(1);
  });

  test("counts the path as evidence", () => {
    const code = passage("src/index/watcher.ts", "const timer = setInterval(run, periodicMs);");
    expect(dropUncovered([code], "watcher periodic timer")).toHaveLength(1);
  });

  test("keeps nothing when the prompt has no content terms", () => {
    expect(dropUncovered([passage("a.md", "yes do it")], "yes, do it")).toEqual([]);
  });
});
