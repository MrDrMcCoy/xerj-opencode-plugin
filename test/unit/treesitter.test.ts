import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TreeSitterService,
  languagesForFiles,
  summarize,
  type ParsedFunction,
} from "../../src/analysis/treesitter.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { buildTools } from "../../src/tools/search.ts";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

const scratch: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "xerj-ts-"));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of scratch.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const grammar = {
  ensure: async () => new Map([["typescript", "/tmp/fake.wasm"]]),
} as never;

function record(overrides: Partial<ParsedFunction> = {}): ParsedFunction {
  return {
    path: "a.ts",
    name: "work",
    kind: "function_declaration",
    startLine: 1,
    endLine: 10,
    nodes: 22,
    hash: "same",
    ...overrides,
  };
}

describe("tree-sitter analysis", () => {
  test("maps file extensions to grammars and deduplicates languages", () => {
    expect(
      languagesForFiles(["a.ts", "b.tsx", "c.js", "d.py", "e.md"]),
    ).toEqual(["javascript", "python", "tsx", "typescript"]);
  });

  test("sorts complexity and groups equal structures", () => {
    const report = summarize(
      [
        record({ path: "a.ts", name: "a", nodes: 20 }),
        record({ path: "b.ts", name: "b", nodes: 80, startLine: 5, endLine: 15 }),
      ],
      { top: 10, minNodes: 10 },
    );

    expect(report.functions).toHaveLength(2);
    expect(report.functions[0]?.nodes).toBe(80);
    expect(report.duplicates).toHaveLength(1);
    expect(report.duplicates[0]?.members).toHaveLength(2);
  });

  test("parses one file through an injected parser", async () => {
    const root = await tempDir();
    await writeFile(join(root, "a.ts"), "function a() { return 1; }\n");
    const service = new TreeSitterService({
      projectRoot: root,
      grammarRoot: root,
      config: { enabled: true, languages: [], maxParseBytes: 1024 },
      logger,
      grammar,
      parseSource: async () => [
        {
          name: "a",
          kind: "function_declaration",
          startLine: 1,
          endLine: 1,
          nodes: 4,
          hash: "hash",
        },
      ],
    });

    const report = await service.report({ path: "a.ts", minNodes: 1 });
    expect(report.files).toBe(1);
    expect(report.functions[0]?.name).toBe("a");
  });

  test("the complexity tool is registered and formats the report", async () => {
    const tools = buildTools({
      config: {
        ...DEFAULT_CONFIG,
        analysis: {
          ...DEFAULT_CONFIG.analysis,
          treeSitter: {
            ...DEFAULT_CONFIG.analysis.treeSitter,
            enabled: true,
          },
        },
      },
      projectRoot: ".",
      getArchive: () => null,
      ledger: {} as never,
      logger,
      getClient: () => null,
      getSearch: () => null,
      getMemory: () => null,
      getSpool: () => null,
      getAnomaly: () => null,
      hub: {} as never,
      treeSitter: {
        report: async () => ({
          files: 1,
          functions: [
            {
              path: "a.ts",
              name: "work",
              kind: "function_declaration",
              startLine: 5,
              endLine: 9,
              nodes: 30,
              lines: 5,
              hash: "h",
            },
          ],
          duplicates: [],
        }),
      } as never,
      snapshot: async () => ({}) as never,
    });

    const tool = tools.find((candidate) => candidate.name === "complexity");
    const result = (await tool?.execute({}, {})) as { content: string };
    expect(result.content).toContain("a.ts:5");
    expect(result.content).toContain("30 nodes");
  });

  test("rejects a disabled gate", async () => {
    const service = new TreeSitterService({
      projectRoot: ".",
      grammarRoot: "/tmp",
      config: { enabled: false, languages: [], maxParseBytes: 1024 },
      logger,
    });
    await expect(service.report({})).rejects.toThrow(
      "analysis.treeSitter.enabled",
    );
  });
});
