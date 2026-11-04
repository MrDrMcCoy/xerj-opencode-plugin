import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import type { KeyValueStorage, Logger } from "../../src/log.ts";
import { CorpusService } from "../../src/index/watcher.ts";

// A fake engine: emits one run document, then stays resident like --watch.
const FAKE_ENGINE = `#!/bin/sh
echo '{"doc_kind":"run","generation":1,"records_total":3}'
sleep 30
`;

function storage(): KeyValueStorage {
  const values = new Map<string, unknown>();
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
    },
  };
}

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

function fakeBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), "xerj-watch-"));
  const path = join(dir, "xerj");
  writeFileSync(path, FAKE_ENGINE);
  chmodSync(path, 0o755);
  return path;
}

function service(binaryPath: string, dataRoot: string): CorpusService {
  return new CorpusService({
    binaryPath,
    nodeUrl: "http://127.0.0.1:9200",
    projectRoot: "/tmp/project",
    prefix: "xop-project-12345678",
    dataRoot,
    config: DEFAULT_CONFIG,
    storage: storage(),
    logger,
  });
}

const running: CorpusService[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((item) => item.stop()));
});

describe("CorpusService watch ownership", () => {
  test("a second service for one state dir shares the resident watcher", async () => {
    const binary = fakeBinary();
    const dataRoot = mkdtempSync(join(tmpdir(), "xerj-data-"));
    const first = service(binary, dataRoot);
    const second = service(binary, dataRoot);
    running.push(first, second);

    // Same project, same data root: the journal is shared, so the second
    // service must not start a competing --watch process.
    await first.start();
    await second.start();

    expect(second.snapshot().state).toBe("shared");
    expect(second.snapshot().lastError).toBeNull();
  });

  test("the owner reports watching once its first run document lands", async () => {
    const binary = fakeBinary();
    const owner = service(binary, mkdtempSync(join(tmpdir(), "xerj-data-")));
    running.push(owner);

    await owner.start();
    await Bun.sleep(300);

    expect(owner.snapshot().state).toBe("watching");
    expect(owner.snapshot().lastRun?.records).toBe(3);
  });
});
