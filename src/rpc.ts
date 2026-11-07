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
  /**
   * False when the namespace's index is absent. An empty store and a lost one
   * both report `count: 0`, and only this tells them apart.
   */
  readonly exists: boolean;
  /** Memories whose every named path is gone; set by the verification pass. */
  readonly stale: number;
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
  /** Files the last pass covered; `docs` also counts symbol records. */
  readonly lastFiles: number | null;
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
  /** Tokens the plugin itself added to context. */
  readonly tokensCost: number;
  /** tokensSaved - tokensCost; negative means the plugin costs more than it saves. */
  readonly netTokens: number;
  readonly topFiles: ReadonlyArray<CitedFileStatus>;
}

export interface CounterStatus {
  readonly rpcCalls: number;
  readonly injectedTurns: number;
  readonly nodeSpawns: number;
  readonly http429: number;
  readonly indexRuns: number;
  readonly noiseSkips: number;
}

export interface ConfigStatus {
  readonly indexRoot: string;
  readonly storageRoot: string;
  readonly brain: ReadonlyArray<string>;
  readonly watch: boolean;
  readonly contextEnabled: boolean;
  /** Terms `prjdocs` documents even though the project does not use them. */
  readonly prjdocsKeywords: ReadonlyArray<string>;
}

/** One record kind and how many records carry it, for the data map. */
export interface MapRow {
  readonly kind: string;
  readonly docs: number;
}

/**
 * One indexed corpus and whether it is actually working. A corpus that exists
 * but writes nothing (a refused memory index, a hidden folder that fails to
 * upload) used to be invisible unless its warning happened to be in the ring.
 */
export interface CorpusHealth {
  readonly name: string;
  readonly state: string;
  readonly docs: number | null;
  readonly lastRunAt: number | null;
  readonly records: number | null;
  /** Live graph edges, for a corpus indexed as a brain. */
  readonly edges: number | null;
  readonly error: string | null;
}

/** One technology's share of the documentation corpus. */
export interface FrameworkStatus {
  readonly tech: string;
  readonly docs: number;
  readonly bytes: number;
}

/** What the node process costs, sampled at status time. */
export interface ProcessStatus {
  readonly cpuPercent: number;
  readonly memoryBytes: number;
}

export interface DiskStatus {
  readonly engineBytes: number;
  readonly logBytes: number;
}

/** One running job that keeps the service busy. */
export interface JobStatus {
  readonly kind: string;
  readonly label: string;
  readonly startedAt: number;
}

/**
 * What the service is doing right now. Five states, one source: a node that
 * answers while the indexer runs is ready to serve and busy doing work.
 */
export interface ServiceStateStatus {
  readonly name: "starting" | "ready" | "busy" | "degraded" | "stopped";
  /** Epoch milliseconds when this state began. */
  readonly since: number;
  readonly detail: string | null;
  readonly jobs: ReadonlyArray<JobStatus>;
  /** Time spent in each state today. */
  readonly today: Readonly<{
    startingMs: number;
    readyMs: number;
    busyMs: number;
    degradedMs: number;
    stoppedMs: number;
  }>;
}

/** One operation type's figures over the report window. */
export interface TelemetryOpStatus {
  readonly op: string;
  readonly count: number;
  readonly errors: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly totalMs: number;
}

export interface TelemetryStartStatus {
  readonly at: number;
  readonly bootMs: number;
  readonly readyMs: number | null;
  readonly indexedMs: number | null;
  readonly crashed: boolean;
}

export interface TelemetryProcessStatus {
  readonly cpuPct: number | null;
  readonly rssBytes: number | null;
  readonly peakRssBytes: number;
  readonly rssP50: number;
  readonly rssP95: number;
  readonly cpuBusy: number | null;
  readonly cpuReady: number | null;
  readonly growthMbPerDay: number;
}

/** Local telemetry, read from the plugin's own files. Never sent anywhere. */
export interface TelemetryStatus {
  readonly enabled: boolean;
  readonly ops: ReadonlyArray<TelemetryOpStatus>;
  readonly starts: ReadonlyArray<TelemetryStartStatus>;
  readonly crashes: number;
  readonly restarts: number;
  readonly process: TelemetryProcessStatus | null;
  readonly storeBytes: number;
  readonly historyStart: string | null;
  /** Why the store stopped recording, if it did. */
  readonly disabled: string | null;
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
  readonly corpora: ReadonlyArray<CorpusHealth>;
  /** Bytes on disk for the engine data and the node log. */
  readonly disk: DiskStatus;
  /** Record kinds in the project corpus, largest first. */
  readonly map: ReadonlyArray<MapRow>;
  /** Documentation per technology, largest first. */
  readonly frameworks: ReadonlyArray<FrameworkStatus>;
  /** Node process cost; null when the platform exposes no counters. */
  readonly process: ProcessStatus | null;
  /** True while an index pass is building embeddings. */
  readonly embeddings: boolean;
  /** What the service is doing now, for the badge and the State section. */
  readonly state: ServiceStateStatus;
  /** Local operation, boot, and process figures. */
  readonly telemetry: TelemetryStatus;
  readonly counters: CounterStatus;
  readonly recent: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
}

type ValueSchema = Rpc.PortableValueSchema;
type EventSchema = Rpc.PortableEventDefinition["schema"];

/**
 * An object schema. Every property is required unless it is named as optional:
 * the host validates the call against this, and a required key that a caller
 * has no way to know about fails the call before the handler runs.
 */
