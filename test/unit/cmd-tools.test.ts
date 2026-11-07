import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CmdService } from "../../src/cmd/service.ts";
import type { CmdEntry, CmdRead, CmdResult } from "../../src/cmd/store.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { cmdTools } from "../../src/tools/cmd.ts";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

const entry: CmdEntry = {
  stem: "20261106T192233123Z",
  at: Date.now() - 60_000,
  command: "npm test",
  exitCode: 1,
  durationMs: 12_000,
  bytes: 48213,
  lines: 1200,
  truncated: false,
  binary: false,
  timedOut: false,
  source: "host",
  windows: [1, 201],
  indexedBytes: 48213,
};

function service(overrides: Partial<CmdService> = {}): CmdService {
  const base = {
    run: async (): Promise<CmdResult> => ({
      stem: entry.stem,
      exitCode: 0,
      durationMs: 1200,
      bytes: 40,
      lines: 3,
      truncated: false,
      binary: false,
      timedOut: false,
    }),
    list: (limit: number) => [entry].slice(0, limit),
    show: async (): Promise<CmdRead> => ({
      lines: ["alpha", "beta", "gamma"],
      total: 3,
      from: 1,
    }),
    search: async () => [
      {
        stem: entry.stem,
        kind: "out" as const,
        line: 42,
        text: "FAIL src/a.test.ts",
        command: "npm test",
        exitCode: 1,
      },
    ],
    ingest: async () => ({ ...entry, stem: "20261106T200000000Z" }),
    entry: () => entry,
  };
  return { ...base, ...overrides } as unknown as CmdService;
}

function tool(name: "run" | "out", getCmd: () => CmdService | null): {
  execute: (input: unknown, context: unknown) => Promise<{ content: string }>;
} {
  const tools = cmdTools({ config: DEFAULT_CONFIG, getCmd, logger: logger as never });
  const found = tools.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found as never;
}

describe("xerj_run", () => {
  test("returns a receipt, never the output", async () => {
    const result = await tool("run", () => service()).execute(
      { command: "npm test" },
      {},
    );

    expect(result.content).toContain(`stem ${entry.stem}`);
    expect(result.content).toContain("exit 0");
    expect(result.content).toContain("3 lines");
    expect(result.content).not.toContain("alpha");
  });

  test("reports a missing service", async () => {
    const result = await tool("run", () => null).execute({ command: "ls" }, {});
    expect(result.content).toContain("not available");
  });
});

describe("xerj_out", () => {
  test("lists recent commands with their exit codes", async () => {
    const result = await tool("out", () => service()).execute(
      { action: "list" },
      {},
    );

    expect(result.content).toContain(entry.stem);
    expect(result.content).toContain("exit 1");
    expect(result.content).toContain("npm test");
  });

  test("shows a numbered range with the citation", async () => {
    const result = await tool("out", () => service()).execute(
      { action: "show", stem: entry.stem, start: 1, end: 3 },
      {},
    );

    expect(result.content).toContain(`cmd/${entry.stem}-out.txt:1-3 of 3`);
    expect(result.content).toContain("1| alpha");
    expect(result.content).toContain("3| gamma");
  });

  test("searches with stem:line citations", async () => {
    const result = await tool("out", () => service()).execute(
      { action: "search", query: "FAIL" },
      {},
    );

    expect(result.content).toContain(`cmd/${entry.stem}-out.txt:42`);
    expect(result.content).toContain("FAIL src/a.test.ts");
  });

  test("ingests a file and names its stem", async () => {
    const result = await tool("out", () => service()).execute(
      { action: "ingest", path: join(tmpdir(), "build.log") },
      {},
    );

    expect(result.content).toContain("ingested");
    expect(result.content).toContain("20261106T200000000Z");
  });

  test("asks for an action when one is missing", async () => {
    const result = await tool("out", () => service()).execute({}, {});
    expect(result.content).toContain("action=list");
  });
});
