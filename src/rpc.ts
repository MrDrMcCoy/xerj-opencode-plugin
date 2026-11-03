// Typed contract shared by the server part, the TUI part, and any client.
// Everything crosses a JSON boundary, so the schemas are JSON Schema objects
// rather than TypeScript-only shapes. The casts are unavoidable: JSON Schema
// values are structurally `unknown` in the plugin's type surface.

import { Rpc } from "@opencode/plugin/rpc";

export interface NodeStatus {
  readonly phase: "starting" | "ready" | "error" | "disabled";
  readonly baseUrl: string | null;
  readonly serverVersion: string | null;
  readonly spawned: boolean;
  readonly error: string | null;
}

export interface BinaryStatus {
  readonly version: string | null;
  readonly path: string | null;
  readonly upgraded: boolean;
}

export interface IndexStatus {
  readonly prefix: string;
  readonly docs: number;
  readonly bytes: number;
  readonly indices: number;
}

export interface UsageStatus {
  readonly queries: number;
  readonly hits: number;
  readonly hitRate: number;
  readonly bytesReturned: number;
  readonly tokensSaved: number;
}

export interface StatusSnapshot {
  readonly pluginVersion: string;
  readonly updatedAt: number;
  readonly node: NodeStatus;
  readonly binary: BinaryStatus;
  readonly index: IndexStatus;
  readonly usage: UsageStatus;
  readonly warnings: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
}

type ValueSchema = Rpc.PortableValueSchema;
type EventSchema = Rpc.PortableEventDefinition["schema"];

function object(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function valueSchema(properties: Record<string, unknown>): ValueSchema {
  return object(properties) as unknown as ValueSchema;
}

function eventSchema(properties: Record<string, unknown>): EventSchema {
  return object(properties) as unknown as EventSchema;
}

const definition = {
  id: "xerj",
  methods: {
    status: {
      input: valueSchema({}),
      output: valueSchema({
        pluginVersion: { type: "string" },
        updatedAt: { type: "number" },
        node: object({
          phase: { type: "string", enum: ["starting", "ready", "error", "disabled"] },
          baseUrl: { type: ["string", "null"] },
          serverVersion: { type: ["string", "null"] },
          spawned: { type: "boolean" },
          error: { type: ["string", "null"] },
        }),
        binary: object({
          version: { type: ["string", "null"] },
          path: { type: ["string", "null"] },
          upgraded: { type: "boolean" },
        }),
        index: object({
          prefix: { type: "string" },
          docs: { type: "number" },
          bytes: { type: "number" },
          indices: { type: "number" },
        }),
        usage: object({
          queries: { type: "number" },
          hits: { type: "number" },
          hitRate: { type: "number" },
          bytesReturned: { type: "number" },
          tokensSaved: { type: "number" },
        }),
        warnings: { type: "array", items: { type: "string" } },
        errors: { type: "array", items: { type: "string" } },
      }),
    },
  },
  events: {
    updated: {
      schema: eventSchema({ updatedAt: { type: "number" } }),
    },
  },
} satisfies Rpc.PortableDefinition;

export const XerjRpc = Rpc.define(definition);

export const PLUGIN_VERSION = "0.1.0";
