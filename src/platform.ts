// Release target selection. Mirrors the official installer: Linux defaults to
// the static musl build, and a Rosetta shell on Apple Silicon gets the native
// arm64 binary rather than a translated x86_64 one.

export type ArchiveKind = "tar.gz" | "zip";

export interface PlatformInfo {
  readonly target: string;
  readonly archive: ArchiveKind;
  readonly binary: string;
}

const ARCH: Record<string, string> = {
  x64: "x86_64",
  arm64: "aarch64",
};

/** Returns null for a platform XERJ does not publish. */
export function releaseTarget(
  platform: NodeJS.Platform,
  arch: string,
  rosetta = false,
): PlatformInfo | null {
  let cpu = ARCH[arch];
  if (!cpu) return null;

  if (platform === "darwin" || platform === "linux") {
    if (platform === "darwin" && rosetta) cpu = "aarch64";
    const suffix = platform === "darwin" ? "apple-darwin" : "unknown-linux-musl";
    return { target: `${cpu}-${suffix}`, archive: "tar.gz", binary: "xerj" };
  }

  if (platform === "win32") {
    return { target: `${cpu}-pc-windows-msvc`, archive: "zip", binary: "xerj.exe" };
  }

  return null;
}

/** Rosetta detection is a runtime fact; keep the pure selection separate. */
export function isRosetta(sysctlOutput: string): boolean {
  return sysctlOutput.trim() === "1";
}
