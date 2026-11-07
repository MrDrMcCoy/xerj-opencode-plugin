import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { HubService, type RunResult } from "../../src/hub/service.ts";
import { buildTools } from "../../src/tools/search.ts";

const CODE_STUB = {
  list: async () => ({ ok: false, text: "code disabled" }),
  add: async () => ({ ok: false, text: "code disabled" }),
  index: async () => ({ ok: false, text: "code disabled" }),
  query: async () => ({ ok: false, text: "code disabled" }),
} as never;
const SHARE_STUB = {
  create: async () => ({ ok: false, text: "share disabled" }),
  list: async () => ({ ok: false, text: "share disabled" }),
  revoke: async () => ({ ok: false, text: "share disabled" }),
} as never;
const NOTES_STUB = {
  add: async () => ({ id: "n" }),
  list: async () => [],
  remove: async () => false,
  search: async () => [],
  match: async () => null,
  recordHit: async () => {},
} as never;

const LSP_STUB = {
  callers: async () => [],
  impact: async () => [],
  inspect: async () => [],
  stopAll: async () => {},
} as never;
const TREE_STUB = {
  report: async () => ({ files: 0, functions: [], duplicates: [] }),
} as never;

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

const ANSWER = {
  corpus: "sqlite-src",
  pinned_sha: "abc",
  pin_sha: "0123456789abcdef",
  pin: "abc",
  age_days: 3,
  corpus_name: "sqlite-src",
  answered_from: "local_pack",
  licence_spdx: "Public-Domain (SQLite blessing)",
  mode: "how",
  hits: [
    {
      file: "sqlite/src/btree.c",
      line: 42,
      kind: "passage",
      text: "The btree module.",
      value: null,
      licence_warning: null,
    },
  ],
  warnings: ["pin is 3 days old"],
  truncated: false,
};

function service(
  overrides: Partial<typeof DEFAULT_CONFIG.hub> = {},
  reply: RunResult = {
    code: 0,
    stdout: JSON.stringify(ANSWER),
    stderr: "",
    timedOut: false,
  },
): { hub: HubService; args: string[][]; envs: Array<NodeJS.ProcessEnv> } {
  const args: string[][] = [];
  const envs: Array<NodeJS.ProcessEnv> = [];
  const hub = new HubService({
    config: { ...DEFAULT_CONFIG.hub, network: false, hosted: "off", ...overrides },
    hubRoot: "/tmp/xerj-hub",
    binary: () => "/tmp/xerj",
    nodeUrl: () => "http://127.0.0.1:9200",
    logger,
    run: async (next, env) => {
      args.push([...next]);
      envs.push(env);
      return reply;
    },
  });
  return { hub, args, envs };
}

describe("hub tools", () => {
  function names(enabled: boolean, hub: HubService): string[] {
    return buildTools({
      config: { ...DEFAULT_CONFIG, hub: { ...DEFAULT_CONFIG.hub, enabled } },
      projectRoot: ".",
      getArchive: () => null,
      ledger: {} as never,
      logger,
      getClient: () => null,
      getSearch: () => null,
      getMemory: () => null,
      getSpool: () => null,
      getAnomaly: () => null,
      hub,
      treeSitter: TREE_STUB,
      code: CODE_STUB,
      share: SHARE_STUB,
      lsp: LSP_STUB,
      notes: NOTES_STUB,
      snapshot: async () => ({}) as never,
    }).map((tool) => tool.name);
  }

  test("registers ask and hub only when enabled", () => {
    const { hub } = service();
    expect(names(true, hub)).toContain("ask");
    expect(names(true, hub)).toContain("hub");
    expect(names(false, hub)).not.toContain("ask");
    expect(names(false, hub)).not.toContain("hub");
  });
});

describe("hub service", () => {
  test("passes offline and hosted off when the network is off", async () => {
    const { hub, args, envs } = service();
    const result = await hub.ask({ question: "how does the btree page work?" });

    expect(result.ok).toBe(true);
    expect(result.corpus).toBe("sqlite-src");
    expect(result.text).toContain("sqlite-src");
    expect(result.text).toContain("Public-Domain");
    expect(result.text).toContain("sqlite/src/btree.c:42");
    expect(result.text).toContain("warning: pin is 3 days old");
    expect(args[0]).toContain("--offline");
    expect(args[0]).toContain("--hosted");
    expect(args[0]?.[args[0]?.indexOf("--hosted") + 1]).toBe("off");
    expect(args[0]).toContain("--url");
    expect(args[0]).toContain("http://127.0.0.1:9200");
    expect(envs[0]?.XERJ_HUB_URL).toBe("https://hub.xerj.org");
    expect(envs[0]?.XERJ_HUB_HOME).toBe("/tmp/xerj-hub");
  });

  test("allows the network and hosted mode when configured", async () => {
    const { hub, args } = service({ network: true, hosted: "on" });
    await hub.ask({ question: "what is the pager?", corpus: "sqlite-src", mode: "how" });

    expect(args[0]).not.toContain("--offline");
    expect(args[0]).toContain("--corpus");
    expect(args[0]).toContain("sqlite-src");
    expect(args[0]?.[args[0].indexOf("--hosted") + 1]).toBe("on");
  });

  test("maps a missing public key to a readable failure", async () => {
    const { hub } = service({}, { code: 5, stdout: "", stderr: "", timedOut: false });
    const result = await hub.ask({ question: "anything" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("no hub public key");
  });

  test("find reads the cached catalogue", async () => {
    const body = {
      routing: "confident",
      corpora: [
        {
          slug: "sqlite-src",
          score: 22.2,
          cached: false,
          licence_spdx: "Public-Domain",
          pack_bytes: 114_000_000,
          ask_for: "embedded DB internals",
        },
      ],
    };
    const { hub, args } = service({}, {
      code: 0,
      stdout: JSON.stringify(body),
      stderr: "",
      timedOut: false,
    });
    const result = await hub.find("sqlite", 5);

    expect(result.ok).toBe(true);
    expect(result.text).toContain("sqlite-src");
    expect(result.text).toContain("not cached");
    expect(args[0]).toContain("find");
    expect(args[0]).toContain("--json");
  });

  test("sync refuses when the network is off", async () => {
    const { hub, args } = service();
    const result = await hub.sync();
    expect(result.ok).toBe(false);
    expect(result.text).toContain("hub.network is off");
    expect(args).toHaveLength(0);
  });

  test("status passes the engine output through", async () => {
    const { hub } = service({}, {
      code: 0,
      stdout: "no packs\nnode: not running",
      stderr: "",
      timedOut: false,
    });
    const result = await hub.status();
    expect(result.ok).toBe(true);
    expect(result.text).toContain("no packs");
  });
});
