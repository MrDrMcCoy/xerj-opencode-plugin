// Integration tests against a real pinned binary. Run with:
//
//   bun test test/integration
//
// They download the binary once (or reuse XERJ_BIN), start a node on a scratch
// data root, and index a fixture project. The fixture covers the cases the plan
// calls out: a deletion, a rename, a secret-shaped file, a binary blob, and a
// large file.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { XerjClient } from "../../src/node/client.ts";
import { projectPaths, startHarness, waitForIndex } from "./harness.ts";
import type { Harness } from "./harness.ts";

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
  const outcome = await harness.index();
  if (outcome.code !== 0 && outcome.code !== 3) {
    throw new Error(
      `autoindex failed (${outcome.code}): ${outcome.stderr || outcome.stdout}`,
    );
  }
  await waitForIndex(harness);
}, 300_000);

afterAll(async () => {
  await harness?.close();
});

describe("project corpus", () => {
  test("indexes text files and skips the secret file", async () => {
    const paths = await projectPaths(harness);

    expect(paths).toContain("src/alpha.ts");
    expect(paths).toContain("docs/guide.md");
    expect(paths.some((path) => path.endsWith(".env"))).toBe(false);
    expect(paths.some((path) => path.endsWith("assets.bin"))).toBe(false);
  });

  test("returns cited passages for a rare term", async () => {
    const response = await harness.client.search(`${harness.prefix}-*`, {
      size: 5,
      _source: ["ax_path"],
      fields: ["_passage"],
      query: { match: { body: "zephyrmarker" } },
    });

    const hits = (
      response as { hits?: { hits?: Array<{ _source?: { ax_path?: string } }> } }
    ).hits?.hits;

    expect(Array.isArray(hits)).toBe(true);
    expect(hits?.[0]?._source?.ax_path).toBe("src/alpha.ts");
  });

  test("reconciles a deletion", async () => {
    await rm(join(harness.project, "src/deleted.ts"));
    const outcome = await harness.index();
    expect([0, 3]).toContain(outcome.code ?? -1);

    const paths = await projectPaths(harness);
    expect(paths.some((path) => path.startsWith("src/deleted.ts"))).toBe(false);
  });

  test("reconciles a rename", async () => {
    await rename(
      join(harness.project, "src/renamed-old.ts"),
      join(harness.project, "src/renamed-new.ts"),
    );
    const outcome = await harness.index();
    expect([0, 3]).toContain(outcome.code ?? -1);

    const paths = await projectPaths(harness);
    expect(paths.some((path) => path.startsWith("src/renamed-new.ts"))).toBe(
      true,
    );
    expect(paths.some((path) => path.startsWith("src/renamed-old.ts"))).toBe(
      false,
    );
  });

  test("picks up an added file", async () => {
    await mkdir(join(harness.project, "src"), { recursive: true });
    await writeFile(
      join(harness.project, "src/added.ts"),
      "export const addtoken = 'later addition';\n",
    );
    const outcome = await harness.index();
    expect([0, 3]).toContain(outcome.code ?? -1);

    const paths = await projectPaths(harness);
    expect(paths).toContain("src/added.ts");
  });
});

describe("memory", () => {
  const namespace = "xerj-int-ns-a";
  const other = "xerj-int-ns-b";

  test("stores, recalls, and forgets", async () => {
    const client = harness.client;

    await client.memoryStore(namespace, {
      id: "int-1",
      text: "the integration fixture stores zephyr decisions",
      metadata: { kind: "decision" },
    });

    const recalled = await client.memoryRecall(namespace, {
      query: "zephyr decision",
      k: 3,
    });
    expect(recalled.some((entry) => entry.id === "int-1")).toBe(true);

    await client.memoryForget(namespace, "int-1");
    const after = await client.memoryRecall(namespace, {
      query: "zephyr decision",
      k: 3,
    });
    expect(after.some((entry) => entry.id === "int-1")).toBe(false);
  });

  test("keeps namespaces apart", async () => {
    const client = harness.client;

    await client.memoryStore(other, {
      id: "int-2",
      text: "a fact that belongs only to the second namespace",
      metadata: {},
    });

    const first = await client.memoryRecall(namespace, {
      query: "second namespace",
      k: 5,
    });
    expect(first.some((entry) => entry.id === "int-2")).toBe(false);

    const second = await client.memoryRecall(other, {
      query: "second namespace",
      k: 5,
    });
    expect(second.some((entry) => entry.id === "int-2")).toBe(true);
  });
});

describe("node", () => {
  test("reports the XERJ identity", async () => {
    const info = await harness.client.info();

    expect(info?.clusterName).toBe("xerj");
  });

  test("re-attaches without spawning a second node", async () => {
    const spawned = await harness.reattach();

    expect(spawned).toBe(false);
  });
});
