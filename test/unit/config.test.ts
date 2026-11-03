import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, loadConfig } from "../../src/config.ts";

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
    });

    expect(config.context.enabled).toBe(false);
    expect(config.context.maxTokens).toBe(200);
    expect(config.index.brain).toEqual(["docs", "notes"]);
    expect(config.binary.version).toBe("1.0.0-rc.100");
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
