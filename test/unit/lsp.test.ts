import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  languageForPath,
} from "../../src/analysis/lsp/pool.ts";
import { pathToUri, uriToPath } from "../../src/analysis/lsp/client.ts";
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
  const dir = await mkdtemp(join(tmpdir(), "xerj-lsp-test-"));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of scratch.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function tools(options: {
  root: string;
  lspEnabled: boolean;
  lsp?: unknown;
  todo?: boolean;
}) {
  return buildTools({
    config: {
      ...DEFAULT_CONFIG,
      analysis: {
        ...DEFAULT_CONFIG.analysis,
        lsp: {
          ...DEFAULT_CONFIG.analysis.lsp,
          enabled: options.lspEnabled,
        },
      },
    },
    projectRoot: options.root,
    getArchive: () => null,
    ledger: {} as never,
    logger,
    getClient: () => null,
    getSearch: () => null,
    getMemory: () => null,
    getSpool: () => null,
    getAnomaly: () => null,
    hub: {} as never,
    treeSitter: {} as never,
    code: {} as never,
    share: {} as never,
    lsp: (options.lsp ?? {}) as never,
    snapshot: async () => ({}) as never,
  });
}

describe("language mapping and URIs", () => {
  test("maps TypeScript extensions to the server and language id", () => {
    expect(languageForPath("src/a.ts")).toEqual({
      server: "typescript",
      languageId: "typescript",
    });
    expect(languageForPath("src/a.tsx")).toEqual({
      server: "typescript",
      languageId: "typescriptreact",
    });
    expect(languageForPath("src/a.py")).toBeNull();
  });

  test("round-trips a file URI", () => {
    const path = "/tmp/a b/c.ts";
    expect(uriToPath(pathToUri(path))).toBe(path);
  });
});

describe("language-server tools", () => {
  test("inspect is always registered and callers need the gate", () => {
    const off = tools({ root: ".", lspEnabled: false }).map((tool) => tool.name);
    expect(off).toContain("inspect");
    expect(off).not.toContain("callers");
    expect(off).not.toContain("impact");

    const on = tools({ root: ".", lspEnabled: true }).map((tool) => tool.name);
    expect(on).toContain("callers");
    expect(on).toContain("impact");
  });

  test("inspect reports TODO markers without a server", async () => {
    const root = await tempDir();
    await writeFile(join(root, "a.ts"), "// TODO: replace this\nexport const a = 1;\n");
    const inspect = tools({ root, lspEnabled: false }).find(
      (tool) => tool.name === "inspect",
    );
    const result = (await inspect?.execute({ path: "a.ts" }, {})) as {
      content: string;
      metadata: { xerj: { todos: number } };
    };

    expect(result.content).toContain("a.ts:1");
    expect(result.content).toContain("TODO");
    expect(result.metadata.xerj.todos).toBe(1);
  });

  test("callers formats a site from the pool", async () => {
    const lsp = {
      callers: async () => [
        { name: "caller", path: "src/b.ts", line: 4, column: 1, callerLine: 6 },
      ],
    };
    const callers = tools({
      root: ".",
      lspEnabled: true,
      lsp,
    }).find((tool) => tool.name === "callers");
    const result = (await callers?.execute({ symbol: "target" }, {})) as {
      content: string;
    };

    expect(result.content).toContain("caller  src/b.ts:4");
    expect(result.content).toContain("call at line 6");
  });
});
