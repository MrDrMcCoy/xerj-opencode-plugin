import { describe, expect, test } from "bun:test";
import { isRosetta, releaseTarget } from "../../src/platform.ts";

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
  });

  test("returns null for unpublished platforms", () => {
    expect(releaseTarget("freebsd", "x64")).toBeNull();
    expect(releaseTarget("linux", "ppc64")).toBeNull();
  });
});

describe("isRosetta", () => {
  test("reads the sysctl value", () => {
    expect(isRosetta("1\n")).toBe(true);
    expect(isRosetta("0\n")).toBe(false);
  });
});
