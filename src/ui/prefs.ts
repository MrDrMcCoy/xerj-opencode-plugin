// Sidebar preferences, shared with the other TUI plugins.
//
// AFT and Magic Context keep their settings in one file, keyed by plugin, so a
// user has one place to edit. This plugin owns the `xerj` key and must not
// rewrite anything else in that file: a bad write would disturb their
// settings, which is why the merge is done in memory and written whole.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "../log.ts";

export const PREFS_FILE_ENV = "OPENCODE_TUI_PREFERENCES_FILE";
export const PREFS_KEY = "xerj";
const FILE_NAME = "tui-preferences.jsonc";

export interface SidebarSectionFlags {
  readonly corpora: boolean;
  readonly session: boolean;
  readonly dreamer: boolean;
  readonly savings: boolean;
  readonly runtime: boolean;
  readonly health: boolean;
}

export interface SidebarPrefs {
  readonly startCollapsed: boolean;
  readonly rememberCollapsed: boolean;
  /** Persisted last state; null means "use startCollapsed". */
  readonly collapsed: boolean | null;
  readonly headerLabel: string;
  readonly showVersion: boolean;
  readonly sections: SidebarSectionFlags;
}

export const DEFAULT_PREFS: SidebarPrefs = {
  startCollapsed: false,
  rememberCollapsed: true,
  collapsed: null,
  headerLabel: "XERJ",
  showVersion: true,
  sections: {
    corpora: true,
    session: true,
    dreamer: true,
    savings: true,
    runtime: true,
    health: true,
  },
};

/** The file both sibling plugins use, honouring their overrides. */
export function prefsFilePath(): string {
  const override = process.env[PREFS_FILE_ENV];
  if (override !== undefined && override.length > 0) return override;

  const configDir =
    process.env.OPENCODE_CONFIG_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode");
  return join(configDir, FILE_NAME);
}

/**
 * JSON with comments and trailing commas, which is what this file uses. A
 * failure returns an empty object: a broken shared file must not take the
 * sidebar down with it.
 */
export function parseJsonc(text: string): Record<string, unknown> {
  const withoutComments = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const withoutTrailing = withoutComments.replace(/,(\s*[}\]])/g, "$1");

  try {
    const parsed: unknown = JSON.parse(withoutTrailing);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** This plugin's settings out of the shared root. */
export function resolvePrefs(root: Record<string, unknown>): SidebarPrefs {
  const own = record(root[PREFS_KEY]);
  const header = record(own.header);
  const sections = record(own.sections);
  const collapsed = own.collapsed;

  return {
    startCollapsed: bool(own.startCollapsed, DEFAULT_PREFS.startCollapsed),
    rememberCollapsed: bool(own.rememberCollapsed, DEFAULT_PREFS.rememberCollapsed),
    collapsed: typeof collapsed === "boolean" ? collapsed : null,
    headerLabel:
      typeof header.label === "string" && header.label.length > 0
        ? header.label.slice(0, 24)
        : DEFAULT_PREFS.headerLabel,
    showVersion: bool(header.showVersion, DEFAULT_PREFS.showVersion),
    sections: {
      corpora: bool(sections.corpora, true),
      session: bool(sections.session, true),
      dreamer: bool(sections.dreamer, true),
      savings: bool(sections.savings, true),
      runtime: bool(sections.runtime, true),
      health: bool(sections.health, true),
    },
  };
}

/** Reads the shared file and returns this plugin's settings. */
export async function readPrefs(path = prefsFilePath()): Promise<SidebarPrefs> {
  const text = await readFile(path, "utf8").catch(() => null);
  return resolvePrefs(text === null ? {} : parseJsonc(text));
}

/** Initial state: the remembered click wins over the configured default. */
export function seedCollapsed(prefs: SidebarPrefs): boolean {
  return prefs.collapsed ?? prefs.startCollapsed;
}

/**
 * Writes one key into this plugin's block, leaving every other plugin's block
 * untouched. A read failure is treated as an empty file, because refusing to
 * save a click is worse than losing another plugin's missing settings.
 */
export async function writePrefs(
  patch: Record<string, unknown>,
  logger: Logger,
  path = prefsFilePath(),
): Promise<void> {
  const text = await readFile(path, "utf8").catch(() => null);
  const root = text === null ? {} : parseJsonc(text);
  const own = { ...record(root[PREFS_KEY]), ...patch };

  await mkdir(dirname(path), { recursive: true }).catch(() => {});
  const temporary = `${path}.xerj-tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...root, [PREFS_KEY]: own }, null, 2)}\n`, "utf8")
    .then(() => rename(temporary, path))
    .catch((error: unknown) => {
      logger.debug("could not save the sidebar preferences", String(error));
    });
}
