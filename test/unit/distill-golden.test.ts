// A labeled set for the heuristic judge. The classifier is the cheap route, so
// it needs a floor under it: every sentence here is a decision the maintainers
// have already made about what belongs in memory.
//
// The floors are deliberately not 100%: a cue change that trades one edge case
// for another should not fail the suite, but a change that starts storing
// questions or dropping decisions should.

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { extractCandidates } from "../../src/memory/distill.ts";
import type { MemoryKind } from "../../src/memory/store.ts";

const THRESHOLD = DEFAULT_CONFIG.memory.distill.minConfidence / 100;

interface Label {
  readonly text: string;
  readonly kind: MemoryKind;
  readonly origin: "prompt" | "answer";
}

const ACCEPT: ReadonlyArray<Label> = [
  { text: "We decided to use SQLite instead of Postgres for the local store.", kind: "decision", origin: "answer" },
  { text: "We agreed to keep the plugin read-only and let the host write files.", kind: "decision", origin: "answer" },
  { text: "The collector must never open a port unless share.enabled is true.", kind: "constraint", origin: "answer" },
  { text: "Do not add new runtime dependencies to this package.", kind: "constraint", origin: "prompt" },
  { text: "By convention, every tool lives under src/tools and is named after its action.", kind: "convention", origin: "answer" },
  { text: "I prefer terse replies with no interim status updates.", kind: "preference", origin: "prompt" },
  { text: "The node listens on 127.0.0.1:9200 unless node.port is set.", kind: "fact", origin: "answer" },
  { text: "The sweep runs hourly; the timer is in src/index/watcher.ts:44.", kind: "fact", origin: "answer" },
];

const REJECT: ReadonlyArray<string> = [
  "Should we use SQLite for the local store?",
  "Maybe we decided to use SQLite for the local store.",
  "Let me check whether the indexer must run on musl.",
  "I think the watcher probably claims ownership before the first pass.",
  "Here's what the build printed: a long list of compiler warnings.",
  "```\nWe decided to use SQLite instead of Postgres.\n```",
  "TBD: the storage engine is still an open question for the group.",
];

function promotes(text: string, origin: "prompt" | "answer"): boolean {
  const candidates = extractCandidates(
    origin === "prompt" ? text : "",
    origin === "answer" ? text : "",
  );
  return candidates.some((candidate) => candidate.score >= THRESHOLD);
}

describe("heuristic judge golden set", () => {
  test("promotes the labeled decisions, constraints, conventions, preferences, and facts", () => {
    const promoted = ACCEPT.filter((label) => promotes(label.text, label.origin));
    expect(promoted.length / ACCEPT.length).toBeGreaterThanOrEqual(0.8);
  });

  test("never promotes a question, hedge, plan, or code block", () => {
    const promoted = REJECT.filter((text) => promotes(text, "answer"));
    expect(promoted).toEqual([]);
  });

  test("keeps the labeled class", () => {
    const correct = ACCEPT.filter((label) => {
      const candidates = extractCandidates(
        label.origin === "prompt" ? label.text : "",
        label.origin === "answer" ? label.text : "",
      );
      return candidates.some(
        (candidate) => candidate.score >= THRESHOLD && candidate.kind === label.kind,
      );
    });
    expect(correct.length / ACCEPT.length).toBeGreaterThanOrEqual(0.8);
  });
});
