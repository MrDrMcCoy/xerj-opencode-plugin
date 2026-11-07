// The plugin's options in an `opencode.json(c)` file. A standalone MCP server
// has no OpenCode host to pass options down, so it reads the same file the
// host would: the project's config first, then the global one, unless
// `XERJ_MCP_CONFIG` names a file explicitly.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json";
import { parseJsonc } from "./jsonc.ts";

export interface DiscoveredPluginOptions {
  readonly options: Record<string, unknown>;
  readonly source: string | null;
  readonly warnings: ReadonlyArray<string>;
}

const PACKAGE_NAME = packageJson.name;

/** Reads the first config file that carries this plugin's options. */
export function discoverPluginOptions(
  projectRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): DiscoveredPluginOptions {
  const warnings: string[] = [];
  const explicit = env.XERJ_MCP_CONFIG?.trim();
  const explicitPath = explicit !== undefined && explicit.length > 0 ? explicit : null;
  const configDir = openCodeConfigDir(env);
  const paths =
    explicitPath === null
      ? [
          join(projectRoot, "opencode.json"),
          join(projectRoot, "opencode.jsonc"),
          join(configDir, "opencode.jsonc"),
          join(configDir, "opencode.json"),
        ]
      : [explicitPath];

  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const parsed = parseJsonc(text);
    const options =
      explicitPath === null
        ? pluginEntryOptions(parsed)
        : explicitOptions(parsed);
    if (options === null) continue;
    return { options, source: path, warnings };
  }

  if (explicitPath !== null) {
    warnings.push(
      `XERJ_MCP_CONFIG ${explicitPath} did not contain plugin options; using defaults`,
    );
  }
  return { options: {}, source: null, warnings };
}

function openCodeConfigDir(
  env: Readonly<Record<string, string | undefined>>,
): string {
  return (
    env.OPENCODE_CONFIG_DIR ??
    join(
      env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), ".config"),
      "opencode",
    )
  );
}

/**
 * An explicit file may be the options object itself or an opencode config
 * with a plugin entry.
 */
function explicitOptions(
  parsed: Record<string, unknown>,
): Record<string, unknown> | null {
  if (isRecord(parsed.options)) return parsed.options;
  const viaEntry = pluginEntryOptions(parsed);
  if (viaEntry !== null) return viaEntry;
  return Object.keys(parsed).length > 0 ? parsed : null;
}

function pluginEntryOptions(
  parsed: Record<string, unknown>,
): Record<string, unknown> | null {
  const entries = [parsed.plugins, parsed.plugin].flatMap((value) =>
    Array.isArray(value) ? value : [],
  );
  let fallback: Record<string, unknown> | null = null;
  let withOptions = 0;

  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.options)) continue;
    withOptions += 1;
    const pkg = typeof entry.package === "string" ? entry.package : "";
    if (
      pkg === PACKAGE_NAME ||
      pkg.includes("xerj-opencode-plugin") ||
      pkg === "./"
    ) {
      return entry.options;
    }
    if (fallback === null) fallback = entry.options;
  }

  // A config with one object entry is unambiguous; several are not.
  return withOptions === 1 ? fallback : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
