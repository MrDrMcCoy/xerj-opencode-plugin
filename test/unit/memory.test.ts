import { describe as group, describe, expect, test } from "bun:test";
import type { Logger } from "../../src/log.ts";
import type { XerjClient } from "../../src/node/client.ts";
import { formatMemories, MemoryStore, normalizeKind } from "../../src/memory/store.ts";

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

function store(namespace = "proj-test"): MemoryStore {
  return new MemoryStore({} as XerjClient, namespace, logger);
}

describe("normalizeKind", () => {
  test("accepts the known kinds", () => {
    expect(normalizeKind("decision")).toBe("decision");
    expect(normalizeKind("preference")).toBe("preference");
  });

  test("falls back to fact", () => {
    expect(normalizeKind(undefined)).toBe("fact");
    expect(normalizeKind("gossip")).toBe("fact");
  });
});

describe("memoryId", () => {
  test("is stable for the same text", () => {
    expect(store().memoryId("Use RRF.")).toBe(store().memoryId("Use RRF."));
  });

  test("ignores surrounding whitespace", () => {
    expect(store().memoryId("  Use RRF.  ")).toBe(store().memoryId("Use RRF."));
  });

  test("is namespace scoped", () => {
    expect(store("a").memoryId("x")).not.toBe(store("b").memoryId("x"));
  });
});

describe("formatMemories", () => {
  test("includes the kind and one line per memory", () => {
    const block = formatMemories(
      [
        { id: "1", text: "Use RRF client-side.", metadata: { kind: "decision" }, score: 1 },
        { id: "2", text: "Prefer tabs.", metadata: {}, score: 1 },
      ],
      500,
    );

    expect(block).toContain("[mem 1] (decision) Use RRF client-side.");
    expect(block).toContain("[mem 2] (note) Prefer tabs.");
    expect(block.startsWith("<xerj-memory>")).toBe(true);
    expect(block.endsWith("</xerj-memory>")).toBe(true);
  });

  test("stays inside the character budget", () => {
    const hits = Array.from({ length: 20 }, (_, index) => ({
      id: String(index),
      text: "x".repeat(100),
      metadata: { kind: "fact" },
      score: 1,
    }));

    const block = formatMemories(hits, 300);
    expect(block.length).toBeLessThan(420);
  });

  test("returns an empty string when nothing fits", () => {
    expect(
      formatMemories([{ id: "1", text: "long", metadata: {}, score: 1 }], 5),
    ).toBe("");
  });
});


interface StoreCall {
  namespace: string;
  body: { id?: string; text: string; metadata: Record<string, unknown> };
}

function clientWith(
  overrides: {
    storeResult?: { id: string; created: boolean };
    recallHits?: Array<unknown>;
    recallError?: Error;
    forgetResult?: boolean;
  } = {},
): { client: XerjClient; stores: StoreCall[]; recalls: Array<Record<string, unknown>> } {
  const stores: StoreCall[] = [];
  const recalls: Array<Record<string, unknown>> = [];
  const client = {
    memoryStore: async (namespace: string, body: StoreCall["body"]) => {
      stores.push({ namespace, body });
      return overrides.storeResult ?? { id: body.id ?? "", created: true };
    },
    memoryRecall: async (namespace: string, body: Record<string, unknown>) => {
      recalls.push(body);
      if (overrides.recallError) throw overrides.recallError;
      // The real client flattens; return the hits like XerjClient.memoryRecall.
      return overrides.recallHits ?? [];
    },
    memoryForget: async () => overrides.forgetResult ?? false,
  } as unknown as XerjClient;

  return { client, stores, recalls };
}

group("MemoryStore.remember", () => {
  test("stores under the namespace with a stable id and metadata", async () => {
    const { client, stores } = clientWith({ storeResult: { id: "abc", created: true } });
    const store = new MemoryStore(client, "proj-test", logger);

    const result = await store.remember({ text: " Use RRF. ", kind: "decision", topic: "search" });
    expect(result).toEqual({ id: "abc", created: true });
    expect(stores[0]!.namespace).toBe("proj-test");
    expect(stores[0]!.body.id).toBe(store.memoryId("Use RRF."));
    expect(stores[0]!.body.text).toBe("Use RRF.");
    expect(stores[0]!.body.metadata).toMatchObject({
      kind: "decision",
      source: "opencode-xerj-plugin",
      topic: "search",
    });
  });

  test("omits topic and session metadata when absent", async () => {
    const { client, stores } = clientWith();
    const store = new MemoryStore(client, "proj-test", logger);
    await store.remember({ text: "fact" });
    expect(Object.keys(stores[0]!.body.metadata).sort()).toEqual([
      "created",
      "kind",
      "source",
    ]);
  });

  test("normalizes an unknown kind to fact", async () => {
    const { client, stores } = clientWith();
    const store = new MemoryStore(client, "proj-test", logger);
    await store.remember({ text: "fact", kind: "gossip" });
    expect(stores[0]!.body.metadata.kind).toBe("fact");
  });
});

group("MemoryStore.recall", () => {
  test("asks with the recency weight", async () => {
    const { client, recalls } = clientWith({
      recallHits: [{ id: "1", text: "a", metadata: {}, score: 0.5 }],
    });
    const store = new MemoryStore(client, "proj-test", logger);
    const hits = await store.recall("how is fusion done?", 5);
    expect(recalls[0]).toMatchObject({
      query: "how is fusion done?",
      k: 5,
      recency_weight: 0.2,
    });
    expect(hits).toHaveLength(1);
  });

  test("answers an empty query without calling the node", async () => {
    const { client, recalls } = clientWith();
    const store = new MemoryStore(client, "proj-test", logger);
    expect(await store.recall("   ")).toEqual([]);
    expect(recalls).toHaveLength(0);
  });

  test("degrades to no memories when the node fails", async () => {
    const { client } = clientWith({ recallError: new Error("node is down") });
    const store = new MemoryStore(client, "proj-test", logger);
    expect(await store.recall("query")).toEqual([]);
  });
});

group("MemoryStore.forget", () => {
  test("passes the retraction through", async () => {
    const { client } = clientWith({ forgetResult: true });
    const store = new MemoryStore(client, "proj-test", logger);
    expect(await store.forget("abc")).toBe(true);
  });
});
