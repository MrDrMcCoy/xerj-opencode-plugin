import { describe, expect, test } from "bun:test";
import { detectDocsFolders, unindexedDocsHint } from "../../src/index/hint.ts";

describe("unindexedDocsHint", () => {
  const present = (folders: string[]) => (folder: string) => folders.includes(folder);

  test("stays quiet when no docs folder exists", () => {
    expect(unindexedDocsHint(present([]), [])).toBeNull();
  });

  test("stays quiet when the docs folder is already configured", () => {
    expect(unindexedDocsHint(present([".agents"]), [".agents"])).toBeNull();
  });

  test("an unrelated configured folder does not cover the docs folder", () => {
    expect(unindexedDocsHint(present([".agents"]), ["docs"])).not.toBeNull();
  });

  test("counts a brain entry as indexed", () => {
    expect(unindexedDocsHint(present([".agents"]), [".agents/"])).toBeNull();
  });

  test("names the folder and both ways to index it", () => {
    const hint = unindexedDocsHint(present([".agents", ".github"]), []);
    expect(hint).toContain(".agents, .github not indexed");
    expect(hint).toContain("index.hidden");
    expect(hint).toContain("index.brain");
  });
});

describe("detectDocsFolders", () => {
  const present = (folders: string[]) => (folder: string) => folders.includes(folder);

  test("returns the docs folders that exist, in a stable order", () => {
    expect(detectDocsFolders(present([".claude", ".agents"]))).toEqual([
      ".agents",
      ".claude",
    ]);
  });

  test("returns nothing when the project has no such folder", () => {
    expect(detectDocsFolders(present([]))).toEqual([]);
  });
});
