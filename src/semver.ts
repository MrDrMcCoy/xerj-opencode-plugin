// Semver parsing and comparison. XERJ ships pre-1.0 releases such as
// `1.0.0-rc.100`, so prerelease identifiers must compare numerically:
// `rc.99 < rc.100`. A string compare would rank `rc.100` below `rc.99`.

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-separated prerelease identifiers, numeric ones kept as numbers. */
  readonly prerelease: ReadonlyArray<string | number>;
  readonly raw: string;
}

const VERSION_PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parses a semver string, with an optional leading `v`. Returns null when invalid. */
export function parseVersion(input: string): Version | null {
  const match = VERSION_PATTERN.exec(input.trim());
  if (!match) return null;

  const [, major, minor, patch, prerelease] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    return null;
  }

  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: parsePrerelease(prerelease),
    raw: input.trim(),
  };
}

function parsePrerelease(value: string | undefined): Array<string | number> {
  if (!value) return [];
  return value.split(".").map((part) => {
    if (/^\d+$/.test(part)) return Number(part);
    return part;
  });
}

/** Compares two versions per semver precedence. */
function compareVersions(left: Version, right: Version): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }

  return comparePrerelease(left.prerelease, right.prerelease);
}

function comparePrerelease(
  left: ReadonlyArray<string | number>,
  right: ReadonlyArray<string | number>,
): number {
  // A release outranks any prerelease of the same version.
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) break;
    if (a === b) continue;

    const aNumeric = typeof a === "number";
    const bNumeric = typeof b === "number";
    if (aNumeric && bNumeric) return a < b ? -1 : 1;
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return a < b ? -1 : 1;
  }

  if (left.length === right.length) return 0;
  return left.length < right.length ? -1 : 1;
}

/** Compares two version strings. Returns null when either side is invalid. */
export function compareVersionStrings(left: string, right: string): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  return compareVersions(a, b);
}

/**
 * Whether `remote` should replace `installed`.
 *
 * Pre-1.0 projects change behaviour in prerelease and patch releases, so any
 * newer release wins. A major bump is not taken silently.
 */
export function shouldUpgrade(installed: string, remote: string): boolean {
  const current = parseVersion(installed);
  const next = parseVersion(remote);
  if (!current || !next) return false;
  return compareVersions(next, current) > 0;
}

/** Lowest release `auto` will track. Earlier prereleases are not offered. */
const TRACKING_FLOOR = "1.0.0-rc.1";

/** True when a release is at or above the tracking floor. */
export function meetsTrackingFloor(version: string): boolean {
  const candidate = parseVersion(version);
  const floor = parseVersion(TRACKING_FLOOR);
  if (!candidate || !floor) return false;
  return compareVersions(candidate, floor) >= 0;
}

/** Returns the highest version in a list, ignoring invalid entries. */
export function highestVersion(versions: ReadonlyArray<string>): string | null {
  let best: Version | null = null;
  for (const candidate of versions) {
    const parsed = parseVersion(candidate);
    if (!parsed) continue;
    if (!best || compareVersions(parsed, best) > 0) best = parsed;
  }
  return best?.raw ?? null;
}

/** Strips a leading `v` from a release tag. */
export function normalizeVersion(tag: string): string {
  return tag.trim().replace(/^v/, "");
}
