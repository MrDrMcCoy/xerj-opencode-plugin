import { describe, expect, test } from "bun:test";
import { parseSize } from "../../src/node/client.ts";

describe("parseSize", () => {
  test("parses the units _cat/indices emits", () => {
    expect(parseSize("0b")).toBe(0);
    expect(parseSize("42.7kb")).toBe(Math.round(42.7 * 1024));
    expect(parseSize("1.2mb")).toBe(Math.round(1.2 * 1024 ** 2));
    expect(parseSize("2gb")).toBe(2 * 1024 ** 3);
  });

  test("treats a bare number as bytes", () => {
    expect(parseSize("512")).toBe(512);
  });

  test("returns zero for unknown input", () => {
    expect(parseSize(undefined)).toBe(0);
    expect(parseSize("")).toBe(0);
    expect(parseSize("lots")).toBe(0);
  });
});
