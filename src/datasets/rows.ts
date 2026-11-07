// Groups the node's index listing into the datasets the status and panel
// show. The plugin and the standalone MCP host both use it, so a new corpus
// lands in one place instead of two.

import type { IndexSummary } from "../node/client.ts";
import type { BrainSpec } from "../paths.ts";
import type { DatasetStatus } from "../rpc.ts";

export function datasetRows(
  indices: ReadonlyArray<IndexSummary>,
  project: string,
  git: string,
  web: string,
  external: string,
  sysdocs: string,
  cmd: string,
  memoryNs: string,
  brains: ReadonlyArray<BrainSpec>,
): DatasetStatus[] {
  const groups = [
    {
      name: "project",
      matches: (index: string) =>
        index.startsWith(`${project}-`) &&
        !index.startsWith(`${project}-hidden-`) &&
        !index.startsWith(`${project}-prjdocs-`) &&
        !index.startsWith(`${project}-archive-`) &&
        !index.startsWith(`${cmd}-`) &&
        !index.startsWith(`${git}-`),
    },
    { name: "git", matches: (index: string) => index.startsWith(`${git}-`) },
    {
      name: "archive",
      matches: (index: string) => index.startsWith(`${project}-archive-`),
    },
    { name: "cmd", matches: (index: string) => index.startsWith(`${cmd}-`) },
    {
      name: "hidden",
      matches: (index: string) => index.startsWith(`${project}-hidden-`),
    },
    {
      name: "prjdocs",
      matches: (index: string) => index.startsWith(`${project}-prjdocs-`),
    },
    { name: "web", matches: (index: string) => index.startsWith(`${web}-`) },
    {
      name: "external",
      matches: (index: string) => index.startsWith(`${external}-`),
    },
    {
      name: "sysdocs",
      matches: (index: string) => index.startsWith(`${sysdocs}-`),
    },
    ...brains.map((brain) => ({
      name: `brain:${brain.name}`,
      matches: (index: string) => index.startsWith(`${brain.prefix}-`),
    })),
    {
      name: "memory",
      matches: (index: string) => index === `.xerj-memory-${memoryNs}`,
    },
  ];

  return groups
    .map((group) => {
      const matched = indices.filter((entry) => group.matches(entry.index));
      return {
        name: group.name,
        docs: matched.reduce((total, entry) => total + entry.docs, 0),
        bytes: matched.reduce((total, entry) => total + entry.bytes, 0),
      };
    })
    .filter((dataset) => dataset.docs > 0 || dataset.bytes > 0);
}
