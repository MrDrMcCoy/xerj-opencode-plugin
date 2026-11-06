import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { corpusLayout, autoindexArgs } from "../../src/index/corpus.ts";
import { projectBrainName } from "../../src/paths.ts";

const layout = corpusLayout(
  "/proj",
  "xop-proj-12345678",
  "/proj/.xerj/nodes/xop-proj-12345678/data",
);

function args(
  index: Partial<typeof DEFAULT_CONFIG.index> = {},
  watch = false,
): string[] {
  const config = {
    ...DEFAULT_CONFIG,
    index: { ...DEFAULT_CONFIG.index, ...index },
  };
  return [
    ...autoindexArgs({
      layout,
      nodeUrl: "http://127.0.0.1:9200",
      config,
      watch,
    }),
  ];
}

describe("project graph mode", () => {
  test("a graph project pass names the brain and drops --no-graph", () => {
    const built = args({ graph: true });

    expect(built).toContain("--brain");
    expect(built).not.toContain("--no-graph");
    expect(built[built.indexOf("--brain") + 1]).toBe(projectBrainName("/proj"));
  });

  test("a graph project pass never asks the engine to watch", () => {
    const built = args({ graph: true }, true);

    expect(built).not.toContain("--watch");
    expect(built).not.toContain("--debounce");
  });

  test("turning graph mode off restores a watcher pass", () => {
    const built = args({ graph: false }, true);

    expect(built).toContain("--no-graph");
    expect(built).toContain("--watch");
    expect(built).not.toContain("--brain");
  });

  test("the brain name is stable and project-scoped", () => {
    expect(projectBrainName("/proj")).toBe(projectBrainName("/proj"));
    expect(projectBrainName("/proj")).not.toBe(projectBrainName("/other"));
    expect(projectBrainName("/proj")).not.toMatch(/\//);
  });
});
