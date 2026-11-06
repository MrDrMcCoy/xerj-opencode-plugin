// Generated-file demotion. The motivating case is a rare-term query ranking
// `package-lock.json` above the source file that holds the exact match.
import { describe, expect, test } from "bun:test";
import {
  contentTerms,
  demoteGenerated,
  dropGenerated,
  dropDuplicateLocations,
  dropUncovered,
  isChroniclePath,
  isGeneratedPath,
  isTestPath,
  limitPerFile,
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

  test("an allowed hit passes on one shared word", () => {
    // "folder" is "directory" in the code; the semantic leg supplies the match.
    const code = passage("src/index/brain.ts", "// Walks the brain directory and writes edges.");
    const query = "how is a brain graph built from a folder";
    expect(dropUncovered([code], query)).toEqual([]);
    expect(dropUncovered([code], query, new Set([code.id]))).toHaveLength(1);
  });

  test("an allowed hit with no shared word is still dropped", () => {
    const noise = passage("bun.lock", "registry tarball integrity sha512");
    expect(dropUncovered([noise], "continue", new Set([noise.id]))).toEqual([]);
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

describe("limitPerFile", () => {
  test("keeps the first hits of a file and drops its extras", () => {
    const hits = [
      hit("README.md", 3),
      hit("README.md", 2),
      hit("README.md", 1),
      hit("src/config.ts", 1),
      hit(null, 1),
      hit(null, 1),
    ];

    expect(limitPerFile(hits, 2).map((entry) => entry.score)).toEqual([3, 2, 1, 1, 1]);
  });

  test("a cap of zero means no cap", () => {
    const hits = [hit("README.md", 3), hit("README.md", 2)];
    expect(limitPerFile(hits, 0)).toHaveLength(2);
  });

  test("a file that appears once is untouched", () => {
    const single = [hit("a.ts", 1)];
    expect(limitPerFile(single, 1)).toEqual(single);
  });
});

describe("isChroniclePath", () => {
  test("recognizes changelogs and status logs", () => {
    expect(isChroniclePath("CHANGELOG.md")).toBe(true);
    expect(isChroniclePath("docs/changelog-2026.md")).toBe(true);
    expect(isChroniclePath(".agents/status.md")).toBe(true);
    expect(isChroniclePath("notes/journal.md")).toBe(true);
    expect(isChroniclePath("HISTORY.md")).toBe(true);
  });

  test("leaves ordinary documents alone", () => {
    expect(isChroniclePath("README.md")).toBe(false);
    expect(isChroniclePath("src/config.ts")).toBe(false);
    expect(isChroniclePath(".agents/plan.md")).toBe(false);
  });

  test("a chronicle is demoted like a generated file", () => {
    const hits = [hit(".agents/status.md", 10), hit("src/config.ts", 9)];
    expect(demoteGenerated(hits, "how is the node stopped")[0]?.path).toBe("src/config.ts");
  });
});
