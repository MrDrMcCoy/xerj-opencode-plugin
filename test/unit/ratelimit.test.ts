import { describe, expect, test } from "bun:test";
import { HostRateLimiter, hostOf, retryAfterMs } from "../../src/prjdocs/ratelimit.ts";

describe("HostRateLimiter", () => {
  test("spaces requests to one host by the interval", async () => {
    let now = 0;
    const slept: number[] = [];
    const limiter = new HostRateLimiter({
      intervalMs: 200,
      jitterMs: 0,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });

    await limiter.wait("https://docs.example.test/a");
    now += 50;
    await limiter.wait("https://docs.example.test/b");
    await limiter.wait("https://docs.example.test/c");

    // First request is immediate, the second waits the remaining 150 ms, the
    // third a full interval.
    expect(slept).toEqual([150, 200]);
  });

  test("does not couple different hosts", async () => {
    let now = 0;
    const slept: number[] = [];
    const limiter = new HostRateLimiter({
      intervalMs: 500,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });

    await limiter.wait("https://a.example.test/");
    await limiter.wait("https://b.example.test/");

    expect(slept).toEqual([]);
  });

  test("a Retry-After pushes that host's next slot", async () => {
    let now = 1_000;
    const slept: number[] = [];
    const limiter = new HostRateLimiter({
      intervalMs: 100,
      jitterMs: 0,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });

    limiter.noteRetryAfter("https://docs.example.test/x", 5_000);
    await limiter.wait("https://docs.example.test/x");

    expect(slept).toEqual([5_000]);
  });

  test("adds jitter only to the next slot", async () => {
    let now = 0;
    const slept: number[] = [];
    const limiter = new HostRateLimiter({
      intervalMs: 100,
      jitterMs: 50,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });

    await limiter.wait("https://docs.example.test/");
    // Jitter is random, so any wait between 100 and 150 is correct.
    await limiter.wait("https://docs.example.test/");
    expect(slept[0]).toBeGreaterThanOrEqual(100);
    expect(slept[0]).toBeLessThanOrEqual(150);
  });
});

describe("retryAfterMs", () => {
  test("parses seconds and dates", () => {
    const now = Date.parse("2026-11-06T00:00:00Z");
    expect(retryAfterMs("2", now)).toBe(2_000);
    expect(retryAfterMs("Wed, 21 Oct 2027 07:28:00 GMT", now)).toBeGreaterThan(0);
    expect(retryAfterMs("nonsense", now)).toBeNull();
    expect(retryAfterMs(null, now)).toBeNull();
  });
});

describe("hostOf", () => {
  test("keeps the port and ignores the path", () => {
    expect(hostOf("https://docs.example.test:8443/a/b")).toBe("docs.example.test:8443");
    expect(hostOf("not a url")).toBeNull();
  });
});
