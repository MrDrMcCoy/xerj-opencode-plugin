// Generated-file demotion. The motivating case is a rare-term query ranking
// `package-lock.json` above the source file that holds the exact match.
import { describe, expect, test } from "bun:test";
import {
  contentTerms,
  demoteGenerated,
  dropGenerated,
  dropDuplicateLocations,
  dropUncovered,
  isGeneratedPath,
  isTestPath,
  preferSources,
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

  test("a word form counts as the prompt's term", () => {
    // Prompts ask "how are ids generated"; code says "generate".
    const code = passage("src/memory/store.ts", "export function generateId(text: string) {");
    expect(dropUncovered([code], "how are memory ids generated")).toHaveLength(1);
  });

  test("an inflected verb counts as the prompt's term", () => {
    // Prompts ask "which names are refused"; code says "refuse".
    const code = passage("src/remote/spool.ts", "// Refuse credential files before reading them.");
    expect(dropUncovered([code], "which credential names are refused before reading")).toHaveLength(1);
  });

  test("a short word does not match by its stem", () => {
    const code = passage("a.md", "the cat sat");
    expect(dropUncovered([code], "cats" )).toEqual([]);
  });
});

describe("isTestPath", () => {
  test("recognizes test directories and suffixes", () => {
    expect(isTestPath("test/unit/rank.test.ts")).toBe(true);
    expect(isTestPath("src/__tests__/a.js")).toBe(true);
    expect(isTestPath("pkg/server_test.go")).toBe(true);
    expect(isTestPath("app/a.spec.tsx")).toBe(true);
    expect(isTestPath("src/search/rank.ts")).toBe(false);
    expect(isTestPath("docs/testing.md")).toBe(false);
  });
});

describe("preferSources", () => {
  test("moves tests after sources, keeping order within each group", () => {
    const hits = [hit("test/unit/a.test.ts", 3), hit("src/a.ts", 2), hit("README.md", 1)];
    expect(preferSources(hits, "how does a work").map((entry) => entry.path)).toEqual([
      "src/a.ts",
      "README.md",
      "test/unit/a.test.ts",
    ]);
  });

  test("keeps tests first when the query asks about tests", () => {
    const hits = [hit("test/unit/a.test.ts", 3), hit("src/a.ts", 2)];
    expect(preferSources(hits, "which test covers a").map((entry) => entry.path)).toEqual([
      "test/unit/a.test.ts",
      "src/a.ts",
    ]);
  });
});

describe("dropDuplicateLocations", () => {
  test("keeps the first hit for each path and line", () => {
    const at = (path: string, line: number | null, id: string): ParsedHit => ({
      ...hit(path, 1),
      id,
      line,
    });
    const kept = dropDuplicateLocations([
      at("src/a.ts", 3, "file"),
      at("src/a.ts", 3, "section"),
      at("src/a.ts", 9, "other"),
      at("src/b.ts", null, "x"),
      at("src/b.ts", null, "y"),
    ]);
    expect(kept.map((entry) => entry.id)).toEqual(["file", "other", "x", "y"]);
  });
});
