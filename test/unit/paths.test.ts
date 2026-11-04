import { describe, expect, test } from "bun:test";
import {
  brainPrefix,
  dataRoot,
  externalPrefix,
  indexPrefix,
  isOverbroadRoot,
  memoryNamespace,
  pathHash,
  projectNodeDir,
  resolveStorageRoot,
  scopedStorageKey,
  slug,
  webPrefix,
} from "../../src/paths.ts";

describe("dataRoot", () => {
  test("honours XDG_DATA_HOME on Linux", () => {
    expect(dataRoot({ XDG_DATA_HOME: "/xdg" }, "linux")).toBe("/xdg/opencode/xerj");
  });

  test("falls back to ~/.local/share on Linux", () => {
    expect(dataRoot({ HOME: "/home/me" }, "linux")).toBe("/home/me/.local/share/opencode/xerj");
  });

  test("uses Application Support on macOS", () => {
    expect(dataRoot({ HOME: "/Users/me" }, "darwin")).toBe(
      "/Users/me/Library/Application Support/opencode/xerj",
    );
  });

  test("uses LOCALAPPDATA on Windows", () => {
    expect(dataRoot({ LOCALAPPDATA: "C:/Users/me/AppData/Local" }, "win32")).toBe(
      "C:/Users/me/AppData/Local/opencode/xerj",
    );
  });
});

describe("resolveStorageRoot", () => {
  test("defaults to the project's .xerj", () => {
    expect(resolveStorageRoot("/repo", null)).toEqual({
      root: "/repo/.xerj",
      rejected: null,
    });
  });

  test("accepts an absolute path outside the project", () => {
    expect(resolveStorageRoot("/repo", "/var/lib/xerj")).toEqual({
      root: "/var/lib/xerj",
      rejected: null,
    });
  });

  test("refuses a visible directory inside the project", () => {
    expect(resolveStorageRoot("/repo", "data")).toEqual({
      root: "/repo/.xerj",
      rejected: "/repo/data",
    });
  });

  test("accepts another hidden directory inside the project", () => {
    expect(resolveStorageRoot("/repo", ".cache/xerj").root).toBe("/repo/.cache/xerj");
  });

  test("refuses the project root itself", () => {
    expect(resolveStorageRoot("/repo", ".")).toEqual({
      root: "/repo/.xerj",
      rejected: "/repo",
    });
  });

  test("puts each project's node under its own storage root", () => {
    expect(projectNodeDir("/repo/.xerj", "xop-a")).not.toBe(
      projectNodeDir("/other/.xerj", "xop-b"),
    );
  });
});

describe("slug", () => {
  test("lowercases and joins runs with dashes", () => {
    expect(slug("Xerj OpenCode_Plugin")).toBe("xerj-opencode-plugin");
  });

  test("never returns an empty slug", () => {
    expect(slug("...")).toBe("project");
  });

  test("caps the length and drops a trailing dash", () => {
    expect(slug("a".repeat(40)).length).toBe(24);
    expect(slug("abcdefghijklmnopqrstuvwx-").endsWith("-")).toBe(false);
  });
});

describe("pathHash", () => {
  test("is stable for the same path", () => {
    expect(pathHash("/data/project")).toBe(pathHash("/data/project"));
  });

  test("differs for different paths", () => {
    expect(pathHash("/data/a")).not.toBe(pathHash("/data/b"));
  });

  test("has the requested length", () => {
    expect(pathHash("/data/a", 6)).toHaveLength(6);
  });
});

describe("prefixes", () => {
  const project = "/data/ai/xerj-opencode-plugin";

  test("index prefix carries the slug and the path hash", () => {
    const prefix = indexPrefix(project);
    expect(prefix.startsWith("xop-xerj-opencode-plugin-")).toBe(true);
    expect(prefix).toBe(indexPrefix(project));
  });

  test("sibling projects with the same name stay distinct", () => {
    expect(indexPrefix("/one/project")).not.toBe(indexPrefix("/two/project"));
  });

  test("prefix characters are index-safe", () => {
    expect(indexPrefix("/data/My Project!(2)")).toMatch(/^[a-z0-9-]+$/);
  });

  test("web and external prefixes do not collide with the index prefix", () => {
    expect(webPrefix(project)).not.toBe(indexPrefix(project));
    expect(externalPrefix(project)).not.toBe(indexPrefix(project));
    expect(webPrefix(project)).not.toBe(externalPrefix(project));
  });

  test("brain prefix is namespaced by brain name", () => {
    expect(brainPrefix(project, "Docs")).toContain("xop-docs-");
    expect(brainPrefix(project, "docs")).not.toBe(brainPrefix(project, "notes"));
  });

  test("memory namespace is project scoped", () => {
    expect(memoryNamespace(project)).toStartWith("proj-xerj-opencode-plugin-");
  });
});

describe("scopedStorageKey", () => {
  test("separates two locations of one project", () => {
    const project = "/work/app";
    const alpha = scopedStorageKey("stats/lifetime", project, "/work/app");
    const beta = scopedStorageKey("stats/lifetime", project, "/work/app/docs");

    expect(alpha).toStartWith(`stats/lifetime:${project}:`);
    expect(alpha).not.toBe(beta);
  });

  test("keeps projects apart even at the same relative location", () => {
    const alpha = scopedStorageKey("log/ring", "/work/alpha", "/work/alpha");
    const beta = scopedStorageKey("log/ring", "/work/beta", "/work/beta");

    expect(alpha).not.toBe(beta);
  });
});

describe("isOverbroadRoot", () => {
  test("refuses the home directory and filesystem roots", () => {
    expect(isOverbroadRoot("/home/me", "/home/me", "linux")).toBe(true);
    expect(isOverbroadRoot("/", "/home/me", "linux")).toBe(true);
    expect(isOverbroadRoot("/home/me/project", "/home/me", "linux")).toBe(false);
  });

  test("compares resolved paths, not literals", () => {
    expect(isOverbroadRoot("/home/me/./", "/home/me", "linux")).toBe(true);
    expect(isOverbroadRoot("/home/me/../me/project", "/home/me", "linux")).toBe(false);
  });
});
