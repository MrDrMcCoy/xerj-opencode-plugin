import { afterEach, describe, expect, test } from "bun:test";
import {
  NodeRequestError,
  parseSize,
  XerjClient,
  type ClientResolver,
} from "../../src/node/client.ts";

describe("parseSize", () => {
  test("parses the units _cat/indices emits", () => {
    expect(parseSize("0b")).toBe(0);
    expect(parseSize("42.7kb")).toBe(Math.round(42.7 * 1024));
    expect(parseSize("1.2mb")).toBe(Math.round(1.2 * 1024 ** 2));
    expect(parseSize("2gb")).toBe(2 * 1024 ** 3);
  });

  test("treats a bare number as bytes", () => {
    expect(parseSize("512")).toBe(512);
  });

  test("returns zero for unknown input", () => {
    expect(parseSize(undefined)).toBe(0);
    expect(parseSize("")).toBe(0);
    expect(parseSize("lots")).toBe(0);
  });
});

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

function response(
  status: number,
  body: unknown,
  options: { textBody?: string } = {},
): FakeResponse {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    json: async () => body,
    text: async () => options.textBody ?? JSON.stringify(body),
  };
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

type FetchBehavior = (url: string, init: RequestInit | undefined) => Promise<FakeResponse>;

const realFetch = globalThis.fetch;
const calls: FetchCall[] = [];
let behave: FetchBehavior = async () => response(200, {});

function stubFetch(behavior?: FetchBehavior): void {
  if (behavior) behave = behavior;
  globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
    const urlText = String(url);
    calls.push({ url: urlText, init });
    return behave(urlText, init);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  calls.length = 0;
  behave = async () => response(200, {});
});

function client(
  overrides: { timeout?: number; observer?: (status: number) => void; resolver?: ClientResolver } = {},
): XerjClient {
  return new XerjClient("http://127.0.0.1:9200", {
    timeoutMs: overrides.timeout,
    observer: overrides.observer && { onResponse: overrides.observer },
    resolver: overrides.resolver,
  });
}

describe("request paths", () => {
  // A caller that names an index without a leading slash used to build
  // `http://127.0.0.1:9200xop-...`, which fetch rejects as an invalid URL and
  // the caller's catch reported as "already present".
  test("a path without a leading slash targets the root", async () => {
    stubFetch();
    await client().put("xop-test-docs", { mappings: {} }, "could not create the index");
    expect(calls[0]?.url).toBe("http://127.0.0.1:9200/xop-test-docs");
  });

  test("a path with a leading slash is unchanged", async () => {
    stubFetch();
    await client().put("/_ml/anomaly_detectors/job", {}, "could not create the detector");
    expect(calls[0]?.url).toBe("http://127.0.0.1:9200/_ml/anomaly_detectors/job");
  });
});

describe("XerjClient.info", () => {
  test("identifies a xerj node by cluster name", async () => {
    stubFetch();
    behave = async () => response(200, { cluster_name: "xerj", version: { number: "8.13.0" } });
    const info = await client().info();
    expect(info).toEqual({ clusterName: "xerj", wireVersion: "8.13.0" });
  });

  test("rejects other clusters and missing versions", async () => {
    stubFetch();
    behave = async () => response(200, { cluster_name: "elasticsearch" });
    expect(await client().info()).toBeNull();

    behave = async () => response(200, { cluster_name: "xerj", version: {} });
    expect((await client().info())?.wireVersion).toBe("unknown");
  });

  test("propagates a transport failure without a resolver", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(client().info()).rejects.toBeInstanceOf(TypeError);
  });
});

describe("XerjClient.indices", () => {
  test("parses _cat/indices rows", async () => {
    stubFetch();
    behave = async () =>
      response(200, [
        { index: "xop-a-docs", "docs.count": "12", "store.size": "1.2mb", health: "green" },
        { index: "xop-b-docs", "docs.count": 3, "store.size": "0b" },
        { notAnIndex: true },
      ]);
    const indices = await client().indices();
    expect(indices).toEqual([
      { index: "xop-a-docs", docs: 12, bytes: 1_258_291, health: "green" },
      { index: "xop-b-docs", docs: 3, bytes: 0, health: "unknown" },
    ]);
  });

  test("throws on a failed listing and returns nothing for a non-array", async () => {
    stubFetch();
    behave = async () => response(503, {});
    await expect(client().indices()).rejects.toBeInstanceOf(NodeRequestError);

    behave = async () => response(200, { taken: true });
    expect(await client().indices()).toEqual([]);
  });

  test("count sums the docs of one prefix", async () => {
    stubFetch();
    behave = async () =>
      response(200, [
        { index: "p-docs", "docs.count": "10", "store.size": "1b" },
        { index: "p-hidden-docs", "docs.count": "4", "store.size": "1b" },
        { index: "other-docs", "docs.count": "100", "store.size": "1b" },
      ]);
    expect(await client().count("p")).toBe(14);
  });
});

