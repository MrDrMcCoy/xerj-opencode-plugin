import { describe, expect, test } from "bun:test";
import { Counters } from "../../src/stats/counters.ts";

describe("Counters", () => {
  test("starts at zero", () => {
    expect(new Counters().snapshot()).toEqual({
      rpcCalls: 0,
      injectedTurns: 0,
      nodeSpawns: 0,
      http429: 0,
      indexRuns: 0,
      noiseSkips: 0,
    });
  });

  test("each event increments its own counter once", () => {
    const counters = new Counters();
    counters.noteRpc();
    counters.noteRpc();
    counters.noteInjection();
    counters.noteSpawn();
    counters.note429();
    counters.noteIndexRun();
    counters.noteNoiseSkip();

    expect(counters.snapshot()).toEqual({
      rpcCalls: 2,
      injectedTurns: 1,
      nodeSpawns: 1,
      http429: 1,
      indexRuns: 1,
      noiseSkips: 1,
    });
  });

  test("a snapshot is a copy, not a live view", () => {
    const counters = new Counters();
    const first = counters.snapshot();
    counters.noteRpc();
    expect(first.rpcCalls).toBe(0);
    expect(counters.snapshot().rpcCalls).toBe(1);
  });
});
