import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAstOutput, searchAst } from "../../src/analysis/ast.ts";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "xerj-ast-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

/** One ast-grep JSON record, in the shape the tool prints. */
function record(file: string, line: number, text: string): string {
  return JSON.stringify({
    file,
    text,
    range: { start: { line, column: 0 }, end: { line, column: 4 } },
  });
}

describe("parseAstOutput", () => {
  test("reads file, zero-based line, and first text line", () => {
    const matches = parseAstOutput(`${record("./src/a.ts", 4, "console.log(x)\nmore")}\n`);

    expect(matches).toEqual([{ path: "src/a.ts", line: 5, text: "console.log(x)" }]);
  });

  test("skips a malformed line instead of failing the run", () => {
    const matches = parseAstOutput(`not json\n${record("b.ts", 0, "x")}\n{"file":`);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.path).toBe("b.ts");
  });

  test("honours the limit", () => {
    const raw = Array.from({ length: 5 }, (_, index) => record(`f${index}.ts`, 0, "x")).join("\n");

    expect(parseAstOutput(raw, 2)).toHaveLength(2);
  });

  test("a record without a file is ignored", () => {
    expect(parseAstOutput(JSON.stringify({ text: "x", range: { start: { line: 0 } } }))).toEqual([]);
  });
});

describe("searchAst", () => {
  test("reports absence when the binary is missing", async () => {
    const result = await searchAst({
      root,
      pattern: "console.log($A)",
      lang: "ts",
      probe: async () => false,
    });

    expect(result.available).toBe(false);
    expect(result.matches).toEqual([]);
  });

  test("passes the pattern, language, and glob to ast-grep", async () => {
    const calls: string[][] = [];
    const result = await searchAst({
      root,
      pattern: "console.log($A)",
      lang: "ts",
      glob: "src/**",
      probe: async () => true,
      run: async (args) => {
        calls.push([...args]);
        return record("src/a.ts", 1, "console.log(1)");
      },
    });

    expect(result.available).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(calls[0]).toEqual([
      "run",
      "--pattern",
      "console.log($A)",
      "--lang",
      "ts",
      "--json=stream",
      "--glob",
      "src/**",
    ]);
  });

  test("a failed run reports available with no matches", async () => {
    const result = await searchAst({
      root,
      pattern: "x()",
      lang: "ts",
      probe: async () => true,
      run: async () => null,
    });

    expect(result).toEqual({ available: true, matches: [] });
  });
});
