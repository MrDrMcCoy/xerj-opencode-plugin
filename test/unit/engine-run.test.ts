// `runEngine` is the single wrapper every managed-binary command goes through
// (hub, code, share, cmd). It never throws; it reports an exit code, a
// timeout flag, and bounded output. These tests drive real child processes so
// the spawn, deadline, and byte limits are exercised.

import { describe, expect, test } from "bun:test";
import { runEngine } from "../../src/engine/run.ts";

const bun = process.execPath;

describe("runEngine", () => {
  test("returns stdout, stderr, and the exit code", async () => {
    const result = await runEngine(
      bun,
      ["-e", "console.log('out'); console.error('err')"],
      process.env,
      10_000,
    );

    expect(result).toMatchObject({ code: 0, timedOut: false });
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
  });

  test("kills a command at its deadline and reports the timeout", async () => {
    const started = Date.now();
    const result = await runEngine(
      bun,
      ["-e", "setInterval(() => {}, 1000)"],
      process.env,
      200,
    );

    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  test("reports a spawn failure without throwing", async () => {
    const result = await runEngine(
      "/no/such/xerj-binary",
      ["--version"],
      process.env,
      2_000,
    );

    expect(result.code).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  test("bounds a noisy stderr stream", async () => {
    const result = await runEngine(
      bun,
      ["-e", "process.stderr.write('x'.repeat(70000))"],
      process.env,
      10_000,
    );

    expect(result.code).toBe(0);
    // The cap is 64 KiB; a chunk can push the string just past it.
    expect(result.stderr.length).toBeLessThanOrEqual(65 * 1024);
  }, 10_000);
});
