import { describe, expect, test } from "bun:test";
import {
  SessionPrompts,
  startCompactionCapture,
  startTurnCapture,
} from "../../src/memory/capture.ts";
import type { MemoryStore } from "../../src/memory/store.ts";

const longText = "Summary of the session. ".repeat(20);
const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: () => [],
  flush: async () => {},
} as never;

function stubStore(): {
  store: MemoryStore;
  seen: Array<{ text: string; kind?: string; topic?: string }>;
} {
  const seen: Array<{ text: string; kind?: string; topic?: string }> = [];
  const store = {
    remember: async (input: { text: string; kind?: string; topic?: string }) => {
      seen.push(input);
      return { id: "id", created: true };
    },
  } as unknown as MemoryStore;
  return { store, seen };
}

/** Emits the given events, then waits for a shutdown signal to settle. */
function stubEvents(events: unknown[]): {
  subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<unknown>;
} {
  return {
    subscribe: async function* (options) {
      for (const event of events) yield event;
      // Keep the stream open until the caller aborts, like the real stream.
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) return resolve();
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("compaction capture", () => {
  test("stores a long summary as a summary memory", async () => {
    const { store, seen } = stubStore();
    const controller = new AbortController();

    startCompactionCapture({
      events: stubEvents([
        {
          type: "session.compaction.ended",
          data: { sessionID: "ses_1", reason: "auto", text: longText },
        },
      ]),
      memory: store,
      signal: controller.signal,
      logger,
    });
    await settle();
    controller.abort();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("summary");
    expect(seen[0]?.text.length).toBeGreaterThan(100);
  });

  test("ignores a short summary", async () => {
    const { store, seen } = stubStore();
    const controller = new AbortController();

    startCompactionCapture({
      events: stubEvents([
        {
          type: "session.compaction.ended",
          data: { sessionID: "ses_1", reason: "auto", text: "short" },
        },
      ]),
      memory: store,
      signal: controller.signal,
      logger,
    });
    await settle();
    controller.abort();

    expect(seen).toEqual([]);
  });

  test("ignores other event types and clips long text", async () => {
    const { store, seen } = stubStore();
    const controller = new AbortController();

    startCompactionCapture({
      events: stubEvents([
        { type: "session.idle", data: { text: longText } },
        {
          type: "session.compaction.ended",
          data: { sessionID: "ses_2", reason: "manual", text: longText.repeat(20) },
        },
      ]),
      memory: store,
      signal: controller.signal,
      logger,
      maxChars: 200,
    });
    await settle();
    controller.abort();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.text.length).toBe(200);
  });
});

describe("compaction capture scope", () => {
  test("skips a compaction from a session this instance never saw", async () => {
    const { store, seen } = stubStore();
    const controller = new AbortController();
    const prompts = new SessionPrompts();
    prompts.note("ses_mine", "how is the watcher started");

    startCompactionCapture({
      events: stubEvents([
        { type: "session.compaction.ended", data: { sessionID: "ses_other", text: longText } },
        { type: "session.compaction.ended", data: { sessionID: "ses_mine", text: longText } },
      ]),
      memory: store,
      signal: controller.signal,
      logger,
      owns: (sessionID) => prompts.knows(sessionID),
    });
    await settle();
    controller.abort();

    expect(seen).toHaveLength(1);
  });
});

describe("turn capture", () => {
  const answer = "The watcher claims ownership before the first pass. ".repeat(12);

  function run(events: unknown[], prompts: SessionPrompts) {
    const { store, seen } = stubStore();
    const controller = new AbortController();
    startTurnCapture({ events: stubEvents(events), memory: store, signal: controller.signal, logger, prompts });
    return { seen, stop: () => controller.abort() };
  }

  test("stores the final answer of a substantive turn with its prompt", async () => {
    const prompts = new SessionPrompts();
    prompts.note("ses_1", "how does the watcher claim ownership");
    const { seen, stop } = run(
      [
        { type: "session.text.ended", data: { sessionID: "ses_1", text: "Reading the code." } },
        { type: "session.text.ended", data: { sessionID: "ses_1", text: answer } },
        { type: "session.execution.succeeded", data: { sessionID: "ses_1" } },
      ],
      prompts,
    );
    await settle();
    stop();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("summary");
    expect(seen[0]?.topic).toBe("how does the watcher claim ownership");
    expect(seen[0]?.text.startsWith("Q: how does the watcher claim ownership\nA: The watcher")).toBe(true);
  });

  test("skips short answers, unknown sessions, and turns without text", async () => {
    const prompts = new SessionPrompts();
    prompts.note("ses_1", "how does the watcher claim ownership");
    const { seen, stop } = run(
      [
        { type: "session.text.ended", data: { sessionID: "ses_1", text: "Done." } },
        { type: "session.execution.succeeded", data: { sessionID: "ses_1" } },
        { type: "session.text.ended", data: { sessionID: "ses_x", text: answer } },
        { type: "session.execution.succeeded", data: { sessionID: "ses_x" } },
        { type: "session.execution.succeeded", data: { sessionID: "ses_1" } },
      ],
      prompts,
    );
    await settle();
    stop();

    expect(seen).toEqual([]);
  });

  test("clips the stored answer", async () => {
    const prompts = new SessionPrompts();
    prompts.note("ses_1", "how does the watcher claim ownership");
    const { seen, stop } = run(
      [
        { type: "session.text.ended", data: { sessionID: "ses_1", text: answer.repeat(20) } },
        { type: "session.execution.succeeded", data: { sessionID: "ses_1" } },
      ],
      prompts,
    );
    await settle();
    stop();

    expect(seen[0]!.text.length).toBeLessThanOrEqual(1700);
  });
});

describe("SessionPrompts", () => {
  test("keeps the latest prompt and forgets the oldest sessions past the cap", () => {
    const prompts = new SessionPrompts(2);
    prompts.note("a", "first");
    prompts.note("a", "second");
    prompts.note("b", "x");
    prompts.note("c", "y");
    expect(prompts.knows("a")).toBe(false);
    expect(prompts.latest("b")).toBe("x");
    expect(prompts.latest("c")).toBe("y");
  });
});
