// A corpus built with `--no-graph` cannot be continued on the graph path: the
// engine refuses with "this corpus was indexed with --no-graph", because the
// two modes reconcile different authorities against one journal. Changing
// `index.graph` therefore needs a rebuild, and this module performs exactly
// that once per node, the same way a changed embedding mode is handled.
//
// Only the project corpus is dropped. Hidden documents, the web spool, external
// files, and memory are separate corpora with their own journals, and deleting
// them would throw away data that cannot be rebuilt from the project tree.

import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { XerjClient } from "./client.ts";

export type CorpusMode = "graph" | "flat";

/** A node built before the option existed ran the flat `--no-graph` corpus. */
const UNRECORDED_MODE: CorpusMode = "flat";

export function corpusModePath(nodeDir: string): string {
  return join(nodeDir, "corpus-mode");
}

export async function readCorpusMode(nodeDir: string): Promise<CorpusMode> {
  const text = await readFile(corpusModePath(nodeDir), "utf8").catch(() => null);
  return text?.trim() === "graph" ? "graph" : UNRECORDED_MODE;
}

/**
 * Brings the project corpus in line with the requested mode. Returns true when
 * it was dropped so the next pass rebuilds it in the new shape.
 */
export async function reconcileCorpusMode(options: {
  readonly client: XerjClient;
  readonly nodeDir: string;
  readonly stateDir: string;
  readonly mode: CorpusMode;
  /** Project prefix; only indices under it belong to the rebuilt corpus. */
  readonly projectPrefix?: string;
}): Promise<boolean> {
  const { client, nodeDir, stateDir, mode, projectPrefix } = options;
  const recorded = await readCorpusMode(nodeDir);
  if (recorded === mode) return false;

  const indices = await client.indices();
  for (const { index } of indices) {
    if (projectPrefix === undefined) continue;
    // `xop-<project>-docs` and any symbol variants, but never the hidden copy,
    // which is written by the plugin and is not part of the graph corpus.
    const belongs = index.startsWith(`${projectPrefix}-`);
    const hidden = index.startsWith(`${projectPrefix}-hidden-`);
    if (!belongs || hidden) continue;
    await client.deleteIndex(index);
  }

  // The journal describes documents that no longer exist, so it goes too.
  await rm(stateDir, { recursive: true, force: true });
  await writeFile(corpusModePath(nodeDir), mode, { mode: 0o600 });
  return true;
}
