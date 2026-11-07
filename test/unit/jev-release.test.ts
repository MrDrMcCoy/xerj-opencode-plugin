import { describe, expect, test } from "bun:test";
import {
  assetUrl,
  binaryAsset,
  DEFAULT_JEVOS_VERSION,
  jevosTarget,
  modelAsset,
  normaliseVersion,
  parseSums,
} from "../../src/jev/release.ts";

describe("jevos targets", () => {
  test("the three published platforms map to their assets", () => {
    expect(jevosTarget("linux", "x64")).toEqual({ name: "linux-x64", archive: "tar.gz" });
    expect(jevosTarget("darwin", "arm64")).toEqual({ name: "macos-arm64", archive: "tar.gz" });
    expect(jevosTarget("win32", "x64")).toEqual({ name: "windows-x64", archive: "zip" });
  });

  test("an unpublished platform returns null", () => {
    expect(jevosTarget("linux", "arm64")).toBeNull();
    expect(jevosTarget("darwin", "x64")).toBeNull();
    expect(jevosTarget("win32", "arm64")).toBeNull();
  });

  test("asset names and URLs follow the release", () => {
    const target = jevosTarget("linux", "x64")!;
    expect(binaryAsset(target)).toBe("jev-linux-x64.tar.gz");
    expect(modelAsset(DEFAULT_JEVOS_VERSION)).toBe("jevos-v5-openvino-int8.zip");
    expect(assetUrl(DEFAULT_JEVOS_VERSION, "jev-linux-x64.tar.gz")).toBe(
      "https://github.com/feder-cr/jev/releases/download/jevos-v5/jev-linux-x64.tar.gz",
    );
  });
});

describe("parseSums", () => {
  test("reads the star and double-space forms", () => {
    const sums = parseSums(
      [
        "0a1159c31b9c2abc484af9c866cdcfe5279fdf592b368636625c5a795f970acc *jevos-v5-openvino-int8.zip",
        "1CE77566405514ED2F20D64F8222CF9EBA9B714D332F05F6296E0CAD84DD7B04  jev-linux-x64.tar.gz",
        "not a checksum",
      ].join("\n"),
    );

    expect(sums.get("jevos-v5-openvino-int8.zip")).toBe(
      "0a1159c31b9c2abc484af9c866cdcfe5279fdf592b368636625c5a795f970acc",
    );
    expect(sums.get("jev-linux-x64.tar.gz")).toBe(
      "1ce77566405514ed2f20d64f8222cf9eba9b714d332f05f6296e0cad84dd7b04",
    );
    expect(sums.size).toBe(2);
  });
});

describe("normaliseVersion", () => {
  test("accepts a tag or a bare version", () => {
    expect(normaliseVersion("jevos-v5")).toBe("jevos-v5");
    expect(normaliseVersion("v5")).toBe("jevos-v5");
    expect(normaliseVersion("jevos-v6.1")).toBe("jevos-v6.1");
    expect(normaliseVersion("garbage")).toBe(DEFAULT_JEVOS_VERSION);
  });
});
