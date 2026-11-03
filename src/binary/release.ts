// Release metadata, kept pure: asset naming, checksum parsing, and upgrade
// decisions. Verified against XERJ v1.0.0-rc.100:
//   xerj-<version>-<target>.tar.gz
//   xerj-<version>-<target>.tar.gz.sha256   ("<hex>  <filename>")
// The archive root is xerj-<version>-<target>/.

import type { ArchiveKind } from "../platform.ts";

const RELEASE_BASE = "https://github.com/xerj-org/xerj/releases/download";
const LATEST_URL = "https://github.com/xerj-org/xerj/releases/latest";

export function latestReleaseUrl(): string {
  return LATEST_URL;
}

/** Parses the final URL of the `releases/latest` redirect into a version. */
export function versionFromLatestUrl(finalUrl: string): string | null {
  const match = /\/tag\/(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\/?$/.exec(finalUrl);
  if (!match?.[1]) return null;
  return match[1].replace(/^v/, "");
}

export function assetName(version: string, target: string, archive: ArchiveKind): string {
  return `xerj-${version}-${target}.${archive}`;
}

export function assetUrl(version: string, asset: string): string {
  return `${RELEASE_BASE}/v${version}/${asset}`;
}

/** Extracts the 64-hex digest from a `.sha256` sidecar. */
export function checksumFrom(text: string): string | null {
  const first = text.trim().split(/\s+/)[0]?.toLowerCase();
  if (!first || !/^[0-9a-f]{64}$/.test(first)) return null;
  return first;
}

/** Archive root, e.g. `xerj-1.0.0-rc.100-x86_64-unknown-linux-musl`. */
export function archiveRoot(version: string, target: string): string {
  return `xerj-${version}-${target}`;
}

export interface ReleaseCache {
  readonly checkedAt: number;
  readonly version: string;
}

export const RELEASE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function cacheIsFresh(cache: ReleaseCache | null, now: number): boolean {
  if (!cache) return false;
  if (!Number.isFinite(cache.checkedAt)) return false;
  return now - cache.checkedAt < RELEASE_CACHE_TTL_MS;
}

export function parseReleaseCache(value: unknown): ReleaseCache | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const checkedAt = record.checkedAt;
  const version = record.version;
  if (typeof checkedAt !== "number" || typeof version !== "string") return null;
  if (!/^\d+\.\d+\.\d+/.test(version)) return null;
  return { checkedAt, version };
}
