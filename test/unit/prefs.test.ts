import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PREFS,
  parseJsonc,
  prefsFilePath,
  readPrefs,
  resolvePrefs,
  seedCollapsed,
  writePrefs,
} from "../../src/ui/prefs.ts";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "xerj-prefs-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("parseJsonc", () => {
  test("reads comments and trailing commas", () => {
    const parsed = parseJsonc(`{
      // a line comment
      "xerj": { "startCollapsed": true, },
      /* block */
      "aft": { "order": 180 }
    }`);

    expect(parsed.xerj).toEqual({ startCollapsed: true });
    expect(parsed.aft).toEqual({ order: 180 });
  });

  test("a URL inside a string is not treated as a comment", () => {
    const parsed = parseJsonc('{"xerj":{"header":{"label":"http://xerj"}}}');

    expect((parsed.xerj as { header: { label: string } }).header.label).toBe("http://xerj");
  });

  test("broken JSON is an empty object, not a throw", () => {
    expect(parseJsonc("{ nope")).toEqual({});
  });
});

describe("resolvePrefs", () => {
  test("defaults when nothing is set", () => {
    expect(resolvePrefs({})).toEqual(DEFAULT_PREFS);
  });

  test("reads every documented key", () => {
    const prefs = resolvePrefs({
      xerj: {
        startCollapsed: true,
        rememberCollapsed: false,
        collapsed: true,
        header: { label: "IDX", showVersion: false },
        sections: { corpora: false, health: false },
      },
    });

    expect(prefs).toMatchObject({
      startCollapsed: true,
      rememberCollapsed: false,
      collapsed: true,
      headerLabel: "IDX",
      showVersion: false,
    });
    expect(prefs.sections.corpora).toBe(false);
    expect(prefs.sections.health).toBe(false);
    expect(prefs.sections.session).toBe(true);
  });

  test("a null collapse falls back to startCollapsed", () => {
    const prefs = resolvePrefs({ xerj: { collapsed: null } });

    expect(seedCollapsed(prefs)).toBe(false);
    expect(seedCollapsed(resolvePrefs({ xerj: { collapsed: null, startCollapsed: true } }))).toBe(
      true,
    );
  });

  test("another plugin's key is ignored", () => {
    const prefs = resolvePrefs({ aft: { startCollapsed: true } });

    expect(prefs).toEqual(DEFAULT_PREFS);
  });
});

describe("readPrefs and writePrefs", () => {
  test("a missing file yields defaults", async () => {
    expect(await readPrefs(join(root, "absent.jsonc"))).toEqual(DEFAULT_PREFS);
  });

  test("a write preserves the other plugin's block", async () => {
    const path = join(root, "shared.jsonc");
    await writeFile(
      path,
      `{
        // keep AFT's settings
        "aft": { "collapsed": true }
      }`,
      "utf8",
    );

    await writePrefs({ collapsed: false }, logger as never, path);

    const text = await readFile(path, "utf8");
    const parsed = parseJsonc(text) as {
      aft: { collapsed: boolean };
      xerj: { collapsed: boolean };
    };
    expect(parsed.aft).toEqual({ collapsed: true });
    expect(parsed.xerj.collapsed).toBe(false);
  });

  test("the environment overrides the file path", () => {
    const previous = process.env.OPENCODE_TUI_PREFERENCES_FILE;
    process.env.OPENCODE_TUI_PREFERENCES_FILE = "/tmp/custom-prefs.jsonc";
    try {
      expect(prefsFilePath()).toBe("/tmp/custom-prefs.jsonc");
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_TUI_PREFERENCES_FILE;
      else process.env.OPENCODE_TUI_PREFERENCES_FILE = previous;
    }
  });
});
