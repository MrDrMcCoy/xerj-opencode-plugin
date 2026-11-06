// Registration-time instrumentation. A tool is timed here instead of at each
// call site, so a tool added later is measured without being touched. The
// execution context must pass through untouched: dropping it breaks the session
// id and the abort signal for every measured tool, silently.

import type { TelemetryStore } from "../telemetry/store.ts";
import type { OpType } from "../telemetry/types.ts";

export interface ToolLike {
  readonly name: string;
  readonly execute: (input: unknown, context: unknown) => Promise<unknown>;
}

/** Wraps every tool in a span named after it, forwards both arguments. */
export function measuredTools<T extends ToolLike>(
  tools: ReadonlyArray<T>,
  telemetry: Pick<TelemetryStore, "span">,
): ReadonlyArray<T> {
  return tools.map((tool) => ({
    ...tool,
    execute: (input: unknown, context: unknown) =>
      telemetry.span(
        `tool.${tool.name}` as OpType,
        () => tool.execute(input, context),
        (result) =>
          typeof result === "object" && result !== null
            ? { bytes: Buffer.byteLength(JSON.stringify(result), "utf8") }
            : undefined,
      ),
  }));
}
