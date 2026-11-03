import { describe, expect, test } from "bun:test";
import {
  formatContextBlock,
  formatCorpusBlock,
  shouldRetrieve,
} from "../../src/hooks/session.ts";

describe("shouldRetrieve", () => {
  test("skips slash commands", () => {
    expect(shouldRetrieve("/xerj-reindex")).toBe(false);
  });

  test("skips short replies", () => {
    expect(shouldRetrieve("begin")).toBe(false);
    expect(shouldRetrieve("yes, do it")).toBe(false);
  });

  test("accepts a real question", () => {
    expect(shouldRetrieve("where is the watch process started?")).toBe(true);
  });
});

describe("context blocks", () => {
  test("wraps the passages with the citation instruction", () => {
    const block = formatContextBlock("[1] src/a.ts:3\ncode");
    expect(block.startsWith("<xerj-context>")).toBe(true);
    expect(block).toContain("Cite path:line");
    expect(block).toContain("[1] src/a.ts:3");
    expect(block.endsWith("</xerj-context>")).toBe(true);
  });

  test("wraps the corpus summary", () => {
    expect(formatCorpusBlock("42 records")).toBe("<xerj-corpus>\n42 records\n</xerj-corpus>");
  });
});
