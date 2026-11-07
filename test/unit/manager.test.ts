import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireInstallLock,
  ensureBinary,
  BinaryError,
} from "../../src/binary/manager.ts";
import type { Logger } from "../../src/log.ts";
import { platformInfoForTarget } from "../../src/platform.ts";

const INFO = platformInfoForTarget("x86_64-unknown-linux-musl", "linux")!;
const RELEASES_API = "https://api.github.com/repos/xerj-org/xerj/releases";

const quietLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  async entries() {
    return [];
  },
  async flush() {},
};

function releaseList(tags: ReadonlyArray<{ tag: string; draft?: boolean }>) {
  return tags.map(({ tag, draft }) => ({ tag_name: tag, draft: draft ?? false }));
}

describe("ensureBinary auto tracking", () => {
  let root: string;
  let requested: string[];
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "xop-manager-"));
    requested = [];
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  });

  /** Serves the release list and records every other URL, failing the install. */
  function stubReleases(list: ReadonlyArray<{ tag: string; draft?: boolean }>) {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url === RELEASES_API || url.startsWith(`${RELEASES_API}?`)) {
        return new Response(JSON.stringify(releaseList(list)), { status: 200 });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
  }

  test("installs the newest release at or above the floor, across majors", async () => {
    stubReleases([
      { tag: "v1.0.0-rc.100" },
      { tag: "v2.0.0" },
      { tag: "v1.0.0-rc.101" },
      { tag: "v0.9.0" },
    ]);

    const failure = ensureBinary({
      root,
      requested: "auto",
      platform: "linux",
      info: INFO,
      logger: quietLogger,
    });

    await expect(failure).rejects.toBeInstanceOf(BinaryError);
    expect(requested.some((url) => url.includes("/v2.0.0/xerj-2.0.0-"))).toBe(true);
  });

  test("skips draft releases", async () => {
    stubReleases([{ tag: "v1.0.0-rc.100" }, { tag: "v9.0.0", draft: true }]);

    await expect(
      ensureBinary({
        root,
        requested: "auto",
        platform: "linux",
        info: INFO,
        logger: quietLogger,
      }),
    ).rejects.toBeInstanceOf(BinaryError);
    expect(requested.some((url) => url.includes("/v9.0.0/"))).toBe(false);
    expect(requested.some((url) => url.includes("/v1.0.0-rc.100/"))).toBe(true);
  });
});

describe("install lock", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "xop-lock-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("acquires, records its pid, and releases", async () => {
    const release = await acquireInstallLock(root, 1_000);
    expect(await readFile(join(root, ".install.lock", "pid"), "utf8")).toBe(
      String(process.pid),
    );
    await release();
    expect(
      await readFile(join(root, ".install.lock", "pid")).catch(() => null),
    ).toBeNull();
  });

  test("reclaims a lock whose owner is gone", async () => {
    const lock = join(root, ".install.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "pid"), "999999997");

    const release = await acquireInstallLock(root, 1_000);
    expect(await readFile(join(lock, "pid"), "utf8")).toBe(String(process.pid));
    await release();
  });

  test("reclaims a lock with no pid after the stale window", async () => {
    const lock = join(root, ".install.lock");
    await mkdir(lock, { recursive: true });
    const old = new Date(Date.now() - 6 * 60_000);
    await utimes(lock, old, old);

    const release = await acquireInstallLock(root, 1_000);
    await release();
  });

  test("waits out a live owner and then times out", async () => {
    const lock = join(root, ".install.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "pid"), String(process.pid));

    await expect(acquireInstallLock(root, 100)).rejects.toThrow(
      /another xerj install/,
    );
  }, 5_000);
});
