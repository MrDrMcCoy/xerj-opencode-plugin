import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainIndexer, parseBrainRun, type BrainRun } from "../../src/index/brain.ts";
import { brainSpecs } from "../../src/paths.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import type { Logger } from "../../src/log.ts";
import type { BrainSpec } from "../../src/paths.ts";

describe("parseBrainRun", () => {
  test("reads totals and edge counts from the last JSON line", () => {
    const document = JSON.stringify({
      records_total: 28,
      records_submitted_this_run: 4,
      graph: { edges_written: 33 },
    });

    expect(parseBrainRun(`starting\n${document}\n`)).toEqual({ docs: 28, edges: 33 });
  });

  test("falls back to submitted records without a total", () => {
    const document = JSON.stringify({ records_submitted_this_run: 4 });
    expect(parseBrainRun(document)).toEqual({ docs: 4, edges: 0 });
  });

  test("returns zeros for missing or malformed output", () => {
    expect(parseBrainRun("")).toEqual({ docs: 0, edges: 0 });
    expect(parseBrainRun("{not json}")).toEqual({ docs: 0, edges: 0 });
  });
});

describe("brainSpecs", () => {
  test("derives a graph name and prefix from the folder", () => {
    const [agents] = brainSpecs("/repo", [".agents"]);

    expect(agents?.name).toMatch(/^agents-[0-9a-f]{4}$/);
    expect(agents?.directory).toBe("/repo/.agents");
    expect(agents?.prefix).toMatch(/^xop-agents-[0-9a-f]{6}$/);
  });

  test("ignores the same folder configured twice", () => {
    expect(brainSpecs("/repo", ["docs", "docs"])).toHaveLength(1);
  });

  test("keeps two folders with the same basename apart", () => {
    const [first, second] = brainSpecs("/repo", ["a/docs", "b/docs"]);

    expect(first?.name).toMatch(/^docs-[0-9a-f]{4}$/);
    expect(second?.name).toMatch(/^docs-[0-9a-f]{4}$/);
    expect(first?.name).not.toBe(second?.name);
    expect(first?.prefix).not.toBe(second?.prefix);
  });

  test("accepts an absolute folder", () => {
    const [notes] = brainSpecs("/repo", ["/elsewhere/notes"]);
    expect(notes?.directory).toBe("/elsewhere/notes");
    expect(notes?.name).toMatch(/^notes-[0-9a-f]{4}$/);
  });
});

const quietLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

let root: string;
const realFetch = globalThis.fetch;

function stubFetch(behavior?: (url: string) => unknown | Promise<unknown>): void {
  globalThis.fetch = (async (url: string | URL) => {
    void url;
    const body = behavior
      ? await behavior(String(url))
      : { nodes: { total: 40 }, edges: { total: 99 } };
    if (body === null) throw new TypeError("down");
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "xerj-brain-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(
    join(root, "run-doc"),
    JSON.stringify({ records_total: 28, graph: { edges_written: 33 } }),
  );
  const runDoc = join(root, "run-doc");
  await writeFile(
    join(root, "echo-run"),
    [
      "#!/usr/bin/env bun",
      `console.log(await Bun.file(${JSON.stringify(runDoc)}).text());`,
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "fail-run"),
    ["#!/usr/bin/env bun", "console.error('autoindex exploded');", "process.exit(1);", ""].join("\n"),
  );
  await writeFile(
    join(root, "junk-run"),
    [
      "#!/usr/bin/env bun",
      `console.log(await Bun.file(${JSON.stringify(runDoc)}).text());`,
      "process.exit(3);",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "slow-run"),
    ["#!/usr/bin/env bun", "await Bun.sleep(400);", ""].join("\n"),
  );
  for (const name of ["echo-run", "fail-run", "junk-run", "slow-run"]) {
    await chmod(join(root, name), 0o755);
  }
  stubFetch();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

function spec(name: string, directory = join(root, "docs")): BrainSpec {
  return { name, prefix: `xop-${name}-123456`, directory, label: name };
}

function indexer(
  specs: BrainSpec[],
  overrides: { binary?: string; onRun?: () => void; onChange?: () => void } = {},
): { instance: BrainIndexer; runs: BrainRun[] } {
  const runs: BrainRun[] = [];
  const instance = new BrainIndexer({
    binaryPath: overrides.binary ?? join(root, "echo-run"),
    nodeUrl: "http://127.0.0.1:9200",
    stateRoot: root,
    config: DEFAULT_CONFIG,
    specs,
    logger: quietLogger,
    onRun: overrides.onRun,
    onChange: () => {
      runs.length = 0;
      runs.push(...instance.snapshot());
      overrides.onChange?.();
    },
  });
  return { instance, runs };
}

describe("BrainIndexer", () => {
  test("reports zeros for brains that have not run", () => {
    const { instance } = indexer([spec("docs")]);
    expect(instance.snapshot()).toEqual([
      { name: "docs", prefix: "xop-docs-123456", at: 0, docs: 0, edges: 0, error: null },
    ]);
  });

  test("takes live edges from the graph overview", async () => {
    const { instance, runs } = indexer([spec("docs")]);
    await instance.runAll();
    expect(runs[0]!).toMatchObject({ name: "docs", docs: 28, edges: 99, error: null });
    expect(runs[0]!.at).toBeGreaterThan(0);
  });

  test("falls back to the run document when the overview fails", async () => {
    stubFetch(() => null);
    const { instance, runs } = indexer([spec("docs")]);
    await instance.runAll();
    expect(runs[0]!).toMatchObject({ docs: 28, edges: 33, error: null });
    stubFetch();
  });

  test("counts a completed-with-junk run as success", async () => {
    stubFetch(() => null);
    const { instance, runs } = indexer([spec("docs")], { binary: join(root, "junk-run") });
    await instance.runAll();
    expect(runs[0]!).toMatchObject({ docs: 28, edges: 33, error: null });
    stubFetch();
  });

  test("records a failure for a dying autoindex", async () => {
    stubFetch(() => null);
    const { instance, runs } = indexer([spec("docs")], { binary: join(root, "fail-run") });
    await instance.runAll();
    expect(runs[0]!).toMatchObject({ docs: 0, edges: 0 });
    expect(runs[0]!.error).toContain("autoindex exploded");
    stubFetch();
  });

  test("records a failure for a missing directory", async () => {
    stubFetch(() => null);
    const { instance, runs } = indexer([spec("docs", join(root, "missing"))]);
    await instance.runAll();
    expect(runs[0]!.error).toContain("is not a directory");
    stubFetch();
  });

  test("ignores a concurrent runAll", async () => {
    const { instance } = indexer([spec("docs")], { binary: join(root, "slow-run") });
    const first = instance.runAll();
    await instance.runAll();
    await first;
    const snapshot = await instance.snapshot();
    expect(snapshot[0]?.at).toBeGreaterThan(0);
  });

  test("notifies onRun after each successful spec", async () => {
    let runs = 0;
    const { instance } = indexer([spec("docs")], {
      onRun: () => {
        runs += 1;
      },
    });
    await instance.runAll();
    expect(runs).toBe(1);
  });
});
