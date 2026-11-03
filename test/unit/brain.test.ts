import { describe, expect, test } from "bun:test";
import { parseBrainRun } from "../../src/index/brain.ts";
import { brainSpecs } from "../../src/paths.ts";

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
