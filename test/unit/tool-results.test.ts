import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contentBytes,
  handleToolResult,
  isOutside,
  toolCwd,
  type ToolResultEvent,
  type ToolResultTargets,
} from "../../src/hooks/tool-results.ts";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
} as never;

interface Recorded {
  readonly urls: Array<{ url: string; chars: number }>;
  readonly files: Array<{ path: string; skip: boolean }>;
  readonly reads: Array<{ session: string; path: string; bytes: number }>;
  readonly touched: string[];
  invalidations: number;
}

function targets(
  projectRoot: string,
  options: { spool?: boolean; result?: unknown } = {},
): { targets: ToolResultTargets; recorded: Recorded } {
  const recorded: Recorded = {
    urls: [],
    files: [],
    reads: [],
    touched: [],
    invalidations: 0,
  };

  const spool = options.spool === false
    ? null
    : {
        ingestUrl: async (url: string, content: string) => {
          recorded.urls.push({ url, chars: content.length });
          return options.result ?? null;
        },
        ingestExternalFile: async (
          path: string,
          opts: { skipUnchanged?: boolean } = {},
        ) => {
          recorded.files.push({ path, skip: opts.skipUnchanged === true });
          return options.result ?? null;
        },
      };

  return {
    recorded,
    targets: {
      projectRoot,
      logger,
      spool,
      invalidate: () => {
        recorded.invalidations += 1;
      },
      touch: (sessionID) => {
        recorded.touched.push(sessionID);
      },
      recordRead: async (session, path, bytes) => {
        recorded.reads.push({ session, path, bytes });
      },
    },
  };
}

function event(overrides: Partial<ToolResultEvent>): ToolResultEvent {
  return {
    tool: "read",
    status: "completed",
    sessionID: "s1",
    input: {},
    result: { content: "" },
    ...overrides,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("handleToolResult", () => {
  test("ignores a call that did not complete", async () => {
    const { targets: sink, recorded } = targets("/proj");
    await handleToolResult(event({ status: "error", tool: "read" }), sink);

    expect(recorded.touched).toEqual([]);
    expect(recorded.reads).toEqual([]);
  });

  test("touches the session on a completed call", async () => {
    const { targets: sink, recorded } = targets("/proj");
    await handleToolResult(event({ tool: "grep" }), sink);

    expect(recorded.touched).toEqual(["s1"]);
  });

  test("spools a fetched document long enough to be one", async () => {
    const { targets: sink, recorded } = targets("/proj", { result: { ok: true } });
    await handleToolResult(
      event({ tool: "webfetch", input: { url: "https://x.test/a" }, result: { content: "x".repeat(500) } }),
      sink,
    );
    await flush();

    expect(recorded.urls).toEqual([{ url: "https://x.test/a", chars: 500 }]);
    expect(recorded.invalidations).toBe(1);
  });

  test("does not spool a short result", async () => {
    const { targets: sink, recorded } = targets("/proj");
    await handleToolResult(
      event({ tool: "webfetch", input: { url: "https://x.test/a" }, result: { content: "too short" } }),
      sink,
    );
    await flush();

    expect(recorded.urls).toEqual([]);
  });

  test("records a read and indexes a file outside the project", async () => {
    const { targets: sink, recorded } = targets("/proj", { result: { ok: true } });
    await handleToolResult(
      event({ input: { filePath: "/tmp/notes.md" }, result: { content: "abc" } }),
      sink,
    );
    await flush();

    expect(recorded.reads).toEqual([{ session: "s1", path: "/tmp/notes.md", bytes: 3 }]);
    expect(recorded.files).toEqual([{ path: "/tmp/notes.md", skip: true }]);
    expect(recorded.invalidations).toBe(1);
  });

  test("records a read without ingesting a file inside the project", async () => {
    const { targets: sink, recorded } = targets("/proj");
    await handleToolResult(
      event({ input: { path: "/proj/src/a.ts" }, result: { content: [{ text: "hello" }] } }),
      sink,
    );
    await flush();

    expect(recorded.reads[0]?.bytes).toBe(5);
    expect(recorded.files).toEqual([]);
  });

  test("a read without a path records nothing", async () => {
    const { targets: sink, recorded } = targets("/proj");
    await handleToolResult(event({ input: { other: 1 } }), sink);

    expect(recorded.reads).toEqual([]);
  });

  test("indexes files a shell command names outside the project", async () => {
    const project = await mkdtemp(join(tmpdir(), "tool-results-"));
    const file = join(project, "..", `${Date.now()}-probe.md`);
    await writeFile(file, "probe\n");

    try {
      const { targets: sink, recorded } = targets(join(project, "proj"), {
        result: { ok: true },
      });
      await handleToolResult(
        event({ tool: "bash", input: { command: `cat ${file}` } }),
        sink,
      );
      await flush();

      expect(recorded.files.map((entry) => entry.path)).toEqual([file]);
    } finally {
      await rm(file, { force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  test("a shell command with no readable path ingests nothing", async () => {
    const { targets: sink, recorded } = targets("/proj");
    await handleToolResult(
      event({ tool: "bash", input: { command: "echo hello > /tmp/out.txt" } }),
      sink,
    );
    await flush();

    expect(recorded.files).toEqual([]);
  });

  test("a missing spool makes every ingest a no-op", async () => {
    const { targets: sink, recorded } = targets("/proj", { spool: false });
    await handleToolResult(
      event({ tool: "webfetch", input: { url: "https://x.test/a" }, result: { content: "x".repeat(500) } }),
      sink,
    );
    await handleToolResult(event({ input: { filePath: "/tmp/a.md" }, result: { content: "abc" } }), sink);
    await handleToolResult(event({ tool: "bash", input: { command: "cat /tmp/a.md" } }), sink);
    await flush();

    expect(recorded.urls).toEqual([]);
    expect(recorded.files).toEqual([]);
    expect(recorded.reads).toHaveLength(1);
  });

  test("an ingest failure is logged, not raised", async () => {
    const { targets: sink } = targets("/proj");
    const failing = {
      ...sink,
      spool: {
        ingestUrl: async () => {
          throw new Error("disk full");
        },
        ingestExternalFile: async () => {
          throw new Error("disk full");
        },
      },
    };

    await handleToolResult(
      event({ tool: "webfetch", input: { url: "https://x.test/a" }, result: { content: "x".repeat(500) } }),
      failing,
    );
    await handleToolResult(event({ input: { filePath: "/tmp/a.md" }, result: { content: "abc" } }), failing);
    await flush();
  });
});

describe("tool result helpers", () => {
  test("toolCwd resolves a relative directory against the project", () => {
    expect(toolCwd({ cwd: "sub" }, "/proj")).toBe("/proj/sub");
    expect(toolCwd({ workdir: "/abs" }, "/proj")).toBe("/abs");
    expect(toolCwd({}, "/proj")).toBe("/proj");
    expect(toolCwd(null, "/proj")).toBe("/proj");
  });

  test("isOutside excludes the root and its children", () => {
    expect(isOutside("/proj", "/proj/a.ts")).toBe(false);
    expect(isOutside("/proj", "/proj")).toBe(false);
    expect(isOutside("/proj", "/other/a.ts")).toBe(true);
    expect(isOutside("/proj", "/project-sibling/a.ts")).toBe(true);
  });

  test("contentBytes counts strings and text parts", () => {
    expect(contentBytes("abc")).toBe(3);
    expect(contentBytes([{ text: "abc" }, { text: "de" }, { other: 1 }])).toBe(5);
    expect(contentBytes({ not: "content" })).toBe(0);
  });
});
