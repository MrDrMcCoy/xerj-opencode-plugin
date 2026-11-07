// The standalone MCP server reads the same opencode.json the host would.
// These tests pin the discovery order, the plugin entry match, and the
// explicit override.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPluginOptions } from "../../src/config-file.ts";

const scratch: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "xerj-config-file-"));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of scratch.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("discoverPluginOptions", () => {
  test("reads this plugin's options from a project opencode.json", async () => {
    const project = await tempDir();
    await writeFile(
      join(project, "opencode.json"),
      JSON.stringify({
        plugins: [
          { package: "another-plugin", options: { other: true } },
          {
            package: "@mrdrmccoy/xerj-opencode-plugin",
            options: { index: { hidden: [".agents"] } },
          },
        ],
      }),
    );

    const found = discoverPluginOptions(project, {
      OPENCODE_CONFIG_DIR: join(project, "absent"),
    });
    expect(found.source).toBe(join(project, "opencode.json"));
    expect(found.options).toMatchObject({ index: { hidden: [".agents"] } });
  });

  test("falls back to the global config", async () => {
    const project = await tempDir();
    const config = await tempDir();
    await writeFile(
      join(config, "opencode.jsonc"),
      `{
        // the host's own entry
        "plugins": [
          { "package": "/data/ai/xerj-opencode-plugin", "options": { "context": { "maxPassages": 3 } } }
        ]
      }`,
    );

    const found = discoverPluginOptions(project, {
      OPENCODE_CONFIG_DIR: config,
    });
    expect(found.source).toBe(join(config, "opencode.jsonc"));
    expect(found.options).toMatchObject({ context: { maxPassages: 3 } });
  });

  test("XERJ_MCP_CONFIG accepts the options object directly", async () => {
    const project = await tempDir();
    const file = join(project, "xerj-options.json");
    await writeFile(file, JSON.stringify({ cmd: { blockPipes: true } }));

    const found = discoverPluginOptions(project, { XERJ_MCP_CONFIG: file });
    expect(found.options).toEqual({ cmd: { blockPipes: true } });
  });

  test("a string plugin entry carries no options", async () => {
    const project = await tempDir();
    await writeFile(
      join(project, "opencode.json"),
      JSON.stringify({ plugins: ["/data/ai/xerj-opencode-plugin"] }),
    );

    const found = discoverPluginOptions(project, {
      OPENCODE_CONFIG_DIR: join(project, "absent"),
    });
    expect(found.source).toBeNull();
    expect(found.options).toEqual({});
  });

  test("several unrelated entries are ambiguous and use defaults", async () => {
    const project = await tempDir();
    await writeFile(
      join(project, "opencode.json"),
      JSON.stringify({
        plugins: [
          { package: "one", options: { a: 1 } },
          { package: "two", options: { b: 2 } },
        ],
      }),
    );

    expect(
      discoverPluginOptions(project, {
        OPENCODE_CONFIG_DIR: join(project, "absent"),
      }).source,
    ).toBeNull();
  });

  test("a missing XERJ_MCP_CONFIG names the fallback", async () => {
    const project = await tempDir();
    const found = discoverPluginOptions(project, {
      XERJ_MCP_CONFIG: join(project, "absent.json"),
    });
    expect(found.source).toBeNull();
    expect(found.warnings.join(" ")).toContain("XERJ_MCP_CONFIG");
  });
});
