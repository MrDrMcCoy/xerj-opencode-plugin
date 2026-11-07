import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { Dreamer, parseModel, type DreamerSession } from "../../src/memory/dreamer.ts";

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
  const dir = await mkdtemp(join(tmpdir(), "xerj-dreamer-"));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of scratch.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function dreamer(
  directory: string,
  overrides: {
    model?: string | null;
    intervalMs?: number;
    create?: (input: DreamerSession) => Promise<{ id: string }>;
  } = {},
): {
  dreamer: Dreamer;
  created: DreamerSession[];
  prompts: string[];
} {
  const created: DreamerSession[] = [];
  const prompts: string[] = [];
  const instance = new Dreamer({
    config: {
      ...DEFAULT_CONFIG.memory.dreamer,
      enabled: true,
      model: overrides.model ?? null,
      intervalMs: overrides.intervalMs ?? 0,
      idleMs: 0,
    },
    projectRoot: "/tmp/project",
    stateDirectory: directory,
    logger,
    signal: new AbortController().signal,
    memory: () => ({}) as never,
    createSession:
      overrides.create ??
      (async (input) => {
        created.push(input);
        return { id: "child-1" };
      }),
    prompt: async (input) => {
      prompts.push(input.text);
    },
    verify: async () => ({ checked: 5, stale: 1, flagged: [] }),
    curate: async () => ({ checked: 5, merged: 2, flagged: 1 }),
  });
  return { dreamer: instance, created, prompts };
}

describe("dreamer", () => {
  test("parses a provider/model reference", () => {
    expect(parseModel("openrouter/anthropic/claude-sonnet-4")).toEqual({
      providerID: "openrouter",
      id: "anthropic/claude-sonnet-4",
    });
    expect(parseModel("noslash")).toBeNull();
    expect(parseModel(null)).toBeNull();
  });

  test("curates, creates a child, and prompts it", async () => {
    const directory = await tempDir();
    const { dreamer: instance, created, prompts } = dreamer(directory, {
      model: "openrouter/anthropic/claude-sonnet-4",
    });

    const result = await instance.runNow("parent-1");

    expect(result).toMatchObject({
      ran: true,
      child: "child-1",
      checked: 5,
      stale: 1,
      merged: 2,
      flagged: 1,
    });
    expect(created[0]).toMatchObject({
      parentID: "parent-1",
      title: "XERJ dreamer",
      model: { providerID: "openrouter", id: "anthropic/claude-sonnet-4" },
    });
    expect(created[0]?.permissions).toContainEqual({
      action: "write",
      resource: "*",
      effect: "deny",
    });
    expect(prompts[0]).toContain("XERJ dreamer");
    const state = JSON.parse(await readFile(join(directory, "dreamer.json"), "utf8"));
    expect(typeof state.lastRun).toBe("number");
  });

  test("does not run twice inside the interval", async () => {
    const directory = await tempDir();
    await writeFile(join(directory, "dreamer.json"), JSON.stringify({ lastRun: Date.now() }));
    const { dreamer: instance, created } = dreamer(directory, {
      intervalMs: 86_400_000,
    });

    const result = await instance.runNow("parent-1");

    expect(result.ran).toBe(false);
    expect(result.reason).toContain("interval");
    expect(created).toHaveLength(0);
  });

  test("a create failure is recorded, not thrown", async () => {
    const directory = await tempDir();
    const { dreamer: instance } = dreamer(directory, {
      create: async () => {
        throw new Error("no agent");
      },
    });

    const result = await instance.runNow("parent-1");
    expect(result.ran).toBe(false);
    expect(result.child).toBeNull();
  });
});
