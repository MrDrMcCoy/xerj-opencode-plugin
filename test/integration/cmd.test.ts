// End to end: a command run through the service lands in .xerj/cmd, the node
// indexes it, and both the exact range and a search answer.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CmdService } from "../../src/cmd/service.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { startHarness } from "./harness.ts";
import type { Harness } from "./harness.ts";

let harness: Harness;
let service: CmdService;
let root: string;

beforeAll(async () => {
  harness = await startHarness();
  root = await mkdtemp(join(tmpdir(), "xerj-int-cmd-"));
  service = new CmdService({
    config: DEFAULT_CONFIG.cmd,
    storageRoot: root,
    projectRoot: harness.project,
    indexName: `${harness.prefix}-cmd-docs`,
    getClient: () => harness.client,
    logger: harness.logger,
  });
  await service.start();
}, 300_000);

afterAll(async () => {
  service?.stop();
  await harness?.close();
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("command output", () => {
  test("runs, indexes, shows a range, and searches it", async () => {
    const result = await service.run(
      "printf 'alpha\\nzephyrneedle\\ngamma\\n'; exit 7",
    );
    expect(result.exitCode).toBe(7);
    expect(result.lines).toBe(3);

    const read = await service.show(result.stem, 1, 3);
    expect(read?.lines).toEqual(["alpha", "zephyrneedle", "gamma"]);

    await service.reindex();
    const hits = await service.search("zephyrneedle", { k: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.stem).toBe(result.stem);
    expect(hits[0]?.line).toBe(2);

    const listed = service.list(5);
    expect(listed[0]?.stem).toBe(result.stem);
    expect(listed[0]?.exitCode).toBe(7);
  }, 120_000);

  test("ingests a file the agent wrote outside the wrapper", async () => {
    const path = join(harness.project, "build.log");
    await writeFile(path, "compiled\nok\n");
    const entry = await service.ingest(path);
    expect(entry?.lines).toBe(2);

    await service.reindex();
    const hits = await service.search("compiled", { k: 5 });
    expect(hits.some((hit) => hit.stem === entry?.stem)).toBe(true);
  }, 120_000);
});
