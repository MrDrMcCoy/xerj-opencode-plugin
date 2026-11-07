// jevos release metadata, kept pure: asset naming, target mapping, and the
// release checksum list. Verified against jevos-v5 (2026-10-16):
//   jev-linux-x64.tar.gz, jev-macos-arm64.tar.gz, jev-windows-x64.zip
//   jevos-v5-openvino-int8.zip (the model)
//   SHA256SUMS.txt ("<hex> *<name>")

export const JEVOS_RELEASES = "https://github.com/feder-cr/jev/releases/download";
export const DEFAULT_JEVOS_VERSION = "jevos-v5";
export const JEVOS_SUMS_ASSET = "SHA256SUMS.txt";

export type JevosArchive = "tar.gz" | "zip";

export interface JevosTarget {
  /** `<os>-<arch>` as the release names it. */
  readonly name: string;
  readonly archive: JevosArchive;
}

/**
 * The three platforms jevos publishes for. Everything else falls back to the
 * heuristic judge rather than shipping a binary that cannot run.
 */
export function jevosTarget(
  platform: NodeJS.Platform,
  arch: string,
): JevosTarget | null {
  if (platform === "linux" && arch === "x64") {
    return { name: "linux-x64", archive: "tar.gz" };
  }
  if (platform === "darwin" && arch === "arm64") {
    return { name: "macos-arm64", archive: "tar.gz" };
  }
  if (platform === "win32" && arch === "x64") {
    return { name: "windows-x64", archive: "zip" };
  }
  return null;
}

export function binaryAsset(target: JevosTarget): string {
  return `jev-${target.name}.${target.archive}`;
}

/** The OpenVINO int8 model; the tag's name is part of the asset. */
export function modelAsset(version: string): string {
  return `${version}-openvino-int8.zip`;
}

export function assetUrl(version: string, asset: string): string {
  return `${JEVOS_RELEASES}/${version}/${asset}`;
}

/**
 * Parses `SHA256SUMS.txt` into asset name -> digest. Lines are
 * `<hex> *<name>` or `<hex>  <name>`; anything malformed is ignored.
 */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match?.[1] && match[2]) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

/** A tag like `jevos-v5`; a bare `v5` is accepted and normalised. */
export function normaliseVersion(value: string): string {
  const trimmed = value.trim();
  if (/^jevos-v\d+(?:\.\d+)*$/.test(trimmed)) return trimmed;
  if (/^v\d+(?:\.\d+)*$/.test(trimmed)) return `jevos-${trimmed}`;
  return DEFAULT_JEVOS_VERSION;
}
