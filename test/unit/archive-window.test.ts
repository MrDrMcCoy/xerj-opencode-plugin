import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnArchive } from "../../src/archive/turns.ts";
import {
  MAX_WINDOW_MESSAGES,
  captureWindow,
  registerCompactionArchive,
} from "../../src/archive/window.ts";
import type { Logger } from "../../src/log.ts";

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "xerj-window-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

let counter = 0;

function archive(maxBytes?: number): TurnArchive {
  counter += 1;
  return new TurnArchive({
    directory: join(root, `sessions-${counter}`),
    logger,
    maxBytes,
  });
}

function message(
  id: string | undefined,
  role: string,
  content: ReadonlyArray<unknown>,
): unknown {
  return { id, role, content };
}

function text(value: string): unknown {
  return { type: "text", text: value };
}

const NOTHING = new Set<string>();

describe("captureWindow", () => {
  test("keeps text and tool output in conversation order", () => {
    const window = captureWindow({
      seen: NOTHING,
      messages: [
        message("m1", "user", [text("where is the journal?")]),
        message("m2", "assistant", [
          { type: "reasoning", text: "private chain" },
          text("it is under the node dir"),
        ]),
        message("m3", "tool", [
          { type: "tool-result", result: { type: "text", text: "node.pid" } },
        ]),
      ],
    });

    expect(window.records.map((record) => record.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(window.records[0]?.text).toBe("where is the journal?");
    expect(window.records[1]?.text).toBe("it is under the node dir");
    expect(window.records[2]?.text).toBe("node.pid");
    expect(window.ids).toEqual(["m1", "m2", "m3"]);
    expect(window.bytes).toBeGreaterThan(0);
  });

  test("skips media, reasoning, compaction markers and malformed parts", () => {
    const window = captureWindow({
      seen: NOTHING,
      messages: [
        message("m1", "user", [
          { type: "media", media: { source: { type: "url", url: "x" } } },
          { type: "compaction" },
          { type: "effort" },
          null,
          text("kept"),
        ]),
        { id: "bad", role: "narrator", content: [text("nope")] },
        { id: "empty", role: "user", content: "not an array" },
      ],
    });

    expect(window.records).toHaveLength(1);
    expect(window.records[0]?.text).toBe("kept");
  });

  test("skips ids already captured", () => {
    const seen = new Set(["m1"]);
    const window = captureWindow({
      seen,
      messages: [
        message("m1", "user", [text("already stored")]),
        message("m2", "assistant", [text("new")]),
      ],
    });

    expect(window.records.map((record) => record.text)).toEqual(["new"]);
    expect(window.ids).toEqual(["m2"]);
  });

  test("derives an id when the host supplies none", () => {
    const first = captureWindow({
      seen: NOTHING,
      messages: [message(undefined, "user", [text("same text")])],
    });
    const second = captureWindow({
      seen: new Set(first.ids),
      messages: [message(undefined, "user", [text("same text")])],
    });

    expect(first.ids).toHaveLength(1);
    expect(second.records).toEqual([]);
  });

  test("keeps the newest messages up to the limit", () => {
    const messages = Array.from({ length: MAX_WINDOW_MESSAGES + 5 }, (_, index) =>
      message(`m${index}`, "user", [text(`msg ${index}`)]),
    );

    const window = captureWindow({ seen: NOTHING, messages });

    expect(window.records).toHaveLength(MAX_WINDOW_MESSAGES);
    expect(window.records[0]?.text).toBe("msg 5");
    expect(window.records.at(-1)?.text).toBe(`msg ${MAX_WINDOW_MESSAGES + 4}`);
  });

  test("clips an oversized message instead of dropping it", () => {
    const window = captureWindow({
      seen: NOTHING,
      messages: [message("m1", "assistant", [text("x".repeat(4000))])],
      maxBytes: 100,
    });

    expect(window.records).toHaveLength(1);
    expect(window.bytes).toBeLessThanOrEqual(100);
  });

  test("fills the byte budget with a clipped older message", () => {
    const window = captureWindow({
      seen: NOTHING,
      messages: [
        message("m1", "user", [text("a".repeat(80))]),
        message("m2", "user", [text("b".repeat(80))]),
      ],
      maxBytes: 90,
    });

    expect(window.bytes).toBe(90);
    expect(window.records.map((record) => record.text)).toEqual([
      "a".repeat(10),
      "b".repeat(80),
    ]);
  });
});

describe("registerCompactionArchive", () => {
  let handlers: Record<string, (event: unknown) => Promise<void>>;
  let warns: string[];

  beforeEach(() => {
    handlers = {};
    warns = [];
  });

  function ctx(): unknown {
    return {
      session: {
        hook: async (name: string, handler: (event: unknown) => Promise<void>) => {
          handlers[name] = handler;
        },
      },
    };
  }

  test("writes the window once, behind a marker", async () => {
    const store = archive();
    await registerCompactionArchive(ctx() as never, {
      archive: store,
      logger: { ...logger, debug: (message) => warns.push(message) },
    });

    const event = {
      sessionID: "ses_1",
      messages: [
        message("m1", "user", [text("the question")]),
        message("m2", "assistant", [text("the answer")]),
      ],
    };
    await handlers.compaction!(event);

    const expanded = await store.expand("ses_1", 1, 10);
    expect(expanded.total).toBe(3);
    expect(expanded.turns[0]?.role).toBe("system");
    expect(expanded.turns[0]?.text).toContain("2 earlier messages");
    expect(expanded.turns[1]?.text).toBe("the question");
    expect(expanded.turns[2]?.text).toBe("the answer");

    // A retried compaction sees the same ids and appends nothing.
    await handlers.compaction!(event);
    expect((await store.expand("ses_1", 1, 10)).total).toBe(3);
  });

  test("ignores a session this instance does not own", async () => {
    const store = archive();
    await registerCompactionArchive(ctx() as never, {
      archive: store,
      logger,
      owns: (sessionID) => sessionID === "ses_mine",
    });

    await handlers.compaction!({
      sessionID: "ses_other",
      messages: [message("m1", "user", [text("not ours")])],
    });

    expect((await store.expand("ses_other", 1, 10)).total).toBe(0);
  });

  test("a failed write is logged and never thrown", async () => {
    const store = archive();
    const failing = {
      appendBatch: async () => {
        throw new Error("disk full");
      },
    } as unknown as TurnArchive;
    const messages: string[] = [];
    await registerCompactionArchive(ctx() as never, {
      archive: failing,
      logger: { ...logger, debug: (message) => messages.push(message) },
    });

    await handlers.compaction!({
      sessionID: "ses_1",
      messages: [message("m1", "user", [text("text")])],
    });

    expect(messages).toContain("could not archive the pre-compaction window");
  });

  test("captures nothing from an empty window", async () => {
    const store = archive();
    await registerCompactionArchive(ctx() as never, { archive: store, logger });

    await handlers.compaction!({ sessionID: "ses_1", messages: [] });
    expect((await store.expand("ses_1", 1, 10)).total).toBe(0);
  });
});
