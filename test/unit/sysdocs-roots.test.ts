import { describe, expect, test } from "bun:test";
import { supplementaryRoots } from "../../src/sysdocs/roots.ts";

describe("supplementaryRoots", () => {
  test("puts user directories before the package managers", () => {
    const roots = supplementaryRoots({
      home: "/home/ana",
      env: {},
    });

    const man = roots.man;
    expect(man[0]).toBe("/home/ana/.local/share/man");
    expect(man).toContain("/home/ana/.nix-profile/share/man");
    expect(man).toContain("/home/linuxbrew/.linuxbrew/share/man");
  });

  test("honours XDG_DATA_HOME, HOMEBREW_PREFIX and NIX_PROFILES", () => {
    const roots = supplementaryRoots({
      home: "/home/ana",
      env: {
        XDG_DATA_HOME: "/data/share",
        HOMEBREW_PREFIX: "/opt/brew",
        NIX_PROFILES: "/nix/profile /run/current-system/sw",
      },
    });

    expect(roots.man[0]).toBe("/data/share/man");
    expect(roots.man).toContain("/opt/brew/share/man");
    expect(roots.man).toContain("/nix/profile/share/man");
    expect(roots.man).toContain("/run/current-system/sw/share/man");
    expect(roots.info).toContain("/opt/brew/share/info");
  });

  test("keeps the system roots last and drops duplicates", () => {
    const roots = supplementaryRoots({
      home: "/home/ana",
      env: { HOMEBREW_PREFIX: "/usr/local" },
    });

    expect(roots.man.at(-1)).toBe("/usr/share/man");
    expect(new Set(roots.man).size).toBe(roots.man.length);
    expect(roots.man.filter((path) => path === "/usr/local/share/man")).toHaveLength(1);
  });

  test("a missing home directory still yields the system roots", () => {
    const roots = supplementaryRoots({ home: null, env: {} });

    expect(roots.man.at(-2)).toBe("/usr/local/share/man");
    expect(roots.man.at(-1)).toBe("/usr/share/man");
    // The NixOS system profile and the Homebrew defaults do not depend on a
    // user's home, and a root that does not exist is skipped at scan time.
    expect(roots.man).toContain("/run/current-system/sw/share/man");
    // No home-derived roots, though the Linuxbrew default still lives under
    // /home: it is a package-manager prefix, not the user's own tree.
    expect(roots.man).not.toContain("/home/ana/.local/share/man");
    expect(roots.man).not.toContain("/home/ana/.nix-profile/share/man");
  });
});
