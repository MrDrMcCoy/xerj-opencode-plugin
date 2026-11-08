// The config parser must leave string contents alone. A regex that strips
// every `//` also eats a protocol-relative URL or a Windows UNC path and
// corrupts the whole document.

import { describe, expect, test } from "bun:test";
import { parseJsonc } from "../../src/jsonc.ts";

describe("parseJsonc", () => {
  test("keeps protocol-relative and double-slash strings", () => {
    expect(parseJsonc('{"url":"//host/path","pattern":"a//b"}')).toEqual({
      url: "//host/path",
      pattern: "a//b",
    });
    expect(parseJsonc('{"url":"https://example.com/x"}')).toEqual({
      url: "https://example.com/x",
    });
  });

  test("strips line and block comments outside strings", () => {
    expect(
      parseJsonc(`{
        // leading
        "a": 1, /* inline */
        "b": 2 // trailing
      }`),
    ).toEqual({ a: 1, b: 2 });
  });

  test("does not treat a comment marker inside a string as a comment", () => {
    expect(parseJsonc('{"text":"a // not a comment","b":"/* nope */"}')).toEqual({
      text: "a // not a comment",
      b: "/* nope */",
    });
  });

  test("removes trailing commas but not a comma inside a string", () => {
    expect(parseJsonc('{"a":[1,2,],"text":"x,}"}')).toEqual({
      a: [1, 2],
      text: "x,}",
    });
  });

  test("handles an escaped quote", () => {
    expect(parseJsonc('{"text":"a\\"b"}')).toEqual({ text: 'a"b' });
  });

  test("a malformed document is empty rather than a throw", () => {
    expect(parseJsonc("{not json")).toEqual({});
    expect(parseJsonc("[]")).toEqual({});
  });
});
