// The labelled set lives in `src/` so the autotuner can use it at runtime.
// This module stays as the scripts' import point.

export { ACCEPT, REJECT, REPORTS, type Label } from "../src/memory/labels.ts";
