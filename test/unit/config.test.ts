import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, loadConfig } from "../../src/config.ts";
import { Priority } from "../../src/node/priority.ts";

describe("context.rehydrate", () => {
  test("is on with a 600-token cap by default", () => {
    const { config } = loadConfig(undefined);
    expect(config.context.rehydrate).toBe(true);
    expect(config.context.rehydrateTokens).toBe(600);
  });

  test("reads the switch and the cap", () => {
    const { config } = loadConfig({
      context: { rehydrate: false, rehydrateTokens: 200 },
    });
    expect(config.context.rehydrate).toBe(false);
    expect(config.context.rehydrateTokens).toBe(200);
  });

  test("clamps a negative cap to zero", () => {
    const { config } = loadConfig({ context: { rehydrateTokens: -5 } });
    expect(config.context.rehydrateTokens).toBe(0);
  });
});

describe("node.cpus", () => {
  test("defaults to the odd CPUs", () => {
    expect(loadConfig(undefined).config.node.cpus).toEqual({ kind: "odd" });
  });

  test("treats an explicit null as no affinity change", () => {
    expect(loadConfig({ node: { cpus: null } }).config.node.cpus).toBeNull();
  });

  test("reads a CPU list", () => {
    const { config, warnings } = loadConfig({ node: { cpus: "0-3,8" } });
    expect(config.node.cpus).toEqual({
      kind: "list",
      indexes: [0, 1, 2, 3, 8],
    });
    expect(warnings).toHaveLength(0);
  });

  test("reads odd, even and a percentage", () => {
    expect(loadConfig({ node: { cpus: "odd" } }).config.node.cpus).toEqual({
      kind: "odd",
    });
    expect(loadConfig({ node: { cpus: "even" } }).config.node.cpus).toEqual({
      kind: "even",
    });
    expect(loadConfig({ node: { cpus: "50%" } }).config.node.cpus).toEqual({
      kind: "percent",
      percent: 50,
    });
  });

  test("treats all as no affinity change", () => {
    expect(loadConfig({ node: { cpus: "all" } }).config.node.cpus).toBeNull();
  });

  test("falls back to odd with a warning on a malformed value", () => {
    const { config, warnings } = loadConfig({ node: { cpus: "3-1" } });
    expect(config.node.cpus).toEqual({ kind: "odd" });
    expect(warnings.some((entry) => entry.includes("node.cpus"))).toBe(true);
  });

  test("falls back to odd with a warning on the wrong type", () => {
    const { config, warnings } = loadConfig({ node: { cpus: 2 } });
    expect(config.node.cpus).toEqual({ kind: "odd" });
    expect(warnings.some((entry) => entry.includes("node.cpus"))).toBe(true);
  });
});

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

describe("timeouts", () => {
  test("carry the shipped defaults", () => {
    const { config } = loadConfig(undefined);
    expect(config.binary.detectTimeoutMs).toBe(2_000);
    expect(config.binary.commandTimeoutMs).toBe(60_000);
    expect(config.binary.requestTimeoutMs).toBe(10_000);
    expect(config.node.clientTimeoutMs).toBe(5_000);
    expect(config.node.writeTimeoutMs).toBe(120_000);
    expect(config.node.probeTimeoutMs).toBe(800);
    expect(config.node.startupTimeoutMs).toBe(30_000);
    expect(config.node.stopGraceMs).toBe(5_000);
    expect(config.remote.fetchTimeoutMs).toBe(10_000);
    expect(config.context.recallTimeoutMs).toBe(120);
    expect(config.context.hintTimeoutMs).toBe(150);
    expect(config.prjdocs.requestTimeoutMs).toBe(15_000);
    expect(config.prjdocs.latestTimeoutMs).toBe(5_000);
  });

  test("read an override per key", () => {
    const { config, warnings } = loadConfig({
      binary: { detectTimeoutMs: 500, commandTimeoutMs: 5_000 },
      node: { clientTimeoutMs: 250, writeTimeoutMs: 20_000 },
      context: { recallTimeoutMs: 50, hintTimeoutMs: 60 },
      remote: { fetchTimeoutMs: 3_000 },
      prjdocs: { requestTimeoutMs: 8_000, latestTimeoutMs: 2_000 },
    });

    expect(config.binary.detectTimeoutMs).toBe(500);
    expect(config.binary.commandTimeoutMs).toBe(5_000);
    expect(config.node.clientTimeoutMs).toBe(250);
    expect(config.node.writeTimeoutMs).toBe(20_000);
    expect(config.context.recallTimeoutMs).toBe(50);
    expect(config.context.hintTimeoutMs).toBe(60);
    expect(config.remote.fetchTimeoutMs).toBe(3_000);
    expect(config.prjdocs.requestTimeoutMs).toBe(8_000);
    expect(config.prjdocs.latestTimeoutMs).toBe(2_000);
    expect(warnings).toHaveLength(0);
  });

  test("clamp an out-of-range value and warn", () => {
    const { config, warnings } = loadConfig({
      node: { startupTimeoutMs: 5 },
      context: { hintTimeoutMs: 0 },
    });

    expect(config.node.startupTimeoutMs).toBe(1_000);
    expect(config.context.hintTimeoutMs).toBe(10);
    expect(warnings.join("\n")).toContain("node.startupTimeoutMs");
    expect(warnings.join("\n")).toContain("context.hintTimeoutMs");
  });
});