describe("XerjClient.mappings", () => {
  test("flattens nested properties and skips malformed entries", async () => {
    stubFetch();
    behave = async () =>
      response(200, {
        "xop-a-docs": {
          mappings: { properties: { body: { type: "semantic_text" }, meta: { properties: { kind: { type: "keyword" } } } } },
        },
        broken: { nope: true },
      });
    const mappings = await client().mappings("xop-*");
    expect(mappings).toEqual({
      "xop-a-docs": { body: "semantic_text", "meta.kind": "keyword" },
    });
  });

  test("keeps pattern characters intact in the URL", async () => {
    stubFetch();
    behave = async () => response(200, {});
    await client().search("xop-a-*,xop-b-*", { query: {} });
    expect(calls[0]!.url).toBe("http://127.0.0.1:9200/xop-a-*,xop-b-*/_search");
  });
});

describe("memory endpoints", () => {
  test("store returns the id and created flag", async () => {
    stubFetch();
    behave = async () => response(200, { id: "abc", created: true });
    const result = await client().memoryStore("ns", { text: "t", metadata: {} });
    expect(result).toEqual({ id: "abc", created: true });
    expect(calls[0]!.url).toBe("http://127.0.0.1:9200/_memory/ns");
  });

  test("store fails without an id", async () => {
    stubFetch();
    behave = async () => response(200, { ok: true });
    await expect(client().memoryStore("ns", { text: "t", metadata: {} })).rejects.toBeInstanceOf(
      NodeRequestError,
    );
  });

  test("recall flattens hits and tolerates malformed rows", async () => {
    stubFetch();
    behave = async () =>
      response(200, {
        hits: [
          { id: "1", text: "a", metadata: { kind: "fact" }, score: 0.9 },
          { id: 2 },
          { id: "3", text: "b" },
        ],
      });
    const hits = await client().memoryRecall("ns", { query: "q", k: 5 });
    expect(hits).toEqual([
      { id: "1", text: "a", metadata: { kind: "fact" }, score: 0.9 },
      { id: "3", text: "b", metadata: {}, score: null },
    ]);
  });

  test("summary reads count and exists", async () => {
    stubFetch();
    behave = async () => response(200, { count: 7, exists: true });
    expect(await client().memorySummary("ns")).toEqual({ count: 7, exists: true });

    // A failed listing is an error, not a silent zero.
    behave = async () => response(404, { error: "no index" });
    await expect(client().memorySummary("ns")).rejects.toBeInstanceOf(NodeRequestError);
  });

  test("forget is true only when the node says so", async () => {
    stubFetch();
    behave = async () => response(200, { forgotten: true });
    expect(await client().memoryForget("ns", "abc")).toBe(true);

    behave = async () => response(404, {});
    expect(await client().memoryForget("ns", "abc")).toBe(false);

    behave = async () => response(200, { forgotten: false });
    expect(await client().memoryForget("ns", "abc")).toBe(false);
  });
});

describe("bulk", () => {
  test("sends ndjson index and delete actions", async () => {
    stubFetch();
    behave = async () => response(200, { errors: false });
    await client().bulk("i", [{ id: "1", source: { body: "a" } }, { id: "2", source: { body: "b" } }]);
    expect(calls[0]!.init?.body).toBe(
      `{"index":{"_index":"i","_id":"1"}}\n{"body":"a"}\n{"index":{"_index":"i","_id":"2"}}\n{"body":"b"}\n`,
    );

    await client().bulkDelete("i", ["1", "2"]);
    expect(String(calls[1]!.init?.body)).toBe(
      `{"delete":{"_index":"i","_id":"1"}}\n{"delete":{"_index":"i","_id":"2"}}\n`,
    );
  });

  test("skips empty batches and reports failures", async () => {
    stubFetch();
    await client().bulk("i", []);
    await client().bulkDelete("i", []);
    expect(calls).toHaveLength(0);

    behave = async () => response(500, { error: "boom" });
    await expect(client().bulk("i", [{ id: "1", source: {} }])).rejects.toBeInstanceOf(
      NodeRequestError,
    );
  });
});

