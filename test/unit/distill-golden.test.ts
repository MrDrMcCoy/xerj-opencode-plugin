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
import { ACCEPT, REJECT } from "../../scripts/distill-labels.ts";

const THRESHOLD = DEFAULT_CONFIG.memory.distill.minConfidence / 100;

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
