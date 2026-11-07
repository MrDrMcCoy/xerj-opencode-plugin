// Labeled sentences for the distillation judges.
//
// The heuristic half runs in `test/unit/distill-golden.test.ts`, so a cue
// change cannot quietly start storing noise. The model half needs a live
// endpoint; `scripts/eval-distill.ts` runs both over this set.

import type { MemoryKind } from "../src/memory/store.ts";

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

export const REJECT: ReadonlyArray<string> = [
  "Should we use SQLite for the local store?",
  "Maybe we decided to use SQLite for the local store.",
  "Let me check whether the indexer must run on musl.",
  "I think the watcher probably claims ownership before the first pass.",
  "Here's what the build printed: a long list of compiler warnings.",
  "```\nWe decided to use SQLite instead of Postgres.\n```",
  "TBD: the storage engine is still an open question for the group.",
];
