// Release target selection. Mirrors the official installer: Linux defaults to
// the static musl build, and a Rosetta shell on Apple Silicon gets the native
// arm64 binary rather than a translated x86_64 one.

export type ArchiveKind = "tar.gz" | "zip";
export type Libc = "musl" | "gnu";

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
  libc: Libc = "musl",
): PlatformInfo | null {
  let cpu = ARCH[arch];
  if (!cpu) return null;

  if (platform === "darwin" || platform === "linux") {
    if (platform === "darwin" && rosetta) cpu = "aarch64";
    const suffix =
      platform === "darwin"
        ? "apple-darwin"
        : libc === "gnu"
          ? "unknown-linux-gnu"
          : "unknown-linux-musl";
    return { target: `${cpu}-${suffix}`, archive: "tar.gz", binary: "xerj" };
  }

  if (platform === "win32") {
    return { target: `${cpu}-pc-windows-msvc`, archive: "zip", binary: "xerj.exe" };
  }

  return null;
}

/** Builds PlatformInfo from an explicit target, for pinned or exotic hosts. */
export function platformInfoForTarget(
  target: string,
  platform: NodeJS.Platform,
): PlatformInfo | null {
  const trimmed = target.trim();
  if (!/^(x86_64|aarch64)-[a-z0-9-]+$/.test(trimmed)) return null;

  const windows = trimmed.includes("windows");
  if (windows && platform !== "win32") return null;
  if (!windows && platform === "win32") return null;

  return {
    target: trimmed,
    archive: windows ? "zip" : "tar.gz",
    binary: windows ? "xerj.exe" : "xerj",
  };
}

/**
 * Node reports the architecture of the process, which lies in two cases: an
 * x86_64 Node under Rosetta 2 on Apple Silicon, and an x64 Node on Windows
 * ARM64. Both should install the native arm64 build.
 */
export function effectiveArch(
  platform: NodeJS.Platform,
  arch: string,
  env: Readonly<Record<string, string | undefined>>,
  rosetta = false,
): string {
  if (platform === "darwin" && rosetta) return "arm64";
  if (platform !== "win32") return arch;

  const reported = (env.PROCESSOR_ARCHITECTURE ?? env.PROCESSOR_ARCHITEW6432 ?? "").toUpperCase();
  if (reported === "ARM64" && arch === "x64") return "arm64";
  return arch;
}

/** Rosetta detection is a runtime fact; keep the pure selection separate. */
export function isRosetta(sysctlOutput: string): boolean {
  return sysctlOutput.trim() === "1";
}
