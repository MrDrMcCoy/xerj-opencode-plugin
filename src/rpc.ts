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
  readonly target: string | null;
}

export interface IndexStatus {
  readonly prefix: string;
  readonly docs: number;
  readonly bytes: number;
  readonly indices: number;
  readonly state: "disabled" | "starting" | "watching" | "idle" | "error";
  readonly lastRunAt: number | null;
  readonly lastGeneration: number | null;
  readonly lastRecords: number | null;
  readonly restarts: number;
  readonly lastError: string | null;
}

export interface UsageStatus {
  readonly queries: number;
  readonly hits: number;
  readonly hitRate: number;
  readonly bytesReturned: number;
  readonly bytesRead: number;
  readonly tokensSaved: number;
}

export interface ConfigStatus {
  readonly indexRoot: string;
  readonly brain: ReadonlyArray<string>;
  readonly watch: boolean;
  readonly contextEnabled: boolean;
}

export interface StatusSnapshot {
  readonly pluginVersion: string;
  readonly updatedAt: number;
  readonly node: NodeStatus;
  readonly binary: BinaryStatus;
  readonly index: IndexStatus;
  readonly config: ConfigStatus;
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
          target: { type: ["string", "null"] },
        }),
        index: object({
          prefix: { type: "string" },
          docs: { type: "number" },
          bytes: { type: "number" },
          indices: { type: "number" },
          state: {
            type: "string",
            enum: ["disabled", "starting", "watching", "idle", "error"],
          },
          lastRunAt: { type: ["number", "null"] },
          lastGeneration: { type: ["number", "null"] },
          lastRecords: { type: ["number", "null"] },
          restarts: { type: "number" },
          lastError: { type: ["string", "null"] },
        }),
        config: object({
          indexRoot: { type: "string" },
          brain: { type: "array", items: { type: "string" } },
          watch: { type: "boolean" },
          contextEnabled: { type: "boolean" },
        }),
        usage: object({
          queries: { type: "number" },
          hits: { type: "number" },
          hitRate: { type: "number" },
          bytesReturned: { type: "number" },
          bytesRead: { type: "number" },
          tokensSaved: { type: "number" },
        }),
        warnings: { type: "array", items: { type: "string" } },
        errors: { type: "array", items: { type: "string" } },
      }),
    },
    reindex: {
      input: valueSchema({}),
      output: valueSchema({ queued: { type: "boolean" } }),
    },
  },
  events: {
    updated: {
      schema: eventSchema({ updatedAt: { type: "number" } }),
    },
  },
} satisfies Rpc.PortableDefinition;

export const XerjRpc = Rpc.define(definition);

export const PLUGIN_VERSION = "0.1.1";
