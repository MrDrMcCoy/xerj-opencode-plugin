// The README claims its options block is the complete set with defaults. A
// stale example is worse than none: a reader cannot tell whether a missing key
// means "not supported" or "the example drifted". This test pins every key and
// value to DEFAULT_CONFIG.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { formatCpuSpec } from "../../src/node/priority.ts";
import { parseJsonc } from "../../src/ui/prefs.ts";

const README = join(import.meta.dir, "..", "..", "README.md");
const FENCE = /```jsonc\n([\s\S]*?)```/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flatten(value: Record<string, unknown>, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;
    if (isRecord(entry)) {
      for (const [nested, nestedValue] of flatten(entry, path)) {
        out.set(nested, nestedValue);
      }
      continue;
    }
    out.set(path, entry);
  }
  return out;
}

/** The one README block that lists every section, including sysdocs. */
function completeExample(): Record<string, unknown> {
  const readme = readFileSync(README, "utf8");
  for (const match of readme.matchAll(FENCE)) {
    const parsed = parseJsonc(match[1] ?? "");
    const plugins = parsed.plugins;
    if (!Array.isArray(plugins)) continue;
    const first = plugins[0];
    if (!isRecord(first)) continue;
    const options = first.options;
    if (isRecord(options) && isRecord(options.sysdocs)) return options;
  }
  throw new Error("the README has no complete options example");
}

/** DEFAULT_CONFIG with the parsed CPU spec rendered as its config string. */
function defaultOptions(): Record<string, unknown> {
  return {
    ...DEFAULT_CONFIG,
    node: {
      ...DEFAULT_CONFIG.node,
      cpus: formatCpuSpec(DEFAULT_CONFIG.node.cpus),
    },
  } as unknown as Record<string, unknown>;
}

describe("README config example", () => {
  test("lists every default", () => {
    const example = flatten(completeExample());
    const defaults = flatten(defaultOptions());

    expect([...example.keys()].sort()).toEqual([...defaults.keys()].sort());
  });

  test("shows each default value", () => {
    const example = flatten(completeExample());
    const defaults = flatten(defaultOptions());

    for (const [key, value] of defaults) {
      expect(example.get(key), key).toEqual(value);
    }
  });
});
