import { describe, expect, test } from "bun:test";
import {
  archiveRoot,
  assetName,
  assetUrl,
  cacheIsFresh,
  checksumFrom,
  parseReleaseCache,
  RELEASE_CACHE_TTL_MS,
  versionFromLatestUrl,
} from "../../src/binary/release.ts";

describe("asset naming", () => {
  test("matches the published release layout", () => {
    expect(
      assetName("1.0.0-rc.100", "x86_64-unknown-linux-musl", "tar.gz"),
    ).toBe("xerj-1.0.0-rc.100-x86_64-unknown-linux-musl.tar.gz");
  });

  test("builds a versioned download URL", () => {
    expect(assetUrl("1.0.0-rc.100", "xerj-1.0.0-rc.100-x86_64-unknown-linux-musl.tar.gz")).toBe(
      "https://github.com/xerj-org/xerj/releases/download/v1.0.0-rc.100/" +
        "xerj-1.0.0-rc.100-x86_64-unknown-linux-musl.tar.gz",
    );
  });

  test("archive root matches the extracted directory", () => {
    expect(archiveRoot("1.0.0-rc.100", "x86_64-unknown-linux-musl")).toBe(
      "xerj-1.0.0-rc.100-x86_64-unknown-linux-musl",
    );
  });
});

describe("checksumFrom", () => {
  test("reads the digest from a sidecar", () => {
    const digest = "a".repeat(64);
    expect(checksumFrom(`${digest}  xerj.tar.gz\n`)).toBe(digest);
  });

  test("rejects malformed sidecars", () => {
    expect(checksumFrom("not-a-digest  file")).toBeNull();
    expect(checksumFrom("abc")).toBeNull();
    expect(checksumFrom("")).toBeNull();
  });
});

describe("versionFromLatestUrl", () => {
  test("reads the tag from the redirect target", () => {
    expect(
      versionFromLatestUrl(
        "https://github.com/xerj-org/xerj/releases/tag/v1.0.0-rc.100",
      ),
    ).toBe("1.0.0-rc.100");
  });

  test("rejects a URL without a version tag", () => {
    expect(versionFromLatestUrl("https://github.com/xerj-org/xerj/releases")).toBeNull();
  });
});

describe("release cache", () => {
  const now = 1_000_000_000;

  test("is fresh inside the TTL", () => {
    expect(cacheIsFresh({ checkedAt: now - 1000, version: "1.0.0" }, now)).toBe(true);
  });

  test("is stale after the TTL", () => {
    expect(
      cacheIsFresh({ checkedAt: now - RELEASE_CACHE_TTL_MS - 1, version: "1.0.0" }, now),
    ).toBe(false);
  });

  test("ignores absent or invalid cache", () => {
    expect(cacheIsFresh(null, now)).toBe(false);
    expect(parseReleaseCache({ version: 3 })).toBeNull();
    expect(parseReleaseCache({ checkedAt: 1, version: "junk" })).toBeNull();
  });

  test("parses a valid cache", () => {
    expect(parseReleaseCache({ checkedAt: 1, version: "1.0.0-rc.100" })).toEqual({
      checkedAt: 1,
      version: "1.0.0-rc.100",
    });
  });
});
