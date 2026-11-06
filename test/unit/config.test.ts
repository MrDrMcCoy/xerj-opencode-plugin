import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, loadConfig } from "../../src/config.ts";
import { Priority } from "../../src/node/priority.ts";

describe("loadConfig", () => {
  test("returns defaults for undefined options", () => {
    const { config, warnings } = loadConfig(undefined);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toHaveLength(0);
  });

  test("reads nested options", () => {
    const { config } = loadConfig({
      context: { enabled: false, maxTokens: 200 },
      index: { brain: ["docs", "notes"] },
      binary: { version: "1.0.0-rc.100" },
      storage: { root: "/var/lib/xerj" },
    });

    expect(config.context.enabled).toBe(false);
    expect(config.context.maxTokens).toBe(200);
    expect(config.index.brain).toEqual(["docs", "notes"]);
    expect(config.binary.version).toBe("1.0.0-rc.100");
    expect(config.storage.root).toBe("/var/lib/xerj");
  });

  test("defaults project storage to .xerj", () => {
    const { config } = loadConfig(undefined);
    expect(config.storage.root).toBeNull();
  });

  test("clamps out-of-range numbers and warns", () => {
    const { config, warnings } = loadConfig({ context: { maxTokens: 5 } });
    expect(config.context.maxTokens).toBe(100);
    expect(warnings.some((entry) => entry.includes("context.maxTokens"))).toBe(true);
  });

  test("falls back on wrong types instead of throwing", () => {
    const { config, warnings } = loadConfig({ index: { auto: "yes" } });
    expect(config.index.auto).toBe(true);
    expect(warnings.some((entry) => entry.includes("index.auto"))).toBe(true);
  });

  test("enables neural embeddings by default and reads the override", () => {
    expect(loadConfig(undefined).config.index.neural).toBe(true);
    const { config, warnings } = loadConfig({ index: { neural: false } });
    expect(config.index.neural).toBe(false);
    expect(warnings).toEqual([]);
  });

  test("ignores unknown keys", () => {
    const { config } = loadConfig({ nope: true, node: { port: 9300 } });
    expect(config.node.port).toBe(9300);
    expect(config).not.toHaveProperty("nope");
  });

  test("takes XERJ_URL from the environment when no URL is configured", () => {
    const { config } = loadConfig({}, { XERJ_URL: "http://127.0.0.1:9400" });
    expect(config.node.url).toBe("http://127.0.0.1:9400");
  });

  test("configured node.url wins over the environment", () => {
    const { config } = loadConfig(
      { node: { url: "http://127.0.0.1:9200" } },
      { XERJ_URL: "http://127.0.0.1:9400" },
    );
    expect(config.node.url).toBe("http://127.0.0.1:9200");
  });

  test("reads a pinned target and libc", () => {
    const { config, warnings } = loadConfig({
      binary: { target: "aarch64-apple-darwin", libc: "gnu" },
    });
    expect(config.binary.target).toBe("aarch64-apple-darwin");
    expect(config.binary.libc).toBe("gnu");
    expect(warnings).toHaveLength(0);
  });

  test("falls back to host detection for a malformed target", () => {
    const { config, warnings } = loadConfig({ binary: { target: "linux" } });
    expect(config.binary.target).toBeNull();
    expect(warnings.some((entry) => entry.includes("binary.target"))).toBe(true);
  });

  test("falls back to musl for an unknown libc", () => {
    const { config, warnings } = loadConfig({ binary: { libc: "glibc" } });
    expect(config.binary.libc).toBe("musl");
    expect(warnings.some((entry) => entry.includes("binary.libc"))).toBe(true);
  });

  test("reads hidden folders and their size cap", () => {
    const { config } = loadConfig({
      index: { hidden: [".agents", ".github"], hiddenMaxBytes: 4096 },
    });
    expect(config.index.hidden).toEqual([".agents", ".github"]);
    expect(config.index.hiddenMaxBytes).toBe(4096);
  });

  test("clamps a tiny hidden size cap", () => {
    const { config, warnings } = loadConfig({ index: { hiddenMaxBytes: 1 } });
    expect(config.index.hiddenMaxBytes).toBe(1024);
    expect(warnings.some((entry) => entry.includes("index.hiddenMaxBytes"))).toBe(true);
  });

  test("rejects a malformed pinned version", () => {
    const { config, warnings } = loadConfig({ binary: { version: "latest" } });
    expect(config.binary.version).toBe("auto");
    expect(warnings).toHaveLength(1);
  });

  test("filters non-string brain entries", () => {
    const { config, warnings } = loadConfig({ index: { brain: ["docs", 3] } });
    expect(config.index.brain).toEqual(["docs"]);
    expect(warnings).toHaveLength(1);
  });
});

describe("node.priority", () => {
  test("defaults to low so indexing stays out of the way", () => {
    expect(DEFAULT_CONFIG.node.priority).toBe(Priority.Low);
    expect(loadConfig({}).config.node.priority).toBe(Priority.Low);
  });

  test("accepts low, normal, and high", () => {
    for (const priority of [Priority.Low, Priority.Normal, Priority.High]) {
      expect(loadConfig({ node: { priority } }).config.node.priority).toBe(priority);
    }
  });

  test("warns and falls back on an unknown value", () => {
    const loaded = loadConfig({ node: { priority: "urgent" } });
    expect(loaded.config.node.priority).toBe(Priority.Low);
    expect(loaded.warnings.join("\n")).toContain("node.priority must be one of");
  });
});

describe("memory.retain", () => {
  test("defaults bound age and size together", () => {
    const retain = DEFAULT_CONFIG.memory.retain;
    expect(retain.days).toBe(90);
    expect(retain.maxCount).toBe(500);
    expect(retain.maxBytes).toBe(4_000_000);
  });

  test("each cap can be disabled with zero", () => {
    const loaded = loadConfig({
      memory: { retain: { days: 0, maxCount: 0, maxBytes: 0 } },
    });
    expect(loaded.config.memory.retain).toEqual({ days: 0, maxCount: 0, maxBytes: 0 });
  });

  test("partial configuration keeps the other defaults", () => {
    const loaded = loadConfig({ memory: { retain: { days: 7 } } });
    expect(loaded.config.memory.retain).toEqual({
      days: 7,
      maxCount: 500,
      maxBytes: 4_000_000,
    });
  });

  test("a malformed value warns and falls back", () => {
    const loaded = loadConfig({ memory: { retain: { maxCount: "many" } } });
    expect(loaded.config.memory.retain.maxCount).toBe(500);
    expect(loaded.warnings.join("\n")).toContain("memory.retain.maxCount");
  });
});