describe("memory.retain", () => {
  test("defaults to unlimited age and size, and no count cap", () => {
    const retain = DEFAULT_CONFIG.memory.retain;
    // Memories are not expired by age unless a user asks for it.
    expect(retain.days).toBe(0);
    expect(retain.maxCount).toBe(0);
    expect(retain.maxBytes).toBe(2 * 1024 ** 3);
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
      maxCount: 0,
      maxBytes: 2 * 1024 ** 3,
    });
  });

  test("a malformed value warns and falls back", () => {
    const loaded = loadConfig({ memory: { retain: { maxCount: "many" } } });
    expect(loaded.config.memory.retain.maxCount).toBe(0);
    expect(loaded.warnings.join("\n")).toContain("memory.retain.maxCount");
  });
});

describe("prjdocs.eagerKeywords", () => {
  test("defaults to empty", () => {
    expect(DEFAULT_CONFIG.prjdocs.eagerKeywords).toEqual([]);
  });

  test("accepts a list of terms", () => {
    const { config } = loadConfig({
      prjdocs: { eagerKeywords: ["fastapi", "polars"] },
    });

    expect(config.prjdocs.eagerKeywords).toEqual(["fastapi", "polars"]);
  });

  test("warns and ignores a value that is not a list", () => {
    const { config, warnings } = loadConfig({
      prjdocs: { eagerKeywords: "fastapi" },
    });

    expect(config.prjdocs.eagerKeywords).toEqual([]);
    expect(warnings.join(" ")).toContain("prjdocs.eagerKeywords");
  });
});

describe("git history indexing", () => {
  test("on by default with a 500 commit window", () => {
    expect(DEFAULT_CONFIG.index.git).toBe(true);
    expect(DEFAULT_CONFIG.index.gitLimit).toBe(500);
  });

  test("can be turned off and bounded", () => {
    const { config } = loadConfig({ index: { git: false, gitLimit: 50 } });

    expect(config.index.git).toBe(false);
    expect(config.index.gitLimit).toBe(50);
  });

  test("a limit below ten is clamped", () => {
    const { config } = loadConfig({ index: { gitLimit: 1 } });

    expect(config.index.gitLimit).toBe(10);
  });
});

describe("analysis gates", () => {
  test("tree-sitter and LSP are off by default", () => {
    expect(DEFAULT_CONFIG.analysis.treeSitter).toEqual({
      enabled: false,
      languages: [],
      maxParseBytes: 1048576,
    });
    expect(DEFAULT_CONFIG.analysis.lsp).toEqual({
      enabled: false,
      servers: {},
      autoInstall: true,
      idleMs: 300000,
      maxServers: 2,
      timeoutMs: 2000,
    });
  });

  test("takes server commands and clamps the LSP bounds", () => {
    const { config, warnings } = loadConfig({
      analysis: {
        lsp: {
          enabled: true,
          servers: {
            typescript: ["typescript-language-server", "--stdio"],
            python: 5,
          },
          idleMs: 1,
          maxServers: 99,
          timeoutMs: 1,
        },
      },
    });

    expect(config.analysis.lsp.enabled).toBe(true);
    expect(config.analysis.lsp.servers.typescript).toEqual([
      "typescript-language-server",
      "--stdio",
    ]);
    expect(config.analysis.lsp.servers.python).toBeUndefined();
    expect(config.analysis.lsp.idleMs).toBe(60000);
    expect(config.analysis.lsp.maxServers).toBe(8);
    expect(config.analysis.lsp.timeoutMs).toBe(200);
    expect(warnings.filter((w) => w.includes("analysis.lsp"))).toHaveLength(4);
  });
});

describe("reference corpora and share", () => {
  test("both are off by default", () => {
    expect(DEFAULT_CONFIG.code).toEqual({
      enabled: false,
      network: false,
      timeoutMs: 600000,
      maxResults: 8,
      maxPassageChars: 1200,
    });
    expect(DEFAULT_CONFIG.share).toEqual({
      enabled: false,
      expires: "24h",
      maxClaims: 1,
      timeoutMs: 30000,
    });
  });

  test("clamps their numbers", () => {
    const { config, warnings } = loadConfig({
      code: { maxResults: 0, maxPassageChars: 99999, timeoutMs: 1 },
      share: { maxClaims: 99, timeoutMs: 1 },
    });
    expect(config.code.maxResults).toBe(1);
    expect(config.code.maxPassageChars).toBe(20000);
    expect(config.code.timeoutMs).toBe(5000);
    expect(config.share.maxClaims).toBe(50);
    expect(config.share.timeoutMs).toBe(5000);
    expect(warnings.filter((w) => w.includes("code.") || w.includes("share."))).toHaveLength(5);
  });
});

