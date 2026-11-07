// Labelled sentences for the distillation judges.
//
// The heuristic half runs in `test/unit/distill-golden.test.ts`, so a cue
// change cannot quietly start storing noise. The model half needs a live
// endpoint; `scripts/eval-distill.ts` runs it. The autotuner uses the same set
// as a stability check: a model or wording change must not move the floor
// without evidence.

import type { MemoryKind } from "./store.ts";

export interface Label {
  readonly text: string;
  readonly kind: MemoryKind;
  readonly origin: "prompt" | "answer";
}

export const ACCEPT: ReadonlyArray<Label> = [
  {
    text: "We decided to use SQLite instead of Postgres for the local store.",
    kind: "decision",
    origin: "answer",
  },
  {
    text: "We agreed to keep the plugin read-only and let the host write files.",
    kind: "decision",
    origin: "answer",
  },
  {
    text: "The collector must never open a port unless share.enabled is true.",
    kind: "constraint",
    origin: "answer",
  },
  {
    text: "Do not add new runtime dependencies to this package.",
    kind: "constraint",
    origin: "prompt",
  },
  {
    text: "By convention, every tool lives under src/tools and is named after its action.",
    kind: "convention",
    origin: "answer",
  },
  {
    text: "I prefer terse replies with no interim status updates.",
    kind: "preference",
    origin: "prompt",
  },
  {
    text: "The node listens on 127.0.0.1:9200 unless node.port is set.",
    kind: "fact",
    origin: "answer",
  },
  {
    text: "The sweep runs hourly; the timer is in src/index/watcher.ts:44.",
    kind: "fact",
    origin: "answer",
  },
];

// Progress reports that a heuristic cue can propose but that do not belong in
// durable memory. They are the reason the local judge asks "lasting rule or
// fact, rather than a report of what was just done".
export const REPORTS: ReadonlyArray<string> = [
  "Completed the turn archive and shipped it with xerj_expand plus the find tool.",
  "State: 19 tools, 934 unit and 12 integration pass, typecheck clean.",
  "Wrote test/unit/mcp.test.ts with 15 new tests across protocol and storage.",
  "I fixed the run-record handling in src/index/watcher.ts and rewrote its test.",
  "Built the standalone MCP server in src/mcp/ and shipped it as the xerj-mcp bin.",
  "Version 0.7.0, nothing tagged or pushed.",
  "Updated the README options block, the plan, the roadmap, and the status file.",
  "It read six of nine done, 7.5 h estimated.",
  "Removed it all as 96a84f6: the Tier XL row and the edit family.",
  "Checking telemetry state transitions and boot markers suggests I was verifying boot order.",
];

export const REJECT: ReadonlyArray<string> = [
  "Should we use SQLite for the local store?",
  "Maybe we decided to use SQLite for the local store.",
  "Let me check whether the indexer must run on musl.",
  "I think the watcher probably claims ownership before the first pass.",
  "Here's what the build printed: a long list of compiler warnings.",
  "```\nWe decided to use SQLite instead of Postgres.\n```",
  "TBD: the storage engine is still an open question for the group.",
];
