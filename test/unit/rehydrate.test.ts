import { describe, expect, test } from "bun:test";
import {
  buildRecallBlock,
  formatRecallBlock,
  recallKey,
} from "../../src/rehydrate.ts";

const ROOT = "/project";

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
}

function reader(files: Record<string, string | null>): {
  reads: string[];
  readFile: (path: string) => Promise<string | null>;
} {
  const reads: string[] = [];
  return {
    reads,
    readFile: async (path) => {
      reads.push(path);
      return files[path] ?? null;
    },
  };
}

describe("formatRecallBlock", () => {
  test("wraps the entries with the recall marker", () => {
    const block = formatRecallBlock([{ location: "src/a.ts:3", body: "code" }]);
    expect(block.startsWith("<xerj-recall>")).toBe(true);
    expect(block).toContain("src/a.ts:3\ncode");
    expect(block.endsWith("</xerj-recall>")).toBe(true);
  });
});

describe("buildRecallBlock", () => {
  test("reads a window around the cited line", async () => {
    const { readFile } = reader({ [`${ROOT}/src/a.ts`]: numberedLines(60) });

    const block = await buildRecallBlock({
      projectRoot: ROOT,
      locations: [{ path: "src/a.ts", line: 10 }],
      maxBytes: 4000,
      readFile,
    });

    expect(block).not.toBeNull();
    expect(block?.text).toContain("src/a.ts:10");
    expect(block?.text).toContain("line 10");
    expect(block?.text).toContain("line 33");
    // Past the window, so the block stays a passage rather than a file.
    expect(block?.text).not.toContain("line 34");
    expect(block?.locations).toEqual(["src/a.ts:10"]);
  });

  test("keeps the newest citations first and drops the older ones", async () => {
    const files: Record<string, string> = {};
    for (const name of ["a", "b", "c", "d", "e"]) {
      files[`${ROOT}/${name}.ts`] = `body of ${name}`;
    }
    const { readFile } = reader(files);

    const block = await buildRecallBlock({
      projectRoot: ROOT,
      locations: [
        { path: "a.ts", line: 1 },
        { path: "b.ts", line: 1 },
        { path: "c.ts", line: 1 },
        { path: "d.ts", line: 1 },
        { path: "e.ts", line: 1 },
      ],
      maxBytes: 4000,
      readFile,
    });

    expect(block?.locations).toEqual(["c.ts:1", "d.ts:1", "e.ts:1"]);
    expect(block?.text).not.toContain("body of a");
    expect(block?.text).not.toContain("body of b");
    expect(block?.text.indexOf("body of c")).toBeLessThan(
      block?.text.indexOf("body of d") ?? -1,
    );
  });

  test("honours the location limit", async () => {
    const { readFile } = reader({
      [`${ROOT}/a.ts`]: "a",
      [`${ROOT}/b.ts`]: "b",
    });

    const block = await buildRecallBlock({
      projectRoot: ROOT,
      locations: [
        { path: "a.ts", line: 1 },
        { path: "b.ts", line: 1 },
      ],
      maxBytes: 4000,
      readFile,
      maxLocations: 1,
    });

    expect(block?.locations).toEqual(["b.ts:1"]);
  });

  test("skips excluded, missing, outside and non-file locations", async () => {
    const { readFile, reads } = reader({
      [`${ROOT}/keep.ts`]: "kept",
      [`${ROOT}/gone.ts`]: null,
    });

    const block = await buildRecallBlock({
      projectRoot: ROOT,
      locations: [
        { path: "keep.ts", line: 1 },
        { path: "gone.ts", line: 1 },
        { path: "../outside.ts", line: 1 },
        { path: "/etc/passwd", line: 1 },
        { path: "https://example.com/page", line: 1 },
        { path: "excluded.ts", line: 1 },
      ],
      maxBytes: 4000,
      exclude: (key) => key === "excluded.ts:1",
      readFile,
    });

    expect(block?.locations).toEqual(["keep.ts:1"]);
    expect(block?.text).toContain("kept");
    // A path that resolves is read; one that does not is never touched.
    expect(reads).toEqual([`${ROOT}/keep.ts`, `${ROOT}/gone.ts`]);
  });

  test("never exceeds the byte cap", async () => {
    const long = "x".repeat(5000);
    const { readFile } = reader({
      [`${ROOT}/a.ts`]: long,
      [`${ROOT}/b.ts`]: long,
      [`${ROOT}/c.ts`]: long,
    });

    const block = await buildRecallBlock({
      projectRoot: ROOT,
      locations: [
        { path: "a.ts", line: 1 },
        { path: "b.ts", line: 1 },
        { path: "c.ts", line: 1 },
      ],
      maxBytes: 900,
      readFile,
    });

    expect(block).not.toBeNull();
    expect(block!.bytes).toBeLessThanOrEqual(900);
    expect(Buffer.byteLength(block!.text, "utf8")).toBe(block!.bytes);
  });

  test("returns null when nothing can be restored", async () => {
    const { readFile } = reader({});

    expect(
      await buildRecallBlock({
        projectRoot: ROOT,
        locations: [{ path: "missing.ts", line: 4 }],
        maxBytes: 600,
        readFile,
      }),
    ).toBeNull();

    expect(
      await buildRecallBlock({
        projectRoot: ROOT,
        locations: [],
        maxBytes: 600,
        readFile,
      }),
    ).toBeNull();
  });

  test("returns null when the budget cannot hold a passage", async () => {
    const { readFile } = reader({ [`${ROOT}/a.ts`]: "text" });

    expect(
      await buildRecallBlock({
        projectRoot: ROOT,
        locations: [{ path: "a.ts", line: 1 }],
        maxBytes: 40,
        readFile,
      }),
    ).toBeNull();
  });

  test("ignores a line past the end of the file", async () => {
    const { readFile } = reader({ [`${ROOT}/a.ts`]: "first\nlast" });

    const block = await buildRecallBlock({
      projectRoot: ROOT,
      locations: [{ path: "a.ts", line: 900 }],
      maxBytes: 600,
      readFile,
    });

    expect(block?.text).toContain("last");
  });
});

describe("recallKey", () => {
  test("matches the session dedupe format", () => {
    expect(recallKey({ path: "src/a.ts", line: 3 })).toBe("src/a.ts:3");
  });
});
