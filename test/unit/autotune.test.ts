import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Autotuner } from "../../src/jev/autotune.ts";

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
  const dir = await mkdtemp(join(tmpdir(), "xerj-autotune-"));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of scratch.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const SAMPLES = [
  { text: "keep one", label: true },
  { text: "keep two", label: true },
  { text: "keep three", label: true },
  { text: "keep four", label: true },
  { text: "drop one", label: false },
  { text: "drop two", label: false },
  { text: "drop three", label: false },
  { text: "drop four", label: false },
];

const SCORES: Readonly<Record<string, number>> = {
  "keep one": 0.9,
  "keep two": 0.8,
  "keep three": 0.7,
  "keep four": 0.6,
  "drop one": 0.1,
  "drop two": 0.2,
  "drop three": 0.05,
  "drop four": 0.3,
};

function tuner(
  directory: string,
  overrides: {
    configThreshold?: number;
    margin?: number;
    ask?: (text: string) => Promise<number | null>;
    onThreshold?: (value: number) => void;
  } = {},
): Autotuner {
  return new Autotuner({
    enabled: true,
    intervalMs: 60_000,
    initialDelayMs: 0,
    margin: overrides.margin ?? 0.05,
    minSamples: 4,
    statePath: join(directory, "autotune.json"),
    logger,
    configThreshold: overrides.configThreshold ?? 0.15,
    ask: overrides.ask ?? (async (text) => SCORES[text] ?? null),
    onThreshold: overrides.onThreshold ?? (() => {}),
    onState: () => {},
    record: () => {},
    samples: SAMPLES,
  });
}

describe("autotuner", () => {
  test("moves the floor when the best F1 clears the margin", async () => {
    const directory = await tempDir();
    let active = 0.15;
    const instance = tuner(directory, {
      onThreshold: (value) => {
        active = value;
      },
    });

    const result = await instance.runOnce();

    expect(result?.applied).toBe(true);
    expect(active).toBe(0.35);
    expect(instance.view).toMatchObject({ threshold: 0.35, autotuned: true });
    const state = JSON.parse(
      await readFile(join(directory, "autotune.json"), "utf8"),
    );
    expect(state.threshold).toBe(0.35);
    expect(state.candidate).toBe(0.35);
    expect(state.samples).toBe(8);
  });

  test("keeps the floor when the gain is under the margin", async () => {
    const directory = join(await tempDir(), "unused");
    const autotune = new Autotuner({
      enabled: true,
      initialDelayMs: 0,
      intervalMs: 1_000,
      margin: 0.99,
      minSamples: 4,
      statePath: join(directory, "autotune.json"),
      logger,
      configThreshold: 0.15,
      ask: async (text) => SCORES[text] ?? null,
      onThreshold: () => {},
      onState: () => {},
      record: () => {},
      samples: SAMPLES,
    });

    const result = await autotune.runOnce();
    expect(result?.applied).toBe(false);
    expect(autotune.activeThreshold).toBe(0.15);
  });

  test("does nothing when too few samples answer", async () => {
    const directory = await tempDir();
    const autotune = tuner(directory, {
      ask: async () => null,
    });

    expect(await autotune.runOnce()).toBeNull();
    expect(autotune.activeThreshold).toBe(0.15);
  });

  test("loads a saved floor when the config did not change", async () => {
    const directory = await tempDir();
    let active = 0.15;
    const first = tuner(directory, {
      onThreshold: (value) => {
        active = value;
      },
    });
    await first.runOnce();
    expect(active).toBe(0.35);

    const second = tuner(directory);
    await second.load();
    expect(second.activeThreshold).toBe(0.35);
    expect(second.view.autotuned).toBe(true);
  });

  test("ignores a saved floor when the config threshold changed", async () => {
    const directory = await tempDir();
    const first = tuner(directory);
    await first.runOnce();

    const second = tuner(directory, { configThreshold: 0.3 });
    await second.load();
    expect(second.activeThreshold).toBe(0.3);
    expect(second.view.autotuned).toBe(false);
  });
});
