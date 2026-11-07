import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../../src/log.ts";
import {
  dayKey,
  growth,
  percentile,
  TelemetryStore,
  type TelemetryStoreOptions,
} from "../../src/telemetry/store.ts";
import type { SampleRecord } from "../../src/telemetry/types.ts";

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

const scratch: string[] = [];

afterEach(async () => {
  for (const directory of scratch.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function store(
  overrides: Partial<TelemetryStoreOptions> = {},
): Promise<TelemetryStore> {
  const directory = await mkdtemp(join(tmpdir(), "xerj-tel-"));
  scratch.push(directory);
  const instance = overrides.instance ?? "boot-a";
  const built = new TelemetryStore({
    directory,
    prefix: "xop-demo-12345678",
    instance,
    enabled: true,
    maxBytes: 128 * 1024 * 1024,
    samplesPerType: 256,
    rotateBytes: 8 * 1024 * 1024,
    rotations: 4,
    flushMs: 60_000,
    maxText: 160,
    logger,
    bootMs: () => 0,
    ...overrides,
  });
  await built.init();
  return built;
}

describe("TelemetryStore", () => {
  test("disabled mode creates nothing and reports empty", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xerj-tel-"));
    scratch.push(directory);
    const off = new TelemetryStore({
      directory,
      prefix: "xop-demo-12345678",
      instance: "boot-a",
      enabled: false,
      maxBytes: 1024,
      samplesPerType: 8,
      rotateBytes: 1024,
      rotations: 1,
      flushMs: 1000,
      maxText: 160,
      logger,
      bootMs: () => 0,
    });
    await off.init();
    expect(await readdir(directory).catch(() => [])).toEqual([]);
    const report = await off.report();
    expect(report.rows).toEqual([]);
    await off.close();
  });

  test("reports percentiles after a flush", async () => {
    const built = await store();
    await built.span("search", async () => undefined);
    await built.span("search", async () => undefined);
    await built.flush();

    const report = await built.report({ window: "all" });
    const row = report.rows.find((entry) => entry.op === "search");
    expect(row?.count).toBe(2);
    expect(row?.errors).toBe(0);
    expect(report.storeBytes).toBeGreaterThan(0);
    await built.close();
  });

  test("an error records its class and status, never its message", async () => {
    const built = await store();
    const failure = Object.assign(new Error("secret prompt text"), {
      name: "NodeRequestError",
      status: 500,
    });
    await expect(
      built.span("search", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    const text = await readFile(
      join(built.directory, "ops.ndjson"),
      "utf8",
    ).catch(() => "");
    await built.flush();
    const written = await readFile(join(built.directory, "ops.ndjson"), "utf8");
    expect(written).toContain("\"error\":\"NodeRequestError\"");
    expect(written).toContain("\"status\":500");
    expect(written).not.toContain("secret prompt text");
    expect(text.length).toBe(0);
    await built.close();
  });

  test("keeps only the newest samples per type", async () => {
    const built = await store({ samplesPerType: 2 });
    for (let index = 0; index < 4; index += 1) {
      built.record("search", index, true);
    }
    await built.flush();

    const lines = (
      await readFile(join(built.directory, "rings", "search.ndjson"), "utf8")
    )
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines.length).toBe(2);
    await built.close();
  });

  test("summarizes distillation cost and recall", async () => {
    const built = await store();
    built.record("memory.distill", 5, true, {
      judge: "heuristic",
      candidates: 3,
      promoted: 2,
    });
    built.record("memory.distill", 7, true, {
      judge: "model",
      promoted: 1,
      calls: 2,
      chars: 1_500,
    });
    built.record("memory.recall", 1, true, { hits: 3, distilled: 2 });
    built.record("memory.distill", 0, true, { phase: "retire", retired: 4 });
    await built.flush();

    const report = await built.report({ window: "all" });
    expect(report.distill).toEqual({
      promoted: 3,
      heuristic: 2,
      model: 1,
      recalled: 2,
      calls: 2,
      chars: 1_500,
    });
    await built.close();
  });

  test("UI lines land in their own ring and are clipped and redacted", async () => {
    const built = await store({ samplesPerType: 3, maxText: 160 });

    built.noteUi({ level: "debug", message: "sidebar render", detail: "collapsed=false" });
    built.noteUi({
      level: "error",
      message: "sidebar render failed",
      detail: `token ghp_${"a".repeat(36)} at the end`,
    });
    built.noteUi({ level: "verbose", message: "unknown level is info" });
    built.noteUi({ level: "info", message: "   " });
    await built.flush();

    const lines = (
      await readFile(join(built.directory, "rings", "ui.sidebar.ndjson"), "utf8")
    )
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(3);

    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records[0]).toMatchObject({
      level: "debug",
      message: "sidebar render",
      prefix: "xop-demo-12345678",
      instance: "boot-a",
    });
    expect(records[1]?.level).toBe("error");
    expect(String(records[1]?.detail)).not.toContain("a".repeat(36));
    expect(String(records[1]?.detail)).toContain("[redacted]");
    expect(records[2]?.level).toBe("info");

    await built.close();
  });

  test("UI ring keeps only the newest lines", async () => {
    const built = await store({ samplesPerType: 2 });
    for (let index = 0; index < 5; index += 1) {
      built.noteUi({ level: "debug", message: `render ${index}` });
    }
    await built.flush();

    const lines = (
      await readFile(join(built.directory, "rings", "ui.sidebar.ndjson"), "utf8")
    )
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("render 4");
    await built.close();
  });

  test("UI lines are dropped when telemetry is off", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xerj-tel-"));
    scratch.push(directory);
    const off = new TelemetryStore({
      directory,
      prefix: "xop-demo-12345678",
      instance: "boot-a",
      enabled: false,
      maxBytes: 1024,
      samplesPerType: 8,
      rotateBytes: 1024,
      rotations: 1,
      flushMs: 1000,
      maxText: 160,
      logger,
      bootMs: () => 0,
    });
    await off.init();
    off.noteUi({ level: "error", message: "sidebar render failed" });
    await off.flush();
    expect(await readdir(join(directory)).catch(() => [])).toEqual([]);
    await off.close();
  });

  test("rotates the operation log and keeps one older file", async () => {
    const built = await store({ rotateBytes: 300, rotations: 1 });
    for (let index = 0; index < 20; index += 1) {
      built.record("search", 1, true);
      await built.flush();
    }

    const names = await readdir(built.directory);
    expect(names).toContain("ops.ndjson");
    expect(names).toContain("ops.ndjson.1.ndjson");
    await built.close();
  });

  test("maxText 0 records no caller text", async () => {
    const built = await store({ maxText: 0 });
    built.record("search", 1, true, { query: "find the secret" });
    await built.flush();

    const text = await readFile(join(built.directory, "ops.ndjson"), "utf8");
    expect(text).not.toContain("find the secret");
    await built.close();
  });

  test("a long caller string is clipped and a token is redacted", async () => {
    const built = await store({ maxText: 20 });
    built.record("search", 1, true, {
      query: `Bearer abcdefghijklmnopqrstuvwxyz ${"x".repeat(80)}`,
    });
    await built.flush();

    const text = await readFile(join(built.directory, "ops.ndjson"), "utf8");
    expect(text).toContain("[redacted]");
    expect(text.length).toBeLessThan(400);
    await built.close();
  });

  test("skips a corrupt line instead of failing the report", async () => {
    const built = await store();
    built.record("search", 1, true);
    await built.flush();
    await writeFile(
      join(built.directory, "ops.ndjson"),
      "{not json\n",
      { flag: "a" },
    );

    const report = await built.report({ window: "all" });
    expect(report.rows.some((row) => row.op === "search")).toBe(true);
    await built.close();
  });

  test("a second store does not claim the writer lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xerj-tel-"));
    scratch.push(directory);
    const options: TelemetryStoreOptions = {
      directory,
      prefix: "xop-demo-12345678",
      instance: "boot-a",
      enabled: true,
      maxBytes: 1024 * 1024,
      samplesPerType: 8,
      rotateBytes: 4096,
      rotations: 1,
      flushMs: 60_000,
      maxText: 160,
      logger,
      bootMs: () => 0,
    };
    const first = new TelemetryStore(options);
    await first.init();
    const second = new TelemetryStore({ ...options, instance: "boot-b" });
    await second.init();

    second.record("search", 1, true);
    await second.flush();
    // A non-owner appends and leaves compaction to the owner.
    const lines = (
      await readFile(join(directory, "rings", "search.ndjson"), "utf8")
    )
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines.length).toBe(1);

    await first.close();
    await second.close();
  });

  test("dwell time accumulates per state", async () => {
    const built = await store();
    const start = Date.now();
    built.noteState("starting", "ready", start);
    built.noteState("ready", "busy", start + 1_500);

    expect(built.dwellFor("starting")).toBe(0);
    expect(built.dwellFor("ready")).toBe(1_500);
    await built.close();
  });

  test("the state it is in now counts, not only closed intervals", async () => {
    const built = await store();
    built.noteState("starting", "ready", Date.now() - 400);

    expect(built.dwellFor("ready")).toBeGreaterThanOrEqual(300);
    await built.close();
  });

  test("a transition records why it happened", async () => {
    const built = await store();
    built.noteState("starting", "degraded", Date.now(), "memory missing");
    await built.flush();

    const text = await readFile(join(built.directory, "ops.ndjson"), "utf8");
    expect(text).toContain('"detail":"memory missing"');
    await built.close();
  });

  test("a report carries the day's dwell for this instance", async () => {
    const built = await store();
    built.noteState("starting", "ready", Date.now() - 2_000);
    await built.flush();

    const report = await built.report({ window: "day" });
    expect(report.states.readyMs).toBeGreaterThanOrEqual(1_500);
    expect(report.states.busyMs).toBe(0);
    await built.close();
  });

  test("another project's node is not this panel's process", async () => {
    const built = await store();
    const now = Date.now();
    built.sample({
      ...sample(now - 1_000, 2 * 1024 * 1024 * 1024, 11),
      prefix: "xop-other-99999999",
    });
    built.sample(sample(now, 100 * 1024 * 1024, 12));
    await built.flush();

    const report = await built.report({ window: "day" });
    expect(report.process?.rssBytes).toBe(100 * 1024 * 1024);
    await built.close();
  });

  test("process figures follow the newest pid, not a retired one", async () => {
    const built = await store();
    const now = Date.now();
    built.sample(sample(now - 3_000, 2 * 1024 * 1024 * 1024, 11));
    built.sample(sample(now - 2_000, 2 * 1024 * 1024 * 1024, 11));
    built.sample(sample(now - 1_000, 100 * 1024 * 1024, 12));
    await built.flush();

    const report = await built.report({ window: "day" });
    expect(report.process?.rssBytes).toBe(100 * 1024 * 1024);
    expect(report.process?.peakRssBytes).toBe(100 * 1024 * 1024);
    expect(report.process?.growthMbPerDay).toBe(0);
    await built.close();
  });
});

