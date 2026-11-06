import { describe, expect, test } from "bun:test";
import {
  detectDocsFolders,
  unindexedDocsHint,
  withoutBrainFolders,
} from "../../src/index/hint.ts";

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

describe("withoutBrainFolders", () => {
  const roots = [
    { label: ".agents", directory: "/proj/.agents" },
    { label: ".github", directory: "/proj/.github" },
  ];

  test("drops a folder that a brain already indexes", () => {
    const brains = [{ directory: "/proj/.agents" }] as never;
    expect(withoutBrainFolders(roots, brains)).toEqual([
      { label: ".github", directory: "/proj/.github" },
    ]);
  });

  test("keeps every folder when there are no brains", () => {
    expect(withoutBrainFolders(roots, [])).toEqual(roots);
  });

  test("compares resolved paths, so a brain configured with ./ still matches", () => {
    const brains = [{ directory: "/proj/.agents" }] as never;
    expect(withoutBrainFolders(roots, brains).map((root) => root.label)).toEqual([
      ".github",
    ]);
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
