import { describe, expect, test } from "bun:test";
import {
  formatContextBlock,
  formatCorpusBlock,
  formatHintBlock,
  registerSessionHooks,
  shouldRetrieve,
} from "../../src/hooks/session.ts";
import { DEFAULT_CONFIG, type Config } from "../../src/config.ts";
import type { Logger } from "../../src/log.ts";
import type { SearchService } from "../../src/search/service.ts";
import type { MemoryStore } from "../../src/memory/store.ts";
import { NoteStore } from "../../src/notes/store.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("shouldRetrieve", () => {
  test("skips slash commands", () => {
    expect(shouldRetrieve("/xerj-reindex")).toBe(false);
  });

  test("skips short replies", () => {
    expect(shouldRetrieve("begin")).toBe(false);
    expect(shouldRetrieve("yes, do it")).toBe(false);
  });

  test("skips long prompts made of filler", () => {
    expect(shouldRetrieve("please continue with that, thanks")).toBe(false);
    expect(shouldRetrieve("ok go ahead and do the same again")).toBe(false);
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

type HookName = "prompt" | "context" | "model.request";

interface FakeCtx {
  handlers: Record<HookName, Handler>;
  /** Delivers one host event to whatever subscribed. */
  push(type: string, data: unknown): void;
  session: {
    hook(name: string, handler: Handler): Promise<void>;
  };
  event: {
    subscribe(options?: unknown): AsyncIterable<unknown>;
  };
}

function fakeCtx(): FakeCtx {
  const handlers: Record<string, Handler> = {};
  const queue: Array<unknown> = [];
  let notify: (() => void) | null = null;

  async function* stream(): AsyncIterable<unknown> {
    for (;;) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      notify = null;
      while (queue.length > 0) yield queue.shift();
    }
  }

  return {
    handlers,
    push: (type, data) => {
      queue.push({ type, data });
      notify?.();
    },
    session: {
      hook: async (name, handler) => {
        handlers[name] = handler;
      },
    },
    event: { subscribe: () => stream() },
  };
}

/** Waits for the detached compaction watch to consume a queued event. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
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
      const hits = result.hits.map((hit, index) => ({
        index: "i",
        id: String(index),
        passage: 0,
        path: hit.path,
        line: 1,
        title: null,
        kind: null,
        score: 1,
        text: "passage",
      }));
      // Mirror the service: an excluded hit is never rendered.
      const exclude = options.exclude as ((hit: unknown) => boolean) | undefined;
      const kept = exclude ? hits.filter((hit) => !exclude(hit)) : hits;
      if (kept.length === hits.length) {
        return {
          hits,
          text: result.text,
          bytes: result.bytes,
          strategy: "hybrid" as const,
          narrowingBytes: 0,
        };
      }
      const text = kept
        .map((hit, index) => `[${index + 1}] ${hit.path ?? hit.index}:${hit.line}`)
        .join("\n\n");
      return {
        hits: kept,
        text,
        bytes: Buffer.byteLength(text, "utf8"),
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
  costs?: number[];
  prompts?: Array<{ sessionID: string; text: string }>;
  noiseSkips: number;
}

async function register(
  overrides: {
    config?: Partial<Config["context"]>;
    search?: SearchService;
    memory?: MemoryStore;
    notes?: NoteStore;
    projectRoot?: string;
    readRecallFile?: (path: string) => Promise<string | null>;
  } = {},
): Promise<Hooks> {
  const hooks: Hooks = {
    ctx: fakeCtx(),
    activity: [],
    queries: [],
    injections: 0,
    costs: [],
    prompts: [],
    noiseSkips: 0,
  };

  await registerSessionHooks(hooks.ctx as never, {
    config: { ...DEFAULT_CONFIG, context: { ...DEFAULT_CONFIG.context, ...overrides.config } },
    logger,
    getSearch: () => overrides.search ?? null,
    getMemory: () => overrides.memory ?? null,
    getNotes: () => overrides.notes ?? null,
    summarize: async () => "42 records, watching",
    onActivity: (sessionID) => {
      hooks.activity.push(sessionID);
    },
    onInject: () => {
      hooks.injections += 1;
    },
    onCost: (_sessionID, bytes) => {
      hooks.costs!.push(bytes);
    },
    onPrompt: (sessionID, text) => {
      hooks.prompts!.push({ sessionID, text });
    },
    onNoiseSkip: () => {
      hooks.noiseSkips += 1;
    },
    recordQuery: async (sessionID, paths, bytes, hits) => {
      hooks.queries.push({ sessionID, paths: [...paths], bytes, hits });
    },
    projectRoot: overrides.projectRoot,
    readRecallFile: overrides.readRecallFile,
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

  test("registers the prompt, context and model-request hooks", async () => {
    const hooks = await register();
    expect(Object.keys(hooks.ctx.handlers).sort()).toEqual([
      "context",
      "model.request",
      "prompt",
    ]);
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

  test("a new passage still injects after an earlier one", async () => {
    let turn = 0;
    const search = {
      search: async () => {
        turn += 1;
        const path = turn === 1 ? "src/a.ts" : "src/b.ts";
        const text = `[1] ${path}:1\ncode`;
        return {
          hits: [
            {
              index: "i",
              id: String(turn),
              passage: 0,
              path,
              line: 1,
              title: null,
              kind: null,
              score: 1,
              text: "passage",
            },
          ],
          text,
          bytes: Buffer.byteLength(text, "utf8"),
          strategy: "hybrid" as const,
          narrowingBytes: 0,
        };
      },
    } as unknown as SearchService;
    const hooks = await register({ search });
    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m1"));
    await hooks.ctx.handlers.context(contextEvent("s1", "m1"));
    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m2"));
    await hooks.ctx.handlers.context(contextEvent("s1", "m2"));
    expect(hooks.injections).toBe(2);
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

  test("counts a prompt whose passages the gate dropped as noise", async () => {
    const hooks = await register({ search: fakeSearch({ hits: [], text: "", bytes: 0 }, []) });
    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG));
    expect(hooks.noiseSkips).toBe(1);
    expect(hooks.injections).toBe(0);
  });

  test("does not count a real hit as noise", async () => {
    const hooks = await register({
      search: fakeSearch({ hits: [{ path: "src/a.ts" }], text: "[1] src/a.ts:1", bytes: 40 }, []),
    });
    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG));
    expect(hooks.noiseSkips).toBe(0);
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

  test("does not repeat a passage already in the session's context", async () => {
    const hooks = await register({
      search: fakeSearch({ hits: [{ path: "src/a.ts" }], text: "passage text", bytes: 10 }, []),
    });
    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m1"));
    await hooks.ctx.handlers.context(contextEvent("s1", "m1"));

    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m2"));
    const second = contextEvent("s1", "m2");
    await hooks.ctx.handlers.context(second);
    expect(systemTexts(second).filter((text) => text.includes("<xerj-context>"))).toHaveLength(0);
    expect(hooks.injections).toBe(1);
  });

  test("forgets the oldest session once the tracking cap is reached", async () => {
    const hooks = await register({
      search: fakeSearch({ hits: [{ path: "src/a.ts" }], text: "passage text", bytes: 10 }, []),
    });
    await hooks.ctx.handlers.prompt(promptEvent("s0", LONG, "m1"));
    await hooks.ctx.handlers.context(contextEvent("s0", "m1"));
    expect(hooks.injections).toBe(1);

    for (let i = 1; i <= 210; i += 1) {
      const id = `s${i}`;
      await hooks.ctx.handlers.prompt(promptEvent(id, LONG, "m1"));
      await hooks.ctx.handlers.context(contextEvent(id, "m1"));
    }

    // The first session aged out, so its passage counts as new again.
    await hooks.ctx.handlers.prompt(promptEvent("s0", LONG, "m2"));
    await hooks.ctx.handlers.context(contextEvent("s0", "m2"));
    expect(hooks.injections).toBe(212);
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
    const hooks: Hooks = {
      ctx: fakeCtx(),
      activity: [],
      queries: [],
      injections: 0,
      noiseSkips: 0,
    };
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
    // The command-output instruction is added on the first call regardless.
    expect(
      systemTexts(first).filter((text) => !text.includes("<xerj-command-output>")),
    ).toEqual([]);

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
        [
          {
            id: "mem1",
            text: "The watcher stores its journal state under the node dir.",
            metadata: { kind: "decision" },
            score: 1,
          },
        ],
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

  test("does not inject a memory unrelated to the prompt", async () => {
    const hooks = await register({
      memory: fakeMemory(
        [{ id: "mem1", text: "Use RRF.", metadata: { kind: "decision" }, score: 1 }],
        [],
      ),
    });
    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m1"));
    const event = contextEvent("s1", "m1");
    await hooks.ctx.handlers.context(event);
    expect(systemTexts(event).some((text) => text.includes("[mem 1]"))).toBe(false);
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

describe("cost accounting", () => {
  test("charges only the overhead beyond passages already counted as returned", async () => {
    const text = "[1] src/a.ts:3\ncode";
    const hooks = await register({
      search: fakeSearch({ hits: [{ path: "src/a.ts" }], text, bytes: Buffer.byteLength(text) }, []),
    });
    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m1"));
    const event = contextEvent("s1", "m1");
    await hooks.ctx.handlers.context(event);

    const block = systemTexts(event).find((part) => part.includes("<xerj-context>"))!;
    const summary = systemTexts(event).find((part) => part.includes("<xerj-corpus>"))!;
    const command = systemTexts(event).find((part) =>
      part.includes("<xerj-command-output>"),
    )!;
    const overhead = Buffer.byteLength(block) - Buffer.byteLength(text);
    expect(hooks.costs).toEqual([
      Buffer.byteLength(summary),
      Buffer.byteLength(command),
      overhead,
    ]);
  });
});

describe("prompt reporting", () => {
  test("reports substantive prompts and skips filler", async () => {
    const hooks = await register();
    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG));
    await hooks.ctx.handlers.prompt(promptEvent("s1", "please continue"));
    expect(hooks.prompts).toEqual([{ sessionID: "s1", text: LONG }]);
  });
});

describe("compaction and injection dedupe", () => {
  function passage(): { hits: Array<{ path: string }>; text: string; bytes: number } {
    return { hits: [{ path: "src/a.ts" }], text: "[1] src/a.ts:1\ncode", bytes: 10 };
  }

  function excluded(call: SearchCall | undefined): boolean {
    const exclude = call?.options.exclude as ((hit: unknown) => boolean) | undefined;
    return exclude === undefined
      ? false
      : exclude({ path: "src/a.ts", line: 1, index: "i" });
  }

  test("a passage is deduped until the host compacts", async () => {
    const calls: SearchCall[] = [];
    const hooks = await register({ search: fakeSearch(passage(), calls) });

    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m1"));
    await hooks.ctx.handlers.context(contextEvent("s1", "m1"));
    expect(hooks.injections).toBe(1);

    // Second turn: the same location is already in context.
    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m2"));
    expect(excluded(calls[1])).toBe(true);

    // The host compacts, so the passage may be gone from the window.
    hooks.ctx.push("session.compaction.ended", { sessionID: "s1" });
    await settle();

    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m3"));
    // The hint pass for the deduped turn also lands in `calls`, so the last
    // entry is the one that matters.
    expect(excluded(calls.at(-1))).toBe(false);
  });

  test("another session's compaction leaves this one deduped", async () => {
    const calls: SearchCall[] = [];
    const hooks = await register({ search: fakeSearch(passage(), calls) });

    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m1"));
    await hooks.ctx.handlers.context(contextEvent("s1", "m1"));

    hooks.ctx.push("session.compaction.ended", { sessionID: "s2" });
    await settle();

    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m2"));
    expect(excluded(calls.at(-1))).toBe(true);
  });

  test("an event without a session id changes nothing", async () => {
    const calls: SearchCall[] = [];
    const hooks = await register({ search: fakeSearch(passage(), calls) });

    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m1"));
    await hooks.ctx.handlers.context(contextEvent("s1", "m1"));

    hooks.ctx.push("session.compaction.ended", {});
    await settle();

    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m2"));
    expect(excluded(calls.at(-1))).toBe(true);
  });

  test("restores the working set once after a compaction", async () => {
    const reads: string[] = [];
    const hooks = await register({
      search: fakeSearch(passage(), []),
      projectRoot: "/project",
      readRecallFile: async (path) => {
        reads.push(path);
        return "const journal = 'node';\nmore text";
      },
    });

    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m1"));
    await hooks.ctx.handlers.context(contextEvent("s1", "m1"));
    expect(hooks.injections).toBe(1);

    hooks.ctx.push("session.compaction.ended", { sessionID: "s1" });
    await settle();

    // The summarised continuation has no new prompt, so the context call is
    // the only chance to put the working set back.
    const recalled = contextEvent("s1", "m2");
    await hooks.ctx.handlers.context(recalled);
    const texts = systemTexts(recalled);
    const block = texts.find((text) => text.includes("<xerj-recall>"));
    expect(block).toBeDefined();
    expect(block).toContain("src/a.ts:1");
    expect(block).toContain("const journal");
    expect(hooks.injections).toBe(2);
    expect(hooks.costs?.at(-1)).toBe(Buffer.byteLength(block!));
    expect(reads).toEqual(["/project/src/a.ts"]);

    // Once only: the next call has nothing left to restore.
    const again = contextEvent("s1", "m3");
    await hooks.ctx.handlers.context(again);
    expect(
      systemTexts(again).some((text) => text.includes("<xerj-recall>")),
    ).toBe(false);
    expect(hooks.injections).toBe(2);
  });

  test("a fresh retrieval supersedes the pre-compaction set", async () => {
    const hooks = await register({
      search: fakeSearch(passage(), []),
      projectRoot: "/project",
      readRecallFile: async () => "old passage",
    });

    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m1"));
    await hooks.ctx.handlers.context(contextEvent("s1", "m1"));

    hooks.ctx.push("session.compaction.ended", { sessionID: "s1" });
    await settle();

    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m2"));
    const event = contextEvent("s1", "m2");
    await hooks.ctx.handlers.context(event);

    const texts = systemTexts(event);
    expect(texts.some((text) => text.includes("<xerj-context>"))).toBe(true);
    expect(texts.some((text) => text.includes("<xerj-recall>"))).toBe(false);
  });

  test("the summariser's own request receives no recall", async () => {
    const hooks = await register({
      search: fakeSearch(passage(), []),
      projectRoot: "/project",
      readRecallFile: async () => "restored passage",
    });

    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m1"));
    await hooks.ctx.handlers.context(contextEvent("s1", "m1"));

    hooks.ctx.push("session.compaction.ended", { sessionID: "s1" });
    await settle();

    await hooks.ctx.handlers["model.request"]({
      sessionID: "s1",
      kind: "compaction",
    });
    const summariser = contextEvent("s1", "m2");
    await hooks.ctx.handlers.context(summariser);
    expect(systemTexts(summariser)).toEqual([]);

    // The agent loop clears the suppression and gets the recall.
    await hooks.ctx.handlers["model.request"]({
      sessionID: "s1",
      kind: "primary",
    });
    const resumed = contextEvent("s1", "m3");
    await hooks.ctx.handlers.context(resumed);
    expect(
      systemTexts(resumed).some((text) => text.includes("<xerj-recall>")),
    ).toBe(true);
  });

  test("a slow read is dropped instead of delaying the turn", async () => {
    const hooks = await register({
      search: fakeSearch(passage(), []),
      projectRoot: "/project",
      readRecallFile: () => new Promise<string | null>(() => {}),
    });

    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m1"));
    await hooks.ctx.handlers.context(contextEvent("s1", "m1"));

    hooks.ctx.push("session.compaction.ended", { sessionID: "s1" });
    await settle();

    const started = Date.now();
    const event = contextEvent("s1", "m2");
    await hooks.ctx.handlers.context(event);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(
      systemTexts(event).some((text) => text.includes("<xerj-recall>")),
    ).toBe(false);
  });

  test("does not restore anything when context.rehydrate is off", async () => {
    const hooks = await register({
      config: { rehydrate: false },
      search: fakeSearch(passage(), []),
      projectRoot: "/project",
      readRecallFile: async () => "restored passage",
    });

    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m1"));
    await hooks.ctx.handlers.context(contextEvent("s1", "m1"));

    hooks.ctx.push("session.compaction.ended", { sessionID: "s1" });
    await settle();

    const event = contextEvent("s1", "m2");
    await hooks.ctx.handlers.context(event);
    expect(
      systemTexts(event).some((text) => text.includes("<xerj-recall>")),
    ).toBe(false);
    expect(hooks.injections).toBe(1);
  });
});

describe("auto-search hint", () => {
  function hintSearch(): { search: SearchService; calls: SearchCall[] } {
    const calls: SearchCall[] = [];
    const search = {
      search: async (query: string, options: Record<string, unknown> = {}) => {
        calls.push({ query, options });
        // The gate drops the passage; the relaxed hint pass keeps it.
        const hits =
          options.hint === true
            ? [{ index: "i", id: "h", passage: 0, path: "src/b.ts", line: 7, title: null, kind: null, score: 1, text: "loose" }]
            : [];
        const text = hits.length > 0 ? "[1] src/b.ts:7" : "";
        return {
          hits,
          text,
          bytes: Buffer.byteLength(text, "utf8"),
          strategy: "lexical" as const,
          narrowingBytes: 0,
        };
      },
    } as unknown as SearchService;
    return { search, calls };
  }

  test("a dropped prompt injects one line instead of nothing", async () => {
    const { search, calls } = hintSearch();
    const hooks = await register({ search });

    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m1"));
    const event = contextEvent("s1", "m1");
    await hooks.ctx.handlers.context(event);

    const body = systemTexts(event).join("\n");
    expect(body).toContain("<xerj-hint>");
    expect(body).toContain("src/b.ts:7");
    expect(body).toContain("xerj_search");
    expect(body).not.toContain("<xerj-context>");
    expect(hooks.injections).toBe(1);
    expect(hooks.noiseSkips).toBe(0);
    expect(calls.some((call) => call.options.hint === true)).toBe(true);
  });

  test("no candidate means the prompt is counted as noise", async () => {
    const search = {
      search: async () => ({ hits: [], text: "", bytes: 0, strategy: "lexical", narrowingBytes: 0 }),
    } as unknown as SearchService;
    const hooks = await register({ search });

    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m1"));

    expect(hooks.noiseSkips).toBe(1);
  });

  test("a matching note is injected once per session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xerj-hooks-notes-"));
    const notes = new NoteStore({ directory, logger });
    await notes.add({
      text: "Check the watcher journal before touching the state file.",
      conditions: ["watcher", "journal"],
    });
    const hooks = await register({ notes });

    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m1"));
    const first = contextEvent("s1", "m1") as {
      system: Array<{ type: string; text: string }>;
    };
    await hooks.ctx.handlers.context(first);
    expect(first.system.map((part) => part.text).join("\n")).toContain("<xerj-note>");

    await hooks.ctx.handlers.prompt(promptEvent("s1", LONG, "m2"));
    const second = contextEvent("s1", "m2") as {
      system: Array<{ type: string; text: string }>;
    };
    await hooks.ctx.handlers.context(second);
    expect(second.system.map((part) => part.text).join("\n")).not.toContain(
      "<xerj-note>",
    );
    await rm(directory, { recursive: true, force: true });
  });

  test("the hint block stays one line and names the prompt", () => {
    const block = formatHintBlock({ path: "src/a.ts", line: 12, index: "i" }, "where is the watcher");

    expect(block).toContain("src/a.ts:12");
    expect(block).toContain("where is the watcher");
    expect(block.split("\n")).toHaveLength(4);
  });
});
