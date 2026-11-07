// The host validates every RPC call against the declared input schema before
// the handler runs, so a payload the TUI sends must satisfy that schema or the
// command fails with `rpc.invalid_input` and the reason never reaches the
// handler. This suite pins the payloads the TUI actually sends.

import { describe, expect, test } from "bun:test";
import { XerjRpc } from "../../src/rpc.ts";
import { validate, type Schema } from "./rpc-schema.ts";

function inputOf(method: keyof typeof XerjRpc.methods): Schema {
  return XerjRpc.methods[method].input as Schema;
}

/** The payloads the TUI passes to its RPC methods, by method name. */
const TUI_PAYLOADS: ReadonlyArray<[keyof typeof XerjRpc.methods, unknown]> = [
  ["status", {}],
  ["reindex", {}],
  ["wrapup", {}],
  ["dreamer", {}],
  ["prjdocs", {}],
  ["prjdocs", { eager: true }],
  ["sysdocs", {}],
  ["remember", { text: "a fact" }],
  ["search", { query: "why is the pump loud" }],
  ["uiLog", { entries: [] }],
  [
    "uiLog",
    {
      entries: [
        { level: "debug", message: "sidebar render", detail: "collapsed=false" },
        { level: "error", message: "sidebar render failed" },
      ],
    },
  ],
];

describe("RPC input schemas", () => {
  test("every payload the TUI sends validates", () => {
    for (const [method, payload] of TUI_PAYLOADS) {
      expect({ method, problems: validate(inputOf(method), payload) }).toEqual({
        method,
        problems: [],
      });
    }
  });

  test("project docs runs with no options, which is how /xerj-prjdocs calls it", () => {
    // Both keys are optional: the command sends `{}` for an ordinary run, and a
    // schema that demands them rejects the command before the handler runs.
    expect(inputOf("prjdocs").required).toEqual([]);
    expect(validate(inputOf("prjdocs"), {})).toEqual([]);
  });

  test("dreamer runs without a session id", () => {
    expect(inputOf("dreamer").required).toEqual([]);
    expect(validate(inputOf("dreamer"), {})).toEqual([]);
  });

  test("wrapup runs without a session id", () => {
    expect(inputOf("wrapup").required).toEqual([]);
    expect(validate(inputOf("wrapup"), {})).toEqual([]);
  });

  test("a declared required key is still enforced", () => {
    expect(validate(inputOf("remember"), {})).toEqual(["input is missing text"]);
    expect(validate(inputOf("remember"), { text: 5 })).toEqual([
      "input.text must be string",
    ]);
    expect(validate(inputOf("search"), { query: "x", extra: 1 })).toHaveLength(1);
  });

  test("an unknown key is reported, so a typo cannot look like a success", () => {
    const problems = validate(inputOf("prjdocs"), { eager: "yes" });

    expect(problems).toEqual(["input.eager must be boolean"]);
  });

  test("every method declares exactly the properties it requires or not", () => {
    for (const [name, method] of Object.entries(XerjRpc.methods)) {
      const schema = method.input as Schema;
      const properties = Object.keys((schema.properties ?? {}) as object);
      const required = (schema.required ?? []) as string[];

      expect({ name, extra: required.filter((key) => !properties.includes(key)) }).toEqual({
        name,
        extra: [],
      });
    }
  });
});
