import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import type { KeyValueStorage, Logger } from "../../src/log.ts";
import { CorpusService, listWatchableDirectories } from "../../src/index/watcher.ts";

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

describe("listWatchableDirectories", () => {
  test("skips hidden and generated directories", () => {
    const root = mkdtempSync(join(tmpdir(), "xerj-dirs-"));
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    mkdirSync(join(root, ".xerj"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });

    const dirs = listWatchableDirectories(root)!;
    expect(dirs).toContain(join(root, "src"));
    expect(dirs).toContain(join(root, "src", "nested"));
    expect(dirs.some((dir) => dir.includes(".xerj"))).toBe(false);
    expect(dirs.some((dir) => dir.includes("node_modules"))).toBe(false);
  });

  test("refuses a tree beyond the watch budget", () => {
    const root = mkdtempSync(join(tmpdir(), "xerj-dirs-"));
    mkdirSync(join(root, "a"));
    mkdirSync(join(root, "b"));
    expect(listWatchableDirectories(root, 2)).toBeNull();
  });
});

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

function fakeBinary(script = FAKE_ENGINE): string {
  const dir = mkdtempSync(join(tmpdir(), "xerj-watch-"));
  const path = join(dir, "xerj");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

function service(binaryPath: string, stateRoot: string): CorpusService {
  return new CorpusService({
    binaryPath,
    nodeUrl: "http://127.0.0.1:9200",
    projectRoot: "/tmp/project",
    prefix: "xop-project-12345678",
    stateRoot,
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
    const stateRoot = mkdtempSync(join(tmpdir(), "xerj-data-"));
    const first = service(binary, stateRoot);
    const second = service(binary, stateRoot);
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

  test("a watcher killed by a signal is restarted, not left idle", async () => {
    const script = `#!/bin/sh
 echo $$ > "$0.pid"
 echo '{"doc_kind":"run","generation":1,"records_total":3}'
 exec sleep 30
 `;
    const binary = fakeBinary(script);
    const owner = service(binary, mkdtempSync(join(tmpdir(), "xerj-data-")));
    running.push(owner);

    await owner.start();
    await Bun.sleep(300);
    const pid = Number(readFileSync(`${binary}.pid`, "utf8").trim());
    process.kill(pid, "SIGTERM");
    // The first restart waits one second, so this window proves the exit was
    // treated as a crash rather than as a clean stop.
    await Bun.sleep(1_500);

    expect(owner.snapshot().lastError).toContain("exited");
    expect(owner.snapshot().state).not.toBe("idle");
  });
});
