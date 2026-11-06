// Where documentation lives on a real machine. `man` and `info` search their
// own defaults, but a developer's pages are mostly outside those: XDG data, a
// Nix profile, Homebrew, or a NixOS system profile. These roots are searched in
// precedence order, so a page installed by the user shadows the system copy.

import { homedir } from "node:os";
import { join } from "node:path";

export interface SupplementaryRoots {
  readonly man: string[];
  readonly info: string[];
}

export interface RootOptions {
  /** Overrides `homedir()`; null means no home-derived roots. */
  readonly home?: string | null;
  readonly env?: Record<string, string | undefined>;
}

/** Package-manager prefixes that are not always on PATH. */
const HOMEBREW_FALLBACKS = ["/home/linuxbrew/.linuxbrew", "/opt/homebrew", "/usr/local"];
/** A NixOS system profile is not in `NIX_PROFILES` on every install. */
const NIX_SYSTEM_PROFILE = "/run/current-system/sw";
/** Last: what `man` itself would search. */
const SYSTEM_ROOTS = ["/usr/local/share", "/usr/share"];

/**
 * Man and info roots beyond `MANPATH`, in the order a user's own install
 * expects to win: XDG data, Nix profiles, Homebrew, then the system.
 */
export function supplementaryRoots(options: RootOptions = {}): SupplementaryRoots {
  const env = options.env ?? process.env;
  const home = options.home === undefined ? homedir() : options.home;
  const prefixes: string[] = [];
  const man: string[] = [];
  const info: string[] = [];

  if (home !== null && home.length > 0) {
    prefixes.push(env.XDG_DATA_HOME ?? join(home, ".local", "share"));
    prefixes.push(join(home, ".nix-profile", "share"));
  }

  for (const profile of splitList(env.NIX_PROFILES)) {
    prefixes.push(join(profile, "share"));
  }

  prefixes.push(join(NIX_SYSTEM_PROFILE, "share"));

  const brew = env.HOMEBREW_PREFIX;
  if (brew !== undefined && brew.length > 0) prefixes.push(join(brew, "share"));
  for (const candidate of HOMEBREW_FALLBACKS) prefixes.push(join(candidate, "share"));

  for (const root of [...prefixes, ...SYSTEM_ROOTS]) {
    man.push(join(root, "man"));
    info.push(join(root, "info"));
  }

  return { man: dedupe(man), info: dedupe(info) };
}

function splitList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value.split(/[\s:]+/).filter((part) => part.length > 0);
}

function dedupe(paths: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    kept.push(path);
  }
  return kept;
}