describe("hub", () => {
  test("off by default, cached only, hosted off", () => {
    expect(DEFAULT_CONFIG.hub).toEqual({
      enabled: false,
      network: false,
      hosted: "off",
      url: "https://hub.xerj.org",
      maxTokens: 1200,
      timeoutMs: 120000,
    });
  });

  test("takes overrides and clamps its numbers", () => {
    const { config, warnings } = loadConfig({
      hub: {
        enabled: true,
        network: true,
        hosted: "on",
        url: " https://example.test ",
        maxTokens: 1,
        timeoutMs: 1,
      },
    });

    expect(config.hub.enabled).toBe(true);
    expect(config.hub.network).toBe(true);
    expect(config.hub.hosted).toBe("on");
    expect(config.hub.url).toBe("https://example.test");
    expect(config.hub.maxTokens).toBe(100);
    expect(config.hub.timeoutMs).toBe(5000);
    expect(warnings.filter((w) => w.includes("hub."))).toHaveLength(2);
  });

  test("an unknown hosted value warns and uses off", () => {
    const { config, warnings } = loadConfig({ hub: { hosted: "maybe" } });
    expect(config.hub.hosted).toBe("off");
    expect(warnings.some((w) => w.includes("hub.hosted"))).toBe(true);
  });
});

describe("memory distillation", () => {
  test("on by default, with the local judge", () => {
    expect(DEFAULT_CONFIG.memory.distill).toEqual({
      enabled: true,
      judge: "local",
      minConfidence: 55,
      maxPerTurn: 3,
      maxPerProject: 200,
      modelMaxCalls: 3,
      modelContextChars: 1200,
      modelTimeoutMs: 4000,
      local: {
        version: "jevos-v5",
        path: null,
        port: 8017,
        threads: 0,
        idleMs: 600000,
        timeoutMs: 5000,
        threshold: 20,
        kindConfidence: 40,
        downloadTimeoutMs: 900000,
        startupTimeoutMs: 120000,
        autotune: {
          enabled: true,
          intervalMs: 86400000,
          initialDelayMs: 600000,
          margin: 5,
          minSamples: 12,
        },
      },
    });
  });

  test("extract is off by default with bounded counts", () => {
    expect(DEFAULT_CONFIG.memory.extract).toEqual({
      enabled: false,
      maxFacts: 3,
      maxBytes: 204800,
    });
  });

  test("clamps extract counts and takes a boolean enable", () => {
    const { config, warnings } = loadConfig({
      memory: { extract: { enabled: true, maxFacts: 0, maxBytes: 10 } },
    });

    expect(config.memory.extract).toEqual({
      enabled: true,
      maxFacts: 1,
      maxBytes: 1024,
    });
    expect(warnings.filter((w) => w.includes("memory.extract"))).toHaveLength(2);
  });

  test("takes the model judge and clamps its counts", () => {
    const { config, warnings } = loadConfig({
      memory: {
        distill: {
          enabled: true,
          judge: "model",
          minConfidence: 900,
          maxPerTurn: 0,
          maxPerProject: 1,
        },
      },
    });

    expect(config.memory.distill.enabled).toBe(true);
    expect(config.memory.distill.judge).toBe("model");
    expect(config.memory.distill.minConfidence).toBe(100);
    expect(config.memory.distill.maxPerTurn).toBe(1);
    expect(config.memory.distill.maxPerProject).toBe(10);
    expect(warnings.every((warning) => warning.includes("memory.distill"))).toBe(true);
  });

  test("takes the local judge and clamps its thresholds", () => {
    const { config, warnings } = loadConfig({
      memory: {
        distill: {
          enabled: true,
          judge: "local",
          local: { port: 1, threads: 999, timeoutMs: 10, threshold: 200 },
        },
      },
    });

    expect(config.memory.distill.judge).toBe("local");
    expect(config.memory.distill.local.port).toBe(1024);
    expect(config.memory.distill.local.threads).toBe(256);
    expect(config.memory.distill.local.timeoutMs).toBe(100);
    expect(config.memory.distill.local.threshold).toBe(100);
    expect(warnings.every((warning) => warning.includes("memory.distill.local"))).toBe(true);
  });

  test("an unknown judge warns and keeps the default", () => {
    const { config, warnings } = loadConfig({
      memory: { distill: { judge: "magic" } },
    });

    expect(config.memory.distill.judge).toBe("local");
    expect(warnings.some((warning) => warning.includes("memory.distill.judge"))).toBe(true);
  });
});
