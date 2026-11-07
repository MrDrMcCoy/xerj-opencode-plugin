import { describe, expect, test } from "bun:test";
import {
  bestRow,
  confusion,
  sweep,
} from "../../scripts/replay-judge.ts";

describe("judge replay", () => {
  test("counts a confusion matrix and derives precision and recall", () => {
    const result = confusion(
      [0.9, 0.1, 0.8, 0.2],
      [true, false, false, true],
      0.5,
    );

    expect(result).toMatchObject({ tp: 1, fp: 1, fn: 1, tn: 1 });
    expect(result.precision).toBeCloseTo(0.5);
    expect(result.recall).toBeCloseTo(0.5);
    expect(result.f1).toBeCloseTo(0.5);
  });

  test("an inverted wording keeps a low score", () => {
    const result = confusion([0.1, 0.9], [true, false], 0.2, true);
    expect(result).toMatchObject({ tp: 1, fp: 0, fn: 0, tn: 1 });
  });

  test("skips a sample the server did not answer", () => {
    const result = confusion([null, 0.9], [false, true], 0.5);
    expect(result).toMatchObject({ tp: 1, fp: 0, fn: 0, tn: 0 });
  });

  test("the sweep keeps the best threshold by F1", () => {
    const rows = sweep(
      [0.9, 0.8, 0.2, 0.1],
      [true, true, false, false],
      [0.05, 0.5, 0.95],
    );
    const best = bestRow(rows);
    expect(best?.threshold).toBe(0.5);
    expect(best?.confusion.f1).toBeCloseTo(1);
  });
});
