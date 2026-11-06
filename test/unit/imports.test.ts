import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCycles, resolveSpecifier, scanImports, specifiersIn } from "../../src/analysis/imports.ts";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "xerj-imports-"));
  await mkdir(join(root, "src", "lib"), { recursive: true });
  await mkdir(join(root, "pkg"), { recursive: true });

  await writeFile(
    join(root, "src", "a.ts"),
    'import { b } from "./b";\nimport type { C } from "./lib/c.js";\nimport fs from "node:fs";\n',
  );
  await writeFile(join(root, "src", "b.ts"), 'import { a } from "./a";\nconst x = require("./lib/c");\n');
  await writeFile(join(root, "src", "lib", "c.ts"), "export const c = 1;\n");
  await writeFile(join(root, "pkg", "mod.py"), "from pkg.other import thing\nimport os\n");
  await writeFile(join(root, "pkg", "other.py"), "thing = 1\n");
  await writeFile(
    join(root, "main.go"),
    'package main\n\nimport (\n\t"fmt"\n\t"example.com/project/pkg"\n)\n',
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("specifiersIn", () => {
  test("reads from, require, and dynamic import", () => {
    const found = specifiersIn(
      "src/a.ts",
      'import x from "./x"; const y = require("./y"); const z = import("./z");',
    );

    expect(found).toEqual(["./x", "./y", "./z"]);
  });

  test("reads python imports as module paths", () => {
    expect(specifiersIn("m.py", "from pkg.other import thing\nimport os, sys\n")).toEqual([
      "py:pkg.other",
      "py:os",
      "py:sys",
    ]);
  });

  test("reads go and rust imports", () => {
    expect(specifiersIn("main.go", 'import (\n\t"example.com/p/pkg"\n)\n')).toEqual([
      "go:example.com/p/pkg",
    ]);
    expect(specifiersIn("src/x.rs", "use crate::lib::thing::Thing;\n")).toEqual([
      "rs:crate::lib::thing::Thing",
    ]);
  });
});

describe("resolveSpecifier", () => {
  const files = new Set(["src/a.ts", "src/b.ts", "src/lib/c.ts", "pkg/other.py", "pkg/mod.py", "main.go"]);

  test("resolves a relative specifier and its extension", () => {
    expect(resolveSpecifier("src/a.ts", "./b", files)).toBe("src/b.ts");
    expect(resolveSpecifier("src/a.ts", "./lib/c.js", files)).toBe("src/lib/c.ts");
  });

  test("resolves a python module", () => {
    expect(resolveSpecifier("pkg/mod.py", "py:pkg.other", files)).toBe("pkg/other.py");
  });

  test("leaves a package name unresolved", () => {
    expect(resolveSpecifier("src/a.ts", "node:fs", files)).toBeNull();
    expect(resolveSpecifier("src/a.ts", "react", files)).toBeNull();
  });

  test("resolves a rust module path", () => {
    expect(resolveSpecifier("src/x.rs", "rs:crate::lib::thing::Thing", files)).toBeNull();
  });
});

describe("scanImports", () => {
  test("counts files, edges and unresolved specifiers", async () => {
    const scan = await scanImports(root);

    expect(scan.files).toBeGreaterThanOrEqual(6);
    const pairs = scan.edges.map((edge) => `${edge.from}>${edge.to}`);
    expect(pairs).toContain("src/a.ts>src/b.ts");
    expect(pairs).toContain("src/a.ts>src/lib/c.ts");
    expect(pairs).toContain("src/b.ts>src/lib/c.ts");
    expect(pairs).toContain("pkg/mod.py>pkg/other.py");
    // `node:fs`, `os`, `fmt` and the module-prefixed Go path are not files.
    expect(scan.unresolved).toBeGreaterThan(0);
  });

  test("a cycle is found and rotated to its smallest member", async () => {
    const scan = await scanImports(root);
    const cycles = findCycles(scan.edges);

    expect(cycles.length).toBeGreaterThanOrEqual(1);
    expect(cycles[0]).toEqual(["src/a.ts", "src/b.ts", "src/a.ts"]);
  });

  test("a graph without cycles reports none", () => {
    expect(
      findCycles([
        { from: "a", to: "b", specifier: "./b" },
        { from: "b", to: "c", specifier: "./c" },
      ]),
    ).toEqual([]);
  });
});