describe("error surfaces", () => {
  test("get throws a labelled NodeRequestError with the body", async () => {
    stubFetch();
    behave = async () => response(404, { error: "nope" });
    const error = await client().get("/missing", "missing thing").catch((e) => e);
    expect(error).toBeInstanceOf(NodeRequestError);
    expect((error as NodeRequestError).status).toBe(404);
    expect((error as NodeRequestError).body).toContain("nope");
  });

  test("the observer sees every response status", async () => {
    stubFetch();
    const statuses: number[] = [];
    behave = async () => response(429, {});
    await client({ observer: (status) => statuses.push(status) })
      .get("/x")
      .catch(() => {});
    expect(statuses).toEqual([429]);
  });
});

describe("transport retry", () => {
  function transportError(): TypeError {
    return Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("socket"), { code: "ECONNREFUSED" }),
    });
  }

  test("re-ensures and retries once on a dead socket", async () => {
    stubFetch();
    let attempts = 0;
    const ensured: string[] = [];
    const resolver: ClientResolver = {
      ensure: async () => {
        ensured.push("ensure");
        return "http://127.0.0.1:9300";
      },
      invalidate: () => {
        ensured.push("invalidate");
      },
    };
    behave = async (url) => {
      attempts += 1;
      if (attempts === 1) throw transportError();
      return response(200, { cluster_name: "xerj" });
    };

    const info = await client({ resolver }).info();
    expect(info?.clusterName).toBe("xerj");
    expect(ensured).toEqual(["ensure", "invalidate", "ensure"]);
    expect(calls[1]!.url).toBe("http://127.0.0.1:9300/");
  });

  test("does not retry without a resolver, or on HTTP errors", async () => {
    stubFetch();
    behave = async () => {
      throw transportError();
    };
    await expect(client().info()).rejects.toBeInstanceOf(TypeError);

    // A failed HTTP status is a response, not a transport problem: the
    // resolver is consulted once for the base URL but never re-ensured.
    behave = async () => response(500, {});
    const resolver: ClientResolver = { ensure: async () => "http://elsewhere" };
    expect(await client({ resolver }).info()).toBeNull();
    expect(calls.filter((call) => call.url.includes("elsewhere"))).toHaveLength(1);
  });
});

describe("node identification and health", () => {
  test("a non-ok banner means no node", async () => {
    stubFetch();
    behave = async () => response(503, {});
    expect(await client().info()).toBeNull();
  });

  test("a banner that is not an object means no node", async () => {
    stubFetch();
    behave = async () => response(200, "text");
    expect(await client().info()).toBeNull();
  });

  test("health reports the cluster status, or null", async () => {
    stubFetch();
    behave = async () => response(200, { status: "green" });
    expect(await client().health()).toBe("green");

    behave = async () => response(500, { status: "red" });
    expect(await client().health()).toBeNull();

    behave = async () => response(200, { nothing: true });
    expect(await client().health()).toBeNull();
  });
});

describe("index and document writes", () => {
  test("deleteIndex treats 404 as already gone and rethrows others", async () => {
    stubFetch();
    behave = async () => response(404, {});
    await expect(client().deleteIndex("gone")).resolves.toBeUndefined();

    behave = async () => response(500, {});
    await expect(client().deleteIndex("broken")).rejects.toBeInstanceOf(NodeRequestError);
  });

  test("put succeeds silently and fails with the body", async () => {
    stubFetch();
    behave = async () => response(200, { acknowledged: true });
    await expect(client().put("/idx", { a: 1 }, "create")).resolves.toBeUndefined();

    behave = async () => response(400, { error: "bad mapping" }, { textBody: "bad mapping" });
    const error = await client().put("/idx", { a: 1 }, "create").catch((e) => e);
    expect(error).toBeInstanceOf(NodeRequestError);
    expect((error as NodeRequestError).message).toContain("create");
    expect((error as NodeRequestError).body).toContain("bad mapping");
  });

  test("bulkDelete sends nothing for an empty id list", async () => {
    stubFetch();
    await client().bulkDelete("idx", []);
    expect(calls).toHaveLength(0);
  });

  test("bulkDelete posts ndjson and reports a failure", async () => {
    stubFetch();
    behave = async () => response(200, { errors: false });
    await client().bulkDelete("idx", ["a", "b"]);
    expect(calls[0]!.url).toContain("/_bulk");
    expect(String(calls[0]!.init?.body)).toContain('"delete"');

    behave = async () => response(429, {}, { textBody: "busy" });
    const error = await client().bulkDelete("idx", ["a"]).catch((e) => e);
    expect(error).toBeInstanceOf(NodeRequestError);
  });

  test("bulk reports a failure with the response body", async () => {
    stubFetch();
    behave = async () => response(500, {}, { textBody: "rejected" });
    const error = await client()
      .bulk("idx", [{ id: "a", source: { body: "x" } }])
      .catch((e) => e);
    expect(error).toBeInstanceOf(NodeRequestError);
    expect((error as NodeRequestError).body).toContain("rejected");
  });
});

