import { describe, expect, test } from "bun:test";
import {
  formatContextBlock,
  formatCorpusBlock,
  registerSessionHooks,
  shouldRetrieve,
} from "../../src/hooks/session.ts";
import { DEFAULT_CONFIG, type Config } from "../../src/config.ts";
import type { Logger } from "../../src/log.ts";
import type { SearchService } from "../../src/search/service.ts";
import type { MemoryStore } from "../../src/memory/store.ts";

describe("shouldRetrieve", () => {
  test("skips slash commands", () => {
    expect(shouldRetrieve("/xerj-reindex")).toBe(false);
  });

  test("skips short replies", () => {
    expect(shouldRetrieve("begin")).toBe(false);
    expect(shouldRetrieve("yes, do it")).toBe(false);
  });

  test("accepts a real question", () => {
    expect(shouldRetrieve("where is the watch process started?")).toBe(true);
  });
});

describe("context blocks", () => {
  test("wraps the passages with the citation instruction", () => {
    const block = formatContextBlock("[1] src/a.ts:3\ncode");
    expect(block.startsWith("<xerj-context>")).toBe(true);
    expect(block).toContain("Cite path:line");
    expect(block).toContain("[1] src/a.ts:3");
    expect(block.endsWith("</xerj-context>")).toBe(true);
  });

  test("wraps the corpus summary", () => {
    expect(formatCorpusBlock("42 records")).toBe("<xerj-corpus>\n42 records\n</xerj-corpus>");
  });
});

type Handler = (event: unknown) => Promise<void>;

type HookName = "prompt" | "context";

interface FakeCtx {
  handlers: Record<HookName, Handler>;
  session: {
    hook(name: string, handler: Handler): Promise<void>;
  };
}

function fakeCtx(): FakeCtx {
  const handlers: Record<string, Handler> = {};
  return {
    handlers,
    session: {
      hook: async (name, handler) => {
        handlers[name] = handler;
      },
    },
  };
}

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

interface SearchCall {
  query: string;
  options: Record<string, unknown>;
}

function fakeSearch(
  result: { hits: Array<{ path: string | null }>; text: string; bytes: number } | null,
  calls: SearchCall[],
): SearchService {
  return {
    search: async (query: string, options: Record<string, unknown> = {}) => {
      calls.push({ query, options });
      if (result === null) throw new Error("node is down");
      return {
        hits: result.hits.map((hit, index) => ({
          index: "i",
          id: String(index),
          passage: 0,
          path: hit.path,
          line: 1,
          title: null,
          kind: null,
          score: 1,
          text: "passage",
        })),
        text: result.text,
        bytes: result.bytes,
        strategy: "hybrid" as const,
        narrowingBytes: 0,
      };
    },
  } as unknown as SearchService;
}

function fakeMemory(
  hits: Array<{ id: string; text: string; metadata: Record<string, unknown>; score: number }>,
  calls: Array<{ query: string; k: number }>,
): MemoryStore {
  return {
    recall: async (query: string, k: number) => {
      calls.push({ query, k });
      return hits;
    },
  } as unknown as MemoryStore;
}

interface Hooks {
  ctx: FakeCtx;
  activity: Array<string | undefined>;
  queries: Array<{ sessionID: string; paths: string[]; bytes: number; hits: number }>;
  injections: number;
}

async function register(
  overrides: {
    config?: Partial<Config["context"]>;
    search?: SearchService;
    memory?: MemoryStore;
  } = {},
): Promise<Hooks> {
  const hooks: Hooks = {
    ctx: fakeCtx(),
    activity: [],
    queries: [],
    injections: 0,
  };

  await registerSessionHooks(hooks.ctx as never, {
    config: { ...DEFAULT_CONFIG, context: { ...DEFAULT_CONFIG.context, ...overrides.config } },
    logger,
    getSearch: () => overrides.search ?? null,
    getMemory: () => overrides.memory ?? null,
    summarize: async () => "42 records, watching",
    onActivity: (sessionID) => {
      hooks.activity.push(sessionID);
    },
    onInject: () => {
      hooks.injections += 1;
    },
    recordQuery: async (sessionID, paths, bytes, hits) => {
      hooks.queries.push({ sessionID, paths: [...paths], bytes, hits });
    },
  });
  return hooks;
}

const LONG = "where does the watcher store its journal state?";

function promptEvent(sessionID: string, text: string, messageID = "m1"): unknown {
  return { sessionID, messageID, prompt: { text } };
}

function contextEvent(sessionID: string, messageID = "m1"): unknown {
  return { sessionID, messageID, system: [] as Array<{ type: string; text: string }> };
}

function systemTexts(event: unknown): string[] {
  return (event as { system: Array<{ text: string }> }).system.map((part) => part.text);
}

describe("hook registration", () => {
  test("registers nothing when context injection is disabled", async () => {
    const hooks = await register({ config: { enabled: false } });
    expect(Object.keys(hooks.ctx.handlers)).toEqual([]);
  });

  test("registers the prompt and context hooks", async () => {
    const hooks = await register();
    expect(Object.keys(hooks.ctx.handlers).sort()).toEqual(["context", "prompt"]);
  });
});

