import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type Config } from "../../src/config.ts";
import {
  autoindexArgs,
  corpusLayout,
  exitMeaning,
  parseRunDocument,
} from "../../src/index/corpus.ts";

const layout = corpusLayout("/data/project", "xop-project-12345678", "/data/engine");

function config(patch: Partial<Config["index"]> = {}): Config {
  return { ...DEFAULT_CONFIG, index: { ...DEFAULT_CONFIG.index, ...patch } };
}

describe("corpusLayout", () => {
  test("keeps the journal under the engine data it describes", () => {
    expect(layout.stateDir).toBe("/data/engine/state/xop-project-12345678");
  });
});

describe("autoindexArgs", () => {
  test("the non-graph reconciling path when graph mode is off", () => {
    const args = autoindexArgs({
      layout,
      nodeUrl: "http://127.0.0.1:9200",
      config: config({ graph: false }),
      watch: false,
    });

    expect(args).toContain("--no-graph");
    expect(args).toContain("--json");
    expect(args).toContain("--prefix");
    expect(args[args.indexOf("--prefix") + 1]).toBe("xop-project-12345678");
    expect(args[args.indexOf("--state-dir") + 1]).toBe(
      "/data/engine/state/xop-project-12345678",
    );
    expect(args).not.toContain("--watch");
  });

  test("watch mode adds the debounce window in non-graph mode", () => {
    const args = autoindexArgs({
      layout,
      nodeUrl: "http://127.0.0.1:9200",
      config: config({ debounceMs: 1500, graph: false }),
      watch: true,
    });

    expect(args).toContain("--watch");
    expect(args[args.indexOf("--debounce") + 1]).toBe("1500");
  });

  test("forwards the optional guards", () => {
    const args = autoindexArgs({
      layout,
      nodeUrl: "http://127.0.0.1:9200",
      config: config({ workers: 4, semantic: false, maxBytes: 1024, maxMinutes: 3 }),
      watch: false,
    });

    expect(args[args.indexOf("--workers") + 1]).toBe("4");
    expect(args).toContain("--no-semantic");
    expect(args[args.indexOf("--max-index-size") + 1]).toBe("1024");
    expect(args[args.indexOf("--max-minutes") + 1]).toBe("3");
  });

  test("omits the optional flags when unset", () => {
    const args = autoindexArgs({
      layout,
      nodeUrl: "http://127.0.0.1:9200",
      config: config({ workers: null, semantic: true, maxBytes: 0 }),
      watch: false,
    });

    expect(args).not.toContain("--workers");
    expect(args).not.toContain("--no-semantic");
    expect(args).not.toContain("--max-index-size");
  });
});

describe("parseRunDocument", () => {
  test("reads the fields the node emits", () => {
    const line = JSON.stringify({
      doc_kind: "run",
      started: "2026-11-03T20:39:19.079268106+00:00",
      generation: 2,
      files_total: 9,
      files_indexed: 4,
      records_total: 75,
      junk_records_total: 1,
    });

    const run = parseRunDocument(line);
    expect(run?.generation).toBe(2);
    expect(run?.files).toBe(4);
    expect(run?.records).toBe(75);
    expect(run?.junk).toBe(1);
    expect(run?.at).toBe(Date.parse("2026-11-03T20:39:19.079268106+00:00"));
  });

  test("ignores non-run JSON and plain progress lines", () => {
    expect(parseRunDocument('{"decision":"proceed"}')).toBeNull();
    expect(parseRunDocument("xerj-progress phase=scan pct=10")).toBeNull();
    expect(parseRunDocument("{not json")).toBeNull();
  });
});

describe("exitMeaning", () => {
  test("maps the documented exit codes", () => {
    expect(exitMeaning(0)).toBe("ok");
    expect(exitMeaning(3)).toBe("junk");
    expect(exitMeaning(4)).toBe("decision");
    expect(exitMeaning(2)).toBe("usage");
    expect(exitMeaning(1)).toBe("error");
    expect(exitMeaning(null)).toBe("error");
  });
});
