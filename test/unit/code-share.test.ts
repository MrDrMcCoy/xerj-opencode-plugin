import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { CodeService } from "../../src/code/service.ts";
import { ShareService } from "../../src/share/service.ts";
import type { EngineRunResult } from "../../src/engine/run.ts";
import { buildTools } from "../../src/tools/search.ts";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

const ok = (stdout: string): EngineRunResult => ({
  code: 0,
  stdout,
  stderr: "",
  timedOut: false,
});

function code(
  overrides: Partial<typeof DEFAULT_CONFIG.code> = {},
  reply: EngineRunResult = ok("2 passages"),
): { service: CodeService; args: string[][]; envs: Array<NodeJS.ProcessEnv> } {
  const args: string[][] = [];
  const envs: Array<NodeJS.ProcessEnv> = [];
  const service = new CodeService({
    config: { ...DEFAULT_CONFIG.code, ...overrides },
    binary: () => "/tmp/xerj",
    nodeUrl: () => "http://127.0.0.1:9200",
    codeRoot: "/tmp/xerj-code",
    logger,
    run: async (next, env) => {
      args.push([...next]);
      envs.push(env);
      return reply;
    },
  });
  return { service, args, envs };
}

function share(
  reply: EngineRunResult = ok("link https://127.0.0.1:9200/s/abc passcode abcd-efgh"),
): { service: ShareService; args: string[][] } {
  const args: string[][] = [];
  const service = new ShareService({
    config: DEFAULT_CONFIG.share,
    binary: () => "/tmp/xerj",
    nodeUrl: () => "http://127.0.0.1:9200",
    logger,
    run: async (next) => {
      args.push([...next]);
      return reply;
    },
  });
  return { service, args };
}

describe("tool registration", () => {
  function names(codeEnabled: boolean, shareEnabled: boolean): string[] {
    return buildTools({
      config: {
        ...DEFAULT_CONFIG,
        code: { ...DEFAULT_CONFIG.code, enabled: codeEnabled },
        share: { ...DEFAULT_CONFIG.share, enabled: shareEnabled },
      },
      projectRoot: ".",
      getArchive: () => null,
      ledger: {} as never,
      logger,
      getClient: () => null,
      getSearch: () => null,
      getMemory: () => null,
      getSpool: () => null,
      getAnomaly: () => null,
      hub: {} as never,
      treeSitter: {} as never,
      code: {} as never,
      share: {} as never,
      lsp: {} as never,
      snapshot: async () => ({}) as never,
    }).map((tool) => tool.name);
  }

  test("registers each tool only when its gate is on", () => {
    expect(names(true, true)).toContain("code");
    expect(names(true, true)).toContain("share");
    expect(names(false, false)).not.toContain("code");
    expect(names(false, false)).not.toContain("share");
  });
});

describe("reference corpora", () => {
  test("query passes the corpus, mode, size cap, and node", async () => {
    const { service, args, envs } = code();
    const result = await service.query({
      corpus: "sqlite",
      query: "how is the pager written",
      k: 4,
      mode: "hybrid",
      full: 600,
      lang: "c",
    });

    expect(result.ok).toBe(true);
    expect(args[0]).toContain("code");
    expect(args[0]).toContain("sqlite");
    expect(args[0]).toContain("--mode");
    expect(args[0]?.[args[0].indexOf("--mode") + 1]).toBe("hybrid");
    expect(args[0]).toContain("--full");
    expect(args[0]?.[args[0].indexOf("--full") + 1]).toBe("600");
    expect(args[0]).toContain("--lang");
    expect(args[0]).toContain("http://127.0.0.1:9200");
    expect(envs[0]?.XERJ_CODE_HOME).toBe("/tmp/xerj-code");
  });

  test("add refuses while the network is off", async () => {
    const { service, args } = code();
    const result = await service.add("demo", ["https://example.test/repo.git"]);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("code.network is off");
    expect(args).toHaveLength(0);
  });

  test("add clones when the network is on", async () => {
    const { service, args } = code({ network: true });
    await service.add("demo", ["https://example.test/repo.git"]);
    expect(args[0]).toEqual([
      "corpus",
      "add",
      "demo",
      "https://example.test/repo.git",
    ]);
  });

  test("a failed command returns the engine's reason", async () => {
    const { service } = code({}, {
      code: 1,
      stdout: "",
      stderr: "no corpus named demo",
      timedOut: false,
    });
    const result = await service.list();
    expect(result.ok).toBe(false);
    expect(result.text).toContain("no corpus named demo");
  });
});

describe("share links", () => {
  test("create passes the expiry, claims, and node", async () => {
    const { service, args } = share();
    const result = await service.create({
      target: "xop-demo-1a2b3c4d",
      expires: "7d",
      maxClaims: 3,
      passcode: "secret-1",
      label: "review",
    });

    expect(result.ok).toBe(true);
    expect(args[0]).toContain("share");
    expect(args[0]).toContain("xop-demo-1a2b3c4d");
    expect(args[0]).toContain("--expires");
    expect(args[0]?.[args[0].indexOf("--expires") + 1]).toBe("7d");
    expect(args[0]?.[args[0].indexOf("--max-claims") + 1]).toBe("3");
    expect(args[0]).toContain("--passcode");
    expect(args[0]).toContain("--label");
    expect(args[0]).toContain("http://127.0.0.1:9200");
  });

  test("list and revoke use the engine flags", async () => {
    const { service, args } = share();
    await service.list();
    await service.revoke("abc");
    expect(args[0]).toContain("--list");
    expect(args[1]).toContain("--revoke");
    expect(args[1]).toContain("abc");
  });

  test("a missing target is refused before running", async () => {
    const { service, args } = share();
    const result = await service.create({ target: " " });
    expect(result.ok).toBe(false);
    expect(args).toHaveLength(0);
  });
});