describe("prompt hook", () => {
  test("records activity even for short prompts", async () => {
    const hooks = await register();
    await hooks.ctx.handlers.prompt(promptEvent("s1", "hi"));
    expect(hooks.activity).toEqual(["s1"]);
    expect(hooks.queries).toEqual([]);
  });

  test("retrieves, records the query and prepares the block", async () => {
    const hooks = await register({
      search: fakeSearch(
        { hits: [{ path: "src/a.ts" }], text: "[1] src/a.ts:3\ncode", bytes: 100 },
        [],
      ),
    });
    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m9"));
    expect(hooks.queries).toHaveLength(1);
    expect(hooks.queries[0]).toEqual({
      sessionID: "s1",
      paths: ["src/a.ts"],
      bytes: 100,
      hits: 1,
    });

    const event = contextEvent("s1", "m9");
    await hooks.ctx.handlers.context(event);
    const texts = systemTexts(event);
    expect(texts.some((text) => text.includes("<xerj-corpus>"))).toBe(true);
    expect(texts.some((text) => text.includes("<xerj-context>"))).toBe(true);
    expect(hooks.injections).toBe(1);
  });

  test("asks the search for the context surface and budget", async () => {
    const calls: SearchCall[] = [];
    const hooks = await register({
      search: fakeSearch({ hits: [{ path: null }], text: "x", bytes: 1 }, calls),
    });
    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toMatchObject({
      surface: "context",
      k: DEFAULT_CONFIG.context.maxPassages,
      maxTokens: DEFAULT_CONFIG.context.maxTokens,
    });
  });

  test("does not prepare anything when retrieval finds nothing", async () => {
    const hooks = await register({
      search: fakeSearch({ hits: [], text: "", bytes: 0 }, []),
    });
    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG));
    const event = contextEvent("s1");
    await hooks.ctx.handlers.context(event);
    expect(systemTexts(event).some((text) => text.includes("<xerj-context>"))).toBe(false);
    expect(hooks.injections).toBe(0);
  });

  test("survives a search failure and still summarises the corpus", async () => {
    const hooks = await register({ search: fakeSearch(null, []) });
    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG));
    const event = contextEvent("s1");
    await hooks.ctx.handlers.context(event);
    expect(systemTexts(event).some((text) => text.includes("<xerj-corpus>"))).toBe(true);
    expect(systemTexts(event).some((text) => text.includes("<xerj-context>"))).toBe(false);
  });
});

describe("context hook", () => {
  test("injects a prepared block exactly once per message", async () => {
    const hooks = await register({
      search: fakeSearch({ hits: [{ path: "src/a.ts" }], text: "passage text", bytes: 10 }, []),
    });
    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m1"));

    const first = contextEvent("s1", "m1");
    await hooks.ctx.handlers.context(first);
    const second = contextEvent("s1", "m1");
    await hooks.ctx.handlers.context(second);

    expect(systemTexts(first).filter((text) => text.includes("<xerj-context>"))).toHaveLength(1);
    expect(systemTexts(second).filter((text) => text.includes("<xerj-context>"))).toHaveLength(0);
    expect(hooks.injections).toBe(1);
  });

  test("injects again for a new message", async () => {
    const hooks = await register({
      search: fakeSearch({ hits: [{ path: "src/a.ts" }], text: "passage text", bytes: 10 }, []),
    });
    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m1"));
    await hooks.ctx.handlers.context(contextEvent("s1", "m1"));

    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m2"));
    const second = contextEvent("s1", "m2");
    await hooks.ctx.handlers.context(second);
    expect(systemTexts(second).filter((text) => text.includes("<xerj-context>"))).toHaveLength(1);
    expect(hooks.injections).toBe(2);
  });

  test("summarises the corpus once per session", async () => {
    const hooks = await register();
    const events = [contextEvent("s1"), contextEvent("s1"), contextEvent("s1")];
    for (const event of events) await hooks.ctx.handlers.context(event);
    expect(systemTexts(events[0]).some((text) => text.includes("<xerj-corpus>"))).toBe(true);
    expect(events.slice(1).filter((event) => systemTexts(event).length > 0)).toHaveLength(0);
  });

  test("recovers the corpus summary after a failed first session", async () => {
    let fail = true;
    const hooks: Hooks = { ctx: fakeCtx(), activity: [], queries: [], injections: 0 };
    await registerSessionHooks(hooks.ctx as never, {
      config: DEFAULT_CONFIG,
      logger,
      getSearch: () => null,
      getMemory: () => null,
      summarize: async () => {
        if (fail) throw new Error("node is down");
        return "42 records";
      },
      onInject: () => {
        hooks.injections += 1;
      },
      recordQuery: async () => {},
    });

    const first = contextEvent("s1");
    await hooks.ctx.handlers.context(first);
    expect(systemTexts(first)).toEqual([]);

    fail = false;
    const second = contextEvent("s2");
    await hooks.ctx.handlers.context(second);
    expect(systemTexts(second).some((text) => text.includes("<xerj-corpus>"))).toBe(true);
  });
});

describe("memory recall", () => {
  test("injects recalled memories once, then dedupes them", async () => {
    const calls: Array<{ query: string; k: number }> = [];
    const hooks = await register({
      search: fakeSearch({ hits: [], text: "passage", bytes: 10 }, []),
      memory: fakeMemory(
        [{ id: "mem1", text: "Use RRF.", metadata: { kind: "decision" }, score: 1 }],
        calls,
      ),
    });

    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m1"));
    const first = contextEvent("s1", "m1");
    await hooks.ctx.handlers.context(first);
    expect(systemTexts(first).some((text) => text.includes("[mem 1]"))).toBe(true);

    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m2"));
    const second = contextEvent("s1", "m2");
    await hooks.ctx.handlers.context(second);
    expect(systemTexts(second).some((text) => text.includes("[mem 1]"))).toBe(false);
  });

  test("respects the configured recall limit", async () => {
    const calls: Array<{ query: string; k: number }> = [];
    const hooks = await register({
      search: fakeSearch({ hits: [], text: "passage", bytes: 10 }, []),
      memory: fakeMemory([], calls),
    });
    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG));
    expect(calls[0]?.k).toBe(3);
  });
});