describe("percentile", () => {
  test("uses the nearest rank without interpolation", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 95)).toBe(5);
  });
});

describe("growth", () => {
  test("reports resident-set change in MB per day", () => {
    const samples: SampleRecord[] = [
      sample(0, 100 * 1024 * 1024),
      sample(86_400_000, 200 * 1024 * 1024),
    ];
    expect(growth(samples)).toBe(100);
    expect(growth(samples.slice(0, 1))).toBe(0);
  });

  test("does not extrapolate a rate from a short window", () => {
    const samples: SampleRecord[] = [
      sample(0, 100 * 1024 * 1024),
      sample(14_000, 101 * 1024 * 1024),
    ];
    expect(growth(samples)).toBe(0);
  });

  test("orders samples by time before subtracting", () => {
    const samples: SampleRecord[] = [
      sample(86_400_000, 200 * 1024 * 1024),
      sample(0, 100 * 1024 * 1024),
    ];
    expect(growth(samples)).toBe(100);
  });
});

describe("dayKey", () => {
  test("pads month and day", () => {
    expect(dayKey(new Date(2026, 0, 5).getTime())).toBe("2026-01-05");
  });
});

function sample(at: number, rssBytes: number, pid = 1): SampleRecord {
  return {
    at,
    kind: "node",
    pid,
    load: 0,
    cpuPct: null,
    rssBytes,
    threads: 1,
  };
}
