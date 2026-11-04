// Typed contract shared by the server part, the TUI part, and any client.
// Everything crosses a JSON boundary, so the schemas are JSON Schema objects
// rather than TypeScript-only shapes. The casts are unavoidable: JSON Schema
// values are structurally `unknown` in the plugin's type surface.

import { Rpc } from "@opencode/plugin/rpc";
import packageJson from "../package.json";

export interface NodeStatus {
  readonly phase: "starting" | "ready" | "error" | "disabled";
  readonly baseUrl: string | null;
  readonly serverVersion: string | null;
  readonly spawned: boolean;
  /** Lifecycle of this project's node, including an idle stop. */
  readonly state: "stopped" | "starting" | "running" | "error";
  readonly pid: number | null;
  /** When the idle timer will stop the node, or null when disabled. */
  readonly idleAt: number | null;
  readonly sessions: number;
  readonly error: string | null;
}

export interface BinaryStatus {
  readonly version: string | null;
  readonly path: string | null;
  readonly upgraded: boolean;
  readonly target: string | null;
}

export interface DatasetStatus {
  readonly name: string;
  readonly docs: number;
  readonly bytes: number;
}

export interface BrainStatus {
  readonly name: string;
  readonly prefix: string;
  readonly docs: number;
  readonly edges: number;
  readonly lastRunAt: number | null;
  readonly error: string | null;
}

export interface MemoryStatus {
  readonly namespace: string;
  readonly count: number;
}

export interface CitedFileStatus {
  readonly path: string;
  readonly citations: number;
  readonly bytes: number;
}

export interface IndexStatus {
  readonly prefix: string;
  readonly docs: number;
  readonly bytes: number;
  readonly indices: number;
  readonly state:
    | "disabled"
    | "starting"
    | "watching"
    | "shared"
    | "idle"
    | "error";
  readonly lastRunAt: number | null;
  readonly lastGeneration: number | null;
  readonly lastRecords: number | null;
  readonly restarts: number;
  readonly lastError: string | null;
  readonly datasets: ReadonlyArray<DatasetStatus>;
}

export interface UsageStatus {
  readonly queries: number;
  readonly hits: number;
  readonly hitRate: number;
  readonly bytesReturned: number;
  readonly bytesRead: number;
  readonly baselineBytes: number;
  readonly savedBytes: number;
  readonly tokensSaved: number;
  readonly topFiles: ReadonlyArray<CitedFileStatus>;
}

export interface CounterStatus {
  readonly rpcCalls: number;
  readonly injectedTurns: number;
  readonly nodeSpawns: number;
  readonly http429: number;
  readonly indexRuns: number;
}

export interface ConfigStatus {
  readonly indexRoot: string;
  readonly storageRoot: string;
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
  readonly memory: MemoryStatus;
  readonly brains: ReadonlyArray<BrainStatus>;
  readonly counters: CounterStatus;
  readonly recent: ReadonlyArray<string>;
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
          state: { type: "string", enum: ["stopped", "starting", "running", "error"] },
          pid: { type: ["number", "null"] },
          idleAt: { type: ["number", "null"] },
          sessions: { type: "number" },
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
            enum: [
              "disabled",
              "starting",
              "watching",
              "shared",
              "idle",
              "error",
            ],
          },
          lastRunAt: { type: ["number", "null"] },
          lastGeneration: { type: ["number", "null"] },
          lastRecords: { type: ["number", "null"] },
          restarts: { type: "number" },
          lastError: { type: ["string", "null"] },
          datasets: {
            type: "array",
            items: object({
              name: { type: "string" },
              docs: { type: "number" },
              bytes: { type: "number" },
            }),
          },
        }),
        config: object({
          indexRoot: { type: "string" },
          storageRoot: { type: "string" },
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
          baselineBytes: { type: "number" },
          savedBytes: { type: "number" },
          tokensSaved: { type: "number" },
          topFiles: {
            type: "array",
            items: object({
              path: { type: "string" },
              citations: { type: "number" },
              bytes: { type: "number" },
            }),
          },
        }),
        memory: object({
          namespace: { type: "string" },
          count: { type: "number" },
        }),
        brains: {
          type: "array",
          items: object({
            name: { type: "string" },
            prefix: { type: "string" },
            docs: { type: "number" },
            edges: { type: "number" },
            lastRunAt: { type: ["number", "null"] },
            error: { type: ["string", "null"] },
          }),
        },
        counters: object({
          rpcCalls: { type: "number" },
          injectedTurns: { type: "number" },
          nodeSpawns: { type: "number" },
          http429: { type: "number" },
          indexRuns: { type: "number" },
        }),
        recent: { type: "array", items: { type: "string" } },
        warnings: { type: "array", items: { type: "string" } },
        errors: { type: "array", items: { type: "string" } },
      }),
    },
    reindex: {
      input: valueSchema({}),
      output: valueSchema({ queued: { type: "boolean" } }),
    },
    remember: {
      input: valueSchema({ text: { type: "string" } }),
      output: valueSchema({
        id: { type: "string" },
        created: { type: "boolean" },
      }),
    },
    search: {
      input: valueSchema({ query: { type: "string" } }),
      output: valueSchema({
        text: { type: "string" },
        hits: { type: "number" },
        bytes: { type: "number" },
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

// Read from the manifest so the reported version cannot drift from the
// published one: a hand-maintained constant goes stale on every bump.
export const PLUGIN_VERSION: string = packageJson.version;
