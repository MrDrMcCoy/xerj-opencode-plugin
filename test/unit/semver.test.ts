import { describe, expect, test } from "bun:test";
import {
  compareVersionStrings,
  highestVersion,
  meetsTrackingFloor,
  normalizeVersion,
  parseVersion,
  shouldUpgrade,
} from "../../src/semver.ts";

describe("parseVersion", () => {
  test("parses plain and prefixed versions", () => {
    expect(parseVersion("1.2.3")?.major).toBe(1);
    expect(parseVersion("v2.0.0")?.minor).toBe(0);
  });

  test("parses prerelease identifiers numerically", () => {
    expect(parseVersion("1.0.0-rc.100")?.prerelease).toEqual(["rc", 100]);
  });

  test("rejects malformed input", () => {
    expect(parseVersion("1.2")).toBeNull();
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});

describe("prerelease ordering", () => {
  test("ranks rc.100 above rc.99", () => {
    expect(compareVersionStrings("1.0.0-rc.100", "1.0.0-rc.99")).toBe(1);
    expect(compareVersionStrings("1.0.0-rc.99", "1.0.0-rc.100")).toBe(-1);
  });

  test("a release outranks its prereleases", () => {
    expect(compareVersionStrings("1.0.0", "1.0.0-rc.100")).toBe(1);
    expect(compareVersionStrings("1.0.0-rc.100", "1.0.0")).toBe(-1);
  });

  test("numeric identifiers outrank alphanumeric ones", () => {
    expect(compareVersionStrings("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    expect(compareVersionStrings("1.0.0-alpha.1", "1.0.0-alpha")).toBe(1);
  });
});

describe("shouldUpgrade", () => {
  test("takes any newer release, including a new major", () => {
    expect(shouldUpgrade("1.0.0-rc.99", "1.0.0-rc.100")).toBe(true);
    expect(shouldUpgrade("1.0.0-rc.100", "1.0.1")).toBe(true);
    expect(shouldUpgrade("1.0.0", "2.0.0")).toBe(true);
  });

  test("never downgrades", () => {
    expect(shouldUpgrade("1.0.0-rc.100", "1.0.0-rc.99")).toBe(false);
    expect(shouldUpgrade("2.0.0", "1.9.0")).toBe(false);
  });

  test("tracks only releases at or above the tracking floor", () => {
    expect(meetsTrackingFloor("1.0.0-rc.1")).toBe(true);
    expect(meetsTrackingFloor("1.0.0-rc.101")).toBe(true);
    expect(meetsTrackingFloor("1.0.0-rc.0")).toBe(false);
    expect(meetsTrackingFloor("0.9.0")).toBe(false);
    expect(meetsTrackingFloor("not-a-version")).toBe(false);
  });

  test("ignores invalid input", () => {
    expect(shouldUpgrade("not-a-version", "1.0.0")).toBe(false);
  });
});

describe("highestVersion", () => {
  test("picks the highest valid entry", () => {
    expect(highestVersion(["1.0.0-rc.9", "1.0.0-rc.100", "junk"])).toBe("1.0.0-rc.100");
  });

  test("returns null with no valid entries", () => {
    expect(highestVersion(["junk"])).toBeNull();
  });
});

describe("normalizeVersion", () => {
  test("strips the leading v", () => {
    expect(normalizeVersion("v1.0.0-rc.100")).toBe("1.0.0-rc.100");
  });
});
