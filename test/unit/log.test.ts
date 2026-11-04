import { describe, expect, test } from "bun:test";
import { createLogger } from "../../src/log.ts";

function store(): {
  data: Map<string, unknown>;
  storage: { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<void> };
} {
  const data = new Map<string, unknown>();
  return {
    data,
    storage: {
      get: async (key) => data.get(key),
      set: async (key, value) => void data.set(key, value),
    },
  };
}

describe("createLogger", () => {
  test("keeps project rings separate in one shared storage", async () => {
    const { storage } = store();
    const alpha = createLogger(storage, { key: "log/ring:alpha", echoToConsole: false });
    const beta = createLogger(storage, { key: "log/ring:beta", echoToConsole: false });

    alpha.warn("alpha warning");
    beta.warn("beta warning");
    await alpha.flush();
    await beta.flush();

    const alphaEntries = await alpha.entries();
    const betaEntries = await createLogger(storage, { key: "log/ring:beta", echoToConsole: false }).entries();

    expect(alphaEntries.map((entry) => entry.message)).toEqual(["alpha warning"]);
    expect(betaEntries.map((entry) => entry.message)).toEqual(["beta warning"]);
  });

  test("falls back to the default key", async () => {
    const { storage, data } = store();
    const logger = createLogger(storage, { echoToConsole: false });
    logger.info("shared");
    await logger.flush();

    expect(data.has("log/ring")).toBe(true);
  });
});
