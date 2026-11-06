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
  config: typeof DEFAULT_CONFIG = {
    ...DEFAULT_CONFIG,
    index: { ...DEFAULT_CONFIG.index, graph: false },
  },
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
  test(
    "a one-shot blocked by another pass is contention, not a failure",
    async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "xerj-project-"));
    const state = join(projectRoot, ".xerj", "state");
    const attempts = join(projectRoot, "attempts");
    const script = `#!/bin/sh
n=$(cat ${JSON.stringify(attempts)} 2>/dev/null || echo 0)
n=$((n+1)); echo $n > ${JSON.stringify(attempts)}
if [ $n -lt 3 ]; then
  echo "error: autoindex state ${state} is already in use by another process; wait for it to finish or choose a different --state-dir: Resource temporarily unavailable (os error 11)" >&2
  exit 1
fi
echo '{"doc_kind":"run","generation":1,"records_total":3}'
`;
    const warnings: string[] = [];
    const loud: Logger = {
      ...logger,
      warn: (message: string) => warnings.push(message),
    };
    const instance = new CorpusService({
      binaryPath: fakeBinary(script),
      nodeUrl: "http://127.0.0.1:9200",
      projectRoot,
      prefix: "xop-project-12345678",
      stateRoot: join(projectRoot, ".xerj"),
      config: {
        ...DEFAULT_CONFIG,
        index: { ...DEFAULT_CONFIG.index, watch: false, periodicMs: 60_000 },
      },
      storage: storage(),
      logger: loud,
    });
    running.push(instance);

    await instance.start();
    // The first two passes hit the flock held by a concurrent pass.
    expect(instance.snapshot().lastError).toBeNull();
    expect(instance.snapshot().state).not.toBe("error");
    expect(warnings).toEqual([]);

    // The retried pass lands a run document instead of stalling. Two
    // contention retries at 5 s each precede the successful third pass.
    for (let waited = 0; waited < 14_000; waited += 250) {
      if (instance.snapshot().lastRun) break;
      await Bun.sleep(250);
    }
    expect(instance.snapshot().lastRun?.records).toBe(3);
    expect(readFileSync(attempts, "utf8").trim()).toBe("3");
    },
    20_000,
  );

  test(
    "a journal bound to another node URL is rebuilt with --fresh",
    async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "xerj-project-"));
    const argsLog = join(projectRoot, "args");
    const script = `#!/bin/sh
echo "$@" >> ${JSON.stringify(argsLog)}
case " $* " in *" --fresh "*) ;; *)
  echo "error: journal at /x/journal.ndjson was created for root=/p url=http://127.0.0.1:9200 prefix=xop; current run has root=/p url=http://127.0.0.1:9240 prefix=xop" >&2
  exit 1;;
esac
echo '{"doc_kind":"run","generation":1,"records_total":5}'
`;
    const warnings: string[] = [];
    const loud: Logger = { ...logger, warn: (message: string) => warnings.push(message) };
    const instance = new CorpusService({
      binaryPath: fakeBinary(script),
      nodeUrl: "http://127.0.0.1:9240",
      projectRoot,
      prefix: "xop-project-12345678",
      stateRoot: join(projectRoot, ".xerj"),
      config: {
        ...DEFAULT_CONFIG,
        index: { ...DEFAULT_CONFIG.index, watch: false, periodicMs: 60_000 },
      },
      storage: storage(),
      logger: loud,
    });
    running.push(instance);

    await instance.start();
    for (let waited = 0; waited < 5_000; waited += 100) {
      if (instance.snapshot().lastRun) break;
      await Bun.sleep(100);
    }
    expect(instance.snapshot().lastRun?.records).toBe(5);
    expect(instance.snapshot().lastError).toBeNull();
    expect(warnings).toEqual([]);
    const runs = readFileSync(argsLog, "utf8").trim().split("\n");
    expect(runs).toHaveLength(2);
    expect(runs[0]).not.toContain("--fresh");
    expect(runs[1]).toContain("--fresh");
    },
    10_000,
  );

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

describe("graph mode refresh", () => {
  test("a graph project never spawns the resident watcher", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "xerj-project-"));
    const argsLog = join(projectRoot, "args");
    const script = `#!/bin/sh
echo "$@" >> ${JSON.stringify(argsLog)}
echo '{"doc_kind":"run","generation":1,"records_total":4}'
`;
    const graphConfig: typeof DEFAULT_CONFIG = {
      ...DEFAULT_CONFIG,
      index: {
        ...DEFAULT_CONFIG.index,
        watch: true,
        graph: true,
        periodicMs: 60_000,
      },
    };
    // A state root outside the project would otherwise pick the resident route.
    const instance = service(
      fakeBinary(script),
      mkdtempSync(join(tmpdir(), "xerj-data-")),
      projectRoot,
      graphConfig,
    );
    running.push(instance);

    await instance.start();
    for (let waited = 0; waited < 5_000; waited += 100) {
      if (instance.snapshot().lastRun) break;
      await Bun.sleep(100);
    }

    const runs = readFileSync(argsLog, "utf8").trim().split("\n");
    expect(runs[0]).toContain("--brain");
    expect(runs[0]).not.toContain("--watch");
    expect(runs[0]).not.toContain("--no-graph");
    expect(instance.snapshot().lastRun?.records).toBe(4);
  }, 15_000);
});

describe("CorpusService exits", () => {
  test(
    "a decision request is reported with the limit that triggered it",
    async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), "xerj-project-"));
      const script = `#!/bin/sh
echo '{"decision":"exceeds limits","estimate_bytes":90000000000}'
exit 4
`;
      const warnings: string[] = [];
      const instance = new CorpusService({
        binaryPath: fakeBinary(script),
        nodeUrl: "http://127.0.0.1:9200",
        projectRoot,
        prefix: "xop-project-12345678",
        stateRoot: join(projectRoot, ".xerj"),
        config: {
          ...DEFAULT_CONFIG,
          index: { ...DEFAULT_CONFIG.index, watch: true, periodicMs: 60_000 },
        },
        storage: storage(),
        logger: { ...logger, warn: (message: string) => warnings.push(message) },
      });
      running.push(instance);

      await instance.start();
      for (let waited = 0; waited < 5_000; waited += 100) {
        if (instance.snapshot().lastError !== null) break;
        await Bun.sleep(100);
      }

      // A one-shot pass that needs a decision indexed nothing, so it is an
      // error the panel shows, not a quiet idle.
      expect(instance.snapshot().state).toBe("error");
      expect(instance.snapshot().lastError).toContain("needs a decision");
      expect(warnings.some((warning) => warning.includes("needs a decision"))).toBe(
        true,
      );
    },
    15_000,
  );

  test("stop is idempotent and reports idle", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "xerj-project-"));
    const instance = service(
      fakeBinary("#!/bin/sh\necho '{\"doc_kind\":\"run\",\"generation\":1,\"records_total\":1}'\nsleep 5\n"),
      join(projectRoot, ".xerj"),
      projectRoot,
    );
    running.push(instance);

    await instance.start();
    await instance.stop();
    await instance.stop();

    expect(instance.snapshot().state).toBe("idle");
  }, 15_000);
});
