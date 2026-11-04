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

function service(
  binaryPath: string,
  stateRoot: string,
  projectRoot = "/tmp/project",
  config = DEFAULT_CONFIG,
): CorpusService {
  return new CorpusService({
    binaryPath,
    nodeUrl: "http://127.0.0.1:9200",
    projectRoot,
    prefix: "xop-project-12345678",
    stateRoot,
    config,
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

  test("watches the tree while the first pass is still running", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "xerj-project-"));
    const log = join(projectRoot, "runs.log");
    // The first pass takes long enough for an edit to land during it.
    const script = `#!/bin/sh
 echo run >> ${JSON.stringify(log)}
 echo '{"doc_kind":"run","generation":1,"records_total":3}'
 sleep 2
 `;
    const binary = fakeBinary(script);
    const owner = service(
      binary,
      join(projectRoot, ".xerj", "data"),
      projectRoot,
    );
    running.push(owner);

    const started = owner.start();
    await Bun.sleep(200);
    writeFileSync(join(projectRoot, "note.md"), "written during the first pass");
    await started;
    // The edit queued a pass behind the first one; without watchers during
    // the first pass nothing would notice it until the periodic fallback.
    await Bun.sleep(300);

    expect(readFileSync(log, "utf8").trim().split("\n").length).toBe(2);
  });

  test("shares the local watcher across instances for one project", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "xerj-project-"));
    const stateRoot = join(projectRoot, ".xerj");
    const log = join(projectRoot, "runs.log");
    const script = `#!/bin/sh
 echo run >> ${JSON.stringify(log)}
 echo '{"doc_kind":"run","generation":1,"records_total":3}'
 `;
    const binary = fakeBinary(script);
    const first = service(binary, stateRoot, projectRoot);
    const second = service(binary, stateRoot, projectRoot);
    running.push(first, second);

    await first.start();
    await second.start();
    await Bun.sleep(300);

    // Only the owner indexes; the second instance must not run a competing
    // pass over the same journal.
    expect(first.snapshot().state).not.toBe("shared");
    expect(second.snapshot().state).toBe("shared");
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);

    // When the owner stops, a new instance takes the watcher over.
    await first.stop();
    running.splice(running.indexOf(first), 1);
    const third = service(binary, stateRoot, projectRoot);
    running.push(third);
    await third.start();
    await Bun.sleep(300);

    expect(third.snapshot().state).not.toBe("shared");
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
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