describe("memory listing", () => {
  test("maps entries and skips malformed ones", async () => {
    stubFetch();
    behave = async () =>
      response(200, {
        entries: [
          { id: "a", text: "one", metadata: { kind: "fact" } },
          { id: "b", text: "two" },
          { id: 3, text: "bad" },
          { text: "no id" },
        ],
      });

    expect(await client().memoryList("ns", 10)).toEqual([
      { id: "a", text: "one", metadata: { kind: "fact" } },
      { id: "b", text: "two", metadata: {} },
    ]);
  });

  test("a listing that is not a record yields nothing", async () => {
    stubFetch();
    behave = async () => response(200, []);
    expect(await client().memoryList("ns", 10)).toEqual([]);
  });

  test("summary reports the count and existence", async () => {
    stubFetch();
    behave = async () => response(200, { count: 7, exists: true });
    expect(await client().memorySummary("ns")).toEqual({ count: 7, exists: true });

    behave = async () => response(200, "nope");
    expect(await client().memorySummary("ns")).toEqual({ count: 0, exists: false });
  });

  test("forget reports success only when the node says forgotten", async () => {
    stubFetch();
    behave = async () => response(200, { forgotten: true });
    expect(await client().memoryForget("ns", "a")).toBe(true);

    behave = async () => response(404, { forgotten: false });
    expect(await client().memoryForget("ns", "a")).toBe(false);
  });

  test("store requires an id in the answer", async () => {
    stubFetch();
    behave = async () => response(200, { created: true });
    await expect(
      client().memoryStore("ns", { text: "x", metadata: {} }),
    ).rejects.toBeInstanceOf(NodeRequestError);
  });
});

describe("write timeout", () => {
  function slowFetch(delayMs: number): FetchBehavior {
    return (_url, init) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(response(200, { ok: true })), delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
  }

  test("a bulk write outlives the short read timeout", async () => {
    stubFetch(slowFetch(80));
    const subject = new XerjClient("http://127.0.0.1:9240", {
      timeoutMs: 20,
    });

    // Embedding a document on a neural node takes seconds; a read timeout
    // would abandon the write after it had already been accepted.
    await expect(
      subject.bulk("idx", [{ id: "a", source: { body: "text" } }]),
    ).resolves.toBeUndefined();
  });

  test("a read still gives up on the short timeout", async () => {
    stubFetch(slowFetch(80));
    const subject = new XerjClient("http://127.0.0.1:9240", {
      timeoutMs: 20,
    });

    await expect(subject.get("/slow", "slow read")).rejects.toBeDefined();
  });
});

describe("parseSize units and transport codes", () => {
  test("parses the larger units and rejects nonsense", () => {
    expect(parseSize("1.5tb")).toBe(Math.round(1.5 * 1024 ** 4));
    expect(parseSize("2 pb")).toBe(2 * 1024 ** 5);
    expect(parseSize("abc")).toBe(0);
    expect(parseSize(null)).toBe(0);
  });

  test("an unreachable network is retried like a closed socket", async () => {
    stubFetch();
    let attempts = 0;
    const resolver: ClientResolver = {
      ensure: async () => "http://127.0.0.1:9500",
      invalidate: () => {},
    };
    behave = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("net"), { code: "ENETUNREACH" }),
        });
      }
      return response(200, { cluster_name: "xerj" });
    };

    const info = await client({ resolver }).info();

    expect(info?.clusterName).toBe("xerj");
    expect(attempts).toBe(2);
  });
});