function object(
  properties: Record<string, unknown>,
  optional: ReadonlyArray<string> = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required: Object.keys(properties).filter((key) => !optional.includes(key)),
    additionalProperties: false,
  };
}

function valueSchema(
  properties: Record<string, unknown>,
  optional: ReadonlyArray<string> = [],
): ValueSchema {
  return object(properties, optional) as unknown as ValueSchema;
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
          lastFiles: { type: ["number", "null"] },
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
          prjdocsKeywords: { type: "array", items: { type: "string" } },
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
          tokensCost: { type: "number" },
          netTokens: { type: "number" },
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
        disk: object({
          engineBytes: { type: "number" },
          logBytes: { type: "number" },
        }),
        map: {
          type: "array",
          items: object({ kind: { type: "string" }, docs: { type: "number" } }),
        },
        corpora: {
          type: "array",
          items: object({
            name: { type: "string" },
            state: { type: "string" },
            docs: { type: ["number", "null"] },
            lastRunAt: { type: ["number", "null"] },
            records: { type: ["number", "null"] },
            edges: { type: ["number", "null"] },
            error: { type: ["string", "null"] },
          }),
        },
        state: object({
          name: {
            type: "string",
            enum: ["starting", "ready", "busy", "degraded", "stopped"],
          },
          since: { type: "number" },
          detail: { type: ["string", "null"] },
          jobs: {
            type: "array",
            items: object({
              kind: { type: "string" },
              label: { type: "string" },
              startedAt: { type: "number" },
            }),
          },
          today: object({
            startingMs: { type: "number" },
            readyMs: { type: "number" },
            busyMs: { type: "number" },
            degradedMs: { type: "number" },
            stoppedMs: { type: "number" },
          }),
        }),
        telemetry: object({
          enabled: { type: "boolean" },
          ops: {
            type: "array",
            items: object({
              op: { type: "string" },
              count: { type: "number" },
              errors: { type: "number" },
              p50: { type: "number" },
              p95: { type: "number" },
              max: { type: "number" },
              totalMs: { type: "number" },
            }),
          },
          starts: {
            type: "array",
            items: object({
              at: { type: "number" },
              bootMs: { type: "number" },
              readyMs: { type: ["number", "null"] },
              indexedMs: { type: ["number", "null"] },
              crashed: { type: "boolean" },
            }),
          },
          crashes: { type: "number" },
          restarts: { type: "number" },
          process: {
            type: ["object", "null"],
            properties: {
              cpuPct: { type: ["number", "null"] },
              rssBytes: { type: ["number", "null"] },
              peakRssBytes: { type: "number" },
              rssP50: { type: "number" },
              rssP95: { type: "number" },
              cpuBusy: { type: ["number", "null"] },
              cpuReady: { type: ["number", "null"] },
              growthMbPerDay: { type: "number" },
            },
            required: [
              "cpuPct",
              "rssBytes",
              "peakRssBytes",
              "rssP50",
              "rssP95",
              "cpuBusy",
              "cpuReady",
              "growthMbPerDay",
            ],
            additionalProperties: false,
          },
          storeBytes: { type: "number" },
          historyStart: { type: ["string", "null"] },
          disabled: { type: ["string", "null"] },
        }),
        counters: object({
          rpcCalls: { type: "number" },
          injectedTurns: { type: "number" },
          nodeSpawns: { type: "number" },
          http429: { type: "number" },
          indexRuns: { type: "number" },
          noiseSkips: { type: "number" },
        }),
        recent: { type: "array", items: { type: "string" } },
        warnings: { type: "array", items: { type: "string" } },
        errors: { type: "array", items: { type: "string" } },
      }),
    },
    reindex: {
      input: valueSchema({}),
      output: valueSchema({
        queued: { type: "boolean" },
        records: { type: ["number", "null"] },
      }),
    },
    wrapup: {
      input: valueSchema({ sessionID: { type: "string" } }, ["sessionID"]),
      output: valueSchema({
        compacted: { type: "boolean" },
        sessionID: { type: ["string", "null"] },
        detail: { type: "string" },
      }),
    },
    prjdocs: {
      input: valueSchema(
        {
          eager: { type: "boolean" },
          keywords: { type: "array", items: { type: "string" } },
        },
        ["eager", "keywords"],
      ),
      output: valueSchema({
        techs: { type: "array", items: { type: "string" } },
        targets: { type: "number" },
        pages: { type: "number" },
        indexed: { type: "number" },
        skipped: { type: "number" },
        pruned: { type: "number" },
        failed: { type: "number" },
        bytes: { type: "number" },
        unsupported: { type: "array", items: { type: "string" } },
      }),
    },
    sysdocs: {
      input: valueSchema({}),
      output: valueSchema({
        discovered: { type: "number" },
        indexed: { type: "number" },
        skipped: { type: "number" },
        pruned: { type: "number" },
        failed: { type: "number" },
        bytes: { type: "number" },
        source: { type: "string" },
      }),
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
    // The TUI half never writes files. It reports what it did and what broke
    // here, and the server half appends it to `rings/ui.sidebar`.
    uiLog: {
      input: valueSchema(
        {
          level: { type: "string", enum: ["debug", "info", "warn", "error"] },
          message: { type: "string" },
          detail: { type: "string" },
        },
        ["level", "detail"],
      ),
      output: valueSchema({}),
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
