import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPaths, globToRegExp, searchContent } from "../../src/analysis/find.ts";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "xerj-find-"));
  await mkdir(join(root, "src", "deep"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });

  await writeFile(join(root, "src", "a.ts"), "const one = 1; // TODO: first\nexport {};\n");
  await writeFile(join(root, "src", "deep", "b.ts"), "// TODO: second\n");
  await writeFile(join(root, "docs", "x.md"), "TODO: third\n");
  await writeFile(join(root, "node_modules", "pkg", "index.js"), "// TODO: ignored\n");
  await writeFile(join(root, ".env"), "TODO=ignored\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("globToRegExp", () => {
  test("a star stays inside one folder", () => {
    const matcher = globToRegExp("*.ts");
    expect(matcher.test("a.ts")).toBe(true);
    expect(matcher.test("src/a.ts")).toBe(false);
  });

  test("a double star spans folders and may match none", () => {
    const matcher = globToRegExp("src/**/a.ts");
    expect(matcher.test("src/a.ts")).toBe(true);
    expect(matcher.test("src/deep/a.ts")).toBe(true);
  });

  test("a prefix glob matches everything under it", () => {
    const matcher = globToRegExp("src/**");
    expect(matcher.test("src/deep/b.ts")).toBe(true);
    expect(matcher.test("docs/x.md")).toBe(false);
  });
});

describe("findPaths", () => {
  test("lists matches and skips ignored folders and dotfiles", async () => {
    const paths = await findPaths(root, "**/*.ts");

    expect(paths).toEqual(["src/a.ts", "src/deep/b.ts"]);
  });

  test("a limit caps the list", async () => {
    expect(await findPaths(root, "**/*.ts", { limit: 1 })).toHaveLength(1);
  });
});

describe("searchContent", () => {
  test("finds a pattern with line numbers", async () => {
    const result = await searchContent(root, { pattern: "TODO" });

    expect(result.matches.map((match) => `${match.path}:${match.line}`)).toEqual([
      "docs/x.md:1",
      "src/a.ts:1",
      "src/deep/b.ts:1",
    ]);
    expect(result.matches[1]?.text).toContain("TODO: first");
  });

  test("a glob narrows the walk", async () => {
    const result = await searchContent(root, { pattern: "TODO", glob: "src/**" });

    expect(result.matches.map((match) => match.path)).toEqual([
      "src/a.ts",
      "src/deep/b.ts",
    ]);
  });

  test("case is respected unless asked otherwise", async () => {
    expect((await searchContent(root, { pattern: "todo" })).matches).toEqual([]);
    expect(
      (await searchContent(root, { pattern: "todo", ignoreCase: true })).matches.length,
    ).toBe(3);
  });

  test("the limit stops the walk and says so", async () => {
    const result = await searchContent(root, { pattern: "TODO", limit: 1 });

    expect(result.matches).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  test("an invalid pattern throws before reading anything", async () => {
    await expect(searchContent(root, { pattern: "([" })).rejects.toThrow();
  });
});
