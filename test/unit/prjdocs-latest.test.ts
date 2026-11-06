import { describe, expect, test } from "bun:test";
import { LatestVersions } from "../../src/prjdocs/latest.ts";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

const ref = (id: string) => ({ id, kind: "language" as const, used: null, evidence: "x" });

function fetchJson(body: unknown, ok = true): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: ok ? 200 : 500,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("LatestVersions", () => {
  test("reads the newest Node release", async () => {
    const latest = new LatestVersions({
      logger,
      fetchImpl: fetchJson([{ version: "v22.3.0" }, { version: "v21.0.0" }]),
    });

    expect(await latest.resolve(ref("node"))).toBe("22.3.0");
  });

  test("reads the newest Python release from endoflife.date", async () => {
    const latest = new LatestVersions({
      logger,
      fetchImpl: fetchJson([{ latest: "3.13.5" }]),
    });

    expect(await latest.resolve(ref("python"))).toBe("3.13.5");
  });

  test("other technologies resolve to null without a request", async () => {
    let calls = 0;
    const latest = new LatestVersions({
      logger,
      fetchImpl: (async () => {
        calls += 1;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });

    expect(await latest.resolve(ref("react"))).toBeNull();
    expect(calls).toBe(0);
  });

  test("the answer is cached for the TTL", async () => {
    let calls = 0;
    const latest = new LatestVersions({
      logger,
      fetchImpl: (async () => {
        calls += 1;
        return new Response(JSON.stringify([{ version: "v20.0.0" }]));
      }) as unknown as typeof fetch,
    });

    expect(await latest.resolve(ref("node"))).toBe("20.0.0");
    expect(await latest.resolve(ref("node"))).toBe("20.0.0");
    expect(calls).toBe(1);
  });

  test("a failed response is cached as null", async () => {
    const latest = new LatestVersions({ logger, fetchImpl: fetchJson({}, false) });
    expect(await latest.resolve(ref("node"))).toBeNull();
  });

  test("a reply that is not a release list is null", async () => {
    const latest = new LatestVersions({ logger, fetchImpl: fetchJson({ error: "nope" }) });
    expect(await latest.resolve(ref("node"))).toBeNull();
  });

  test("a version that is not numeric is rejected", async () => {
    const latest = new LatestVersions({
      logger,
      fetchImpl: fetchJson([{ version: "latest" }]),
    });
    expect(await latest.resolve(ref("node"))).toBeNull();
  });

  test("a network failure is null, not an exception", async () => {
    const latest = new LatestVersions({
      logger,
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });

    expect(await latest.resolve(ref("python"))).toBeNull();
  });
});

describe("CUDA latest", () => {
  test("the archive listing is read and compared numerically", async () => {
    const html = [
      '<a href="archive/12.4.0/">12.4.0</a>',
      '<a href="archive/12.9.0/">12.9.0</a>',
      '<a href="archive/12.10.1/">12.10.1</a>',
    ].join("\n");
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      requested.push(String(input));
      return new Response(html);
    }) as unknown as typeof fetch;

    const latest = new LatestVersions({ logger, fetchImpl });
    const version = await latest.resolve({
      id: "cuda",
      kind: "framework",
      used: null,
      evidence: "test",
    });

    expect(version).toBe("12.10.1");
    expect(requested[0]).toContain("docs.nvidia.com/cuda/archive");
  });

  test("a listing with no versions is null, not an error", async () => {
    const fetchImpl = (async () => new Response("<html>nothing</html>")) as unknown as typeof fetch;
    const latest = new LatestVersions({ logger, fetchImpl });

    expect(
      await latest.resolve({ id: "cuda", kind: "framework", used: null, evidence: "t" }),
    ).toBeNull();
  });
});

describe("ROCm latest", () => {
  test("the release in the docs title is returned", async () => {
    const html = "<title>AMD ROCm 10.1.0 documentation</title>";
    const fetchImpl = (async () => new Response(html)) as unknown as typeof fetch;
    const latest = new LatestVersions({ logger, fetchImpl });

    expect(
      await latest.resolve({ id: "rocm", kind: "framework", used: null, evidence: "t" }),
    ).toBe("10.1.0");
  });

  test("a page without a release is null", async () => {
    const fetchImpl = (async () => new Response("<title>ROCm docs</title>")) as unknown as typeof fetch;
    const latest = new LatestVersions({ logger, fetchImpl });

    expect(
      await latest.resolve({ id: "rocm", kind: "framework", used: null, evidence: "t" }),
    ).toBeNull();
  });
});
