import { describe, expect, test } from "bun:test";
import { exportedNames, unusedExports } from "../../src/analysis/exports.ts";

describe("unused exports", () => {
  test("reads top-level exported names and lines", () => {
    const names = exportedNames(
      "export function a() {}\nexport const b = 1;\nexport interface C {}\n",
    );
    expect(names).toEqual([
      { name: "a", kind: "function", line: 1 },
      { name: "b", kind: "const", line: 2 },
      { name: "C", kind: "interface", line: 3 },
    ]);
  });

  test("reports an export no other file mentions", () => {
    const files = new Map([
      ["src/a.ts", "export function used() {}\nexport function unused() {}\n"],
      ["src/b.ts", 'import { used } from "./a";\nused();\n'],
    ]);
    expect(unusedExports(files)).toEqual([
      { name: "unused", kind: "function", line: 2, path: "src/a.ts" },
    ]);
  });

  test("a second use in the same file keeps an export", () => {
    const files = new Map([
      ["src/a.ts", "export function local() {}\nlocal();\n"],
    ]);
    expect(unusedExports(files)).toEqual([]);
  });
});
