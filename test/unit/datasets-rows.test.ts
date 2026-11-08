// One grouping for the plugin status, the MCP status, and the panel. The
// project pattern is broad, so the exclusions and the empty-index filter are
// worth pinning directly.

import { describe, expect, test } from "bun:test";
import { datasetRows } from "../../src/datasets/rows.ts";
import type { IndexSummary } from "../../src/node/client.ts";
import type { BrainSpec } from "../../src/paths.ts";

function index(name: string, docs: number, bytes = docs * 100): IndexSummary {
  return { index: name, docs, bytes, health: "green" };
}

const brains: BrainSpec[] = [
  { name: "answer", label: ".agents", directory: "/p/.agents", prefix: "xop-brain" },
];

function rows(indices: ReadonlyArray<IndexSummary>) {
  return datasetRows(
    indices,
    "xop-p",
    "xop-p-git",
    "xop-web",
    "xop-ext",
    "xop-sys",
    "xop-p-cmd",
    "ns",
    brains,
  );
}

describe("datasetRows", () => {
  test("separates the project corpus from its sub-corpora", () => {
    const found = rows([
      index("xop-p-docs", 10),
      index("xop-p-hidden-docs", 2),
      index("xop-p-prjdocs-docs", 3),
      index("xop-p-archive-docs", 4),
      index("xop-p-git-docs", 5),
      index("xop-p-cmd-docs", 0),
    ]);

    expect(found.map((dataset) => [dataset.name, dataset.docs])).toEqual([
      ["project", 10],
      ["git", 5],
      ["archive", 4],
      ["hidden", 2],
      ["prjdocs", 3],
    ]);
  });

  test("groups the web, external, sysdocs, brain, and memory indices", () => {
    const found = rows([
      index("xop-p-docs", 10),
      index("xop-web-abc-docs", 6),
      index("xop-ext-abc-docs", 7),
      index("xop-sys-abc-docs", 8),
      index(".xerj-memory-ns", 9),
      index("xop-brain-docs", 11),
    ]);

    expect(found.map((dataset) => [dataset.name, dataset.docs])).toEqual([
      ["project", 10],
      ["web", 6],
      ["external", 7],
      ["sysdocs", 8],
      ["brain:answer", 11],
      ["memory", 9],
    ]);
  });

  test("an empty index is not listed as a corpus", () => {
    const found = rows([index("xop-p-docs", 10), index("xop-p-cmd-docs", 0)]);
    expect(found.map((dataset) => dataset.name)).toEqual(["project"]);
  });

  test("an unrelated index is ignored", () => {
    const found = rows([index("autoindex-catalog", 12), index("xop-p-docs", 1)]);
    expect(found.map((dataset) => dataset.name)).toEqual(["project"]);
  });
});
