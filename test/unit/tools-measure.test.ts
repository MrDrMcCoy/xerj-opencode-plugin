// The registration-time wrapper times every tool. It must not change what the
// tool sees: the second argument carries the session id and the abort signal,
// and a wrapper that drops it breaks both without any error.

import { describe, expect, test } from "bun:test";
import { measuredTools, type ToolLike } from "../../src/tools/measure.ts";

function recorder(): {
  readonly tools: ReadonlyArray<ToolLike>;
  readonly seen: Array<{ op: string; input: unknown; context: unknown }>;
} {
  const seen: Array<{ op: string; input: unknown; context: unknown }> = [];
  const telemetry = {
    span: async <T>(
      op: string,
      body: () => Promise<T>,
      meta?: (result: T) => unknown,
    ): Promise<T> => {
      const result = await body();
      void meta?.(result);
      return result;
    },
  };
  const tool: ToolLike = {
    name: "probe",
    execute: async (input, context) => {
      seen.push({ op: "execute", input, context });
      return { content: "ok" };
    },
  };

  const measured = measuredTools([tool], telemetry as never);
  return { tools: measured, seen };
}

describe("measuredTools", () => {
  test("forwards the input and the execution context", async () => {
    const { tools, seen } = recorder();
    const signal = new AbortController().signal;
    const context = { sessionID: "ses-forwarded", signal };
    const input = { query: "anything" };

    await tools[0]?.execute(input, context);

    expect(seen).toEqual([{ op: "execute", input, context }]);
    expect(seen[0]?.context).toBe(context);
  });

  test("keeps the tool name and its other fields", async () => {
    const { tools } = recorder();
    expect(tools[0]?.name).toBe("probe");
  });

  test("a throwing tool still throws the same error", async () => {
    const boom = new Error("probe failed");
    const tools = measuredTools(
      [
        {
          name: "probe",
          execute: async (_input: unknown, _context: unknown) => {
            throw boom;
          },
        },
      ],
      {
        span: async <T>(_op: string, body: () => Promise<T>) => body(),
      } as never,
    );

    await expect(tools[0]?.execute({}, {})).rejects.toBe(boom);
  });
});
