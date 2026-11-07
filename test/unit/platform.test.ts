import { describe, expect, test } from "bun:test";
import {
  effectiveArch,
  isRosetta,
  platformInfoForTarget,
  releaseTarget,
} from "../../src/platform.ts";

describe("releaseTarget", () => {
  test("uses the static musl build on Linux", () => {
    expect(releaseTarget("linux", "x64")).toEqual({
      target: "x86_64-unknown-linux-musl",
      archive: "tar.gz",
      binary: "xerj",
    });
  });

  test("maps arm64 to aarch64", () => {
    expect(releaseTarget("linux", "arm64")?.target).toBe("aarch64-unknown-linux-musl");
  });

  test("corrects a Rosetta shell to native arm64", () => {
    expect(releaseTarget("darwin", "x64", true)?.target).toBe("aarch64-apple-darwin");
    expect(releaseTarget("darwin", "x64", false)?.target).toBe("x86_64-apple-darwin");
  });

  test("uses a zip on Windows", () => {
    expect(releaseTarget("win32", "x64")).toEqual({
      target: "x86_64-pc-windows-msvc",
      archive: "zip",
      binary: "xerj.exe",
    });
    expect(releaseTarget("win32", "arm64")?.target).toBe("aarch64-pc-windows-msvc");
  });

  test("honours an explicit libc on Linux", () => {
    expect(releaseTarget("linux", "x64", false, "gnu")?.target).toBe(
      "x86_64-unknown-linux-gnu",
    );
    expect(releaseTarget("linux", "arm64", false, "gnu")?.target).toBe(
      "aarch64-unknown-linux-gnu",
    );
  });

  test("returns null for unpublished platforms", () => {
    expect(releaseTarget("freebsd", "x64")).toBeNull();
    expect(releaseTarget("linux", "ppc64")).toBeNull();
  });
});

describe("platformInfoForTarget", () => {
  test("accepts a matching host and target", () => {
    expect(platformInfoForTarget("aarch64-apple-darwin", "darwin")).toEqual({
      target: "aarch64-apple-darwin",
      archive: "tar.gz",
      binary: "xerj",
    });
    expect(platformInfoForTarget("x86_64-pc-windows-msvc", "win32")?.archive).toBe("zip");
  });

  test("rejects cross-OS targets and malformed triples", () => {
    expect(platformInfoForTarget("x86_64-unknown-linux-musl", "win32")).toBeNull();
    expect(platformInfoForTarget("x86_64-pc-windows-msvc", "darwin")).toBeNull();
    expect(platformInfoForTarget("not-a-target", "linux")).toBeNull();
  });
});

describe("effectiveArch", () => {
  test("trusts the host except where Node reports x64 on arm64", () => {
    expect(effectiveArch("linux", "arm64", {})).toBe("arm64");
    expect(effectiveArch("darwin", "x64", {}, true)).toBe("arm64");
    expect(effectiveArch("win32", "x64", { PROCESSOR_ARCHITECTURE: "ARM64" })).toBe("arm64");
    expect(effectiveArch("win32", "x64", { PROCESSOR_ARCHITECTURE: "AMD64" })).toBe("x64");
  });
});

describe("isRosetta", () => {
  test("reads the sysctl value", () => {
    expect(isRosetta("1\n")).toBe(true);
    expect(isRosetta("0\n")).toBe(false);
  });
});

describe("detectRuntime", () => {
  test("selects the host triple and libc", async () => {
    const { detectRuntime } = await import("../../src/binary/detect.ts");
    const detected = await detectRuntime({
      libc: "musl",
      target: null,
      platform: "linux",
      arch: "x64",
      rosetta: false,
    });

    expect(detected).toMatchObject({
      platform: "linux",
      arch: "x64",
      rosetta: false,
      info: { target: "x86_64-unknown-linux-musl", archive: "tar.gz" },
    });
  });

  test("an explicit target wins over host detection", async () => {
    const { detectRuntime } = await import("../../src/binary/detect.ts");
    const detected = await detectRuntime({
      libc: "musl",
      target: "aarch64-unknown-linux-gnu",
      platform: "linux",
      arch: "x64",
    });

    expect(detected.info?.target).toBe("aarch64-unknown-linux-gnu");
  });

  test("a Rosetta shell gets the native arm64 build", async () => {
    const { detectRuntime } = await import("../../src/binary/detect.ts");
    const detected = await detectRuntime({
      libc: "gnu",
      target: null,
      platform: "darwin",
      arch: "x64",
      rosetta: true,
    });

    expect(detected.info?.target).toBe("aarch64-apple-darwin");
  });

  test("an unknown target returns no release info", async () => {
    const { detectRuntime } = await import("../../src/binary/detect.ts");
    const detected = await detectRuntime({
      libc: "musl",
      target: "not-a-triple",
      platform: "linux",
      arch: "x64",
    });

    expect(detected.info).toBeNull();
  });
});
