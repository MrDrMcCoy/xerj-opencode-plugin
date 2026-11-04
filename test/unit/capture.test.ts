import { describe, expect, test } from "bun:test";
import { startCompactionCapture } from "../../src/memory/capture.ts";
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
  seen: Array<{ text: string; kind?: string }>;
} {
  const seen: Array<{ text: string; kind?: string }> = [];
  const store = {
    remember: async (input: { text: string; kind?: string }) => {
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
