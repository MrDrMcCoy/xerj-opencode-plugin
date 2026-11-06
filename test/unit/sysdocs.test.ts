import { describe, expect, test } from "bun:test";
import {
  dedupePages,
  formatSysdoc,
  manPageName,
  planIngest,
  stripRoff,
  truncate,
  type SysdocPage,
} from "../../src/sysdocs/extract.ts";

function page(overrides: Partial<SysdocPage> = {}): SysdocPage {
  return {
    path: "/usr/share/man/man1/git.1.gz",
    name: "git",
    section: "1",
    source: "man",
    mtime: 1000,
    size: 100,
    ...overrides,
  };
}

describe("manPageName", () => {
  test("reads the name and section from a compressed page", () => {
    expect(manPageName("/usr/share/man/man1/git.1.gz")).toEqual({
      name: "git",
      section: "1",
    });
  });

  test("handles sections with a suffix and plain files", () => {
    expect(manPageName("/usr/man/man3p/perlfunc.3p.gz")).toEqual({
      name: "perlfunc",
      section: "3p",
    });
    expect(manPageName("/usr/man/man5/hosts.5")).toEqual({
      name: "hosts",
      section: "5",
    });
  });

  test("rejects anything that is not a page", () => {
    expect(manPageName("/usr/share/man/man1/README")).toBeNull();
    expect(manPageName("/usr/share/man/man1/.1.gz")).toBeNull();
  });
});

describe("dedupePages", () => {
  test("keeps the first path for a name and section", () => {
    // Discovery lists directories in MANPATH order, so the first copy is the
    // one `man` would show.
    const pages = [
      page({ path: "/usr/local/share/man/man1/git.1.gz", mtime: 2 }),
      page({ path: "/usr/share/man/man1/git.1.gz", mtime: 1 }),
    ];

    const kept = dedupePages(pages);
    expect(kept.map((entry) => entry.path)).toEqual([
      "/usr/local/share/man/man1/git.1.gz",
    ]);
  });

  test("keeps different sections of one name", () => {
    const kept = dedupePages([
      page({ path: "/m/man1/git.1.gz", section: "1" }),
      page({ path: "/m/man5/git.5.gz", section: "5" }),
    ]);

    expect(kept).toHaveLength(2);
  });

  test("keeps one page per name when a newer version replaces it", () => {
    const kept = dedupePages([
      page({ path: "/m/man1/python3.11.1.gz", name: "python3.11" }),
      page({ path: "/m/man1/python3.13.1.gz", name: "python3.13" }),
    ]);

    // Different programs, different names: both stay.
    expect(kept).toHaveLength(2);
  });
});

describe("stripRoff", () => {
  test("drops macro lines and keeps prose", () => {
    const text = [
      '.TH GIT 1 "2024-01-01"',
      ".SH NAME",
      "git \\- the stupid content tracker",
      ".SH SYNOPSIS",
      ".B git",
      "[--version]",
    ].join("\n");

    const cleaned = stripRoff(text);
    expect(cleaned).toContain("git - the stupid content tracker");
    expect(cleaned).toContain("SYNOPSIS");
    expect(cleaned).toContain("git");
    expect(cleaned).not.toContain(".TH");
    expect(cleaned).not.toContain(".SH");
    expect(cleaned).not.toContain("\\-");
  });

  test("collapses runs of blank lines", () => {
    expect(stripRoff("a\n\n\n\nb\n")).toBe("a\n\nb");
  });
});

describe("truncate", () => {
  test("keeps short text and cuts long text on a space", () => {
    expect(truncate("short", 100)).toBe("short");

    const long = "word ".repeat(50);
    const cut = truncate(long, 40);
    expect(cut.length).toBeLessThanOrEqual(40);
    expect(cut.endsWith("…")).toBe(true);
  });
});

describe("planIngest", () => {
  test("skips a page unchanged since the manifest", () => {
    const plan = planIngest([page()], {
      "/usr/share/man/man1/git.1.gz": {
        id: "abc",
        mtime: 1000,
        size: 100,
        source: "man",
      },
    });

    expect(plan.ingest).toEqual([]);
    expect(plan.prune).toEqual([]);
    expect(plan.skipped).toBe(1);
  });

  test("re-indexes a changed page and prunes a vanished one", () => {
    const plan = planIngest([page({ mtime: 2000 })], {
      "/usr/share/man/man1/git.1.gz": {
        id: "abc",
        mtime: 1000,
        size: 100,
        source: "man",
      },
      "/usr/share/man/man1/gone.1.gz": {
        id: "def",
        mtime: 1,
        size: 1,
        source: "man",
      },
    });

    expect(plan.ingest.map((entry) => entry.path)).toEqual([
      "/usr/share/man/man1/git.1.gz",
    ]);
    expect(plan.prune).toEqual(["def"]);
    expect(plan.skipped).toBe(0);
  });

  test("a new page is ingested and an empty manifest prunes nothing", () => {
    const plan = planIngest([page()], {});
    expect(plan.ingest).toHaveLength(1);
    expect(plan.prune).toEqual([]);
  });
});

describe("formatSysdoc", () => {
  test("writes provenance and a searchable title", () => {
    const document = formatSysdoc(
      page({ name: "git", section: "1" }),
      "git - the stupid content tracker",
    );

    expect(document.title).toBe("git(1)");
    expect(document.path).toBe("man/git.1");
    expect(document.body).toContain("git - the stupid content tracker");
    expect(document.source).toBe("man");
  });

  test("info pages keep their node path", () => {
    const document = formatSysdoc(
      page({
        path: "/usr/share/info/coreutils.info.gz",
        name: "coreutils",
        section: "",
        source: "info",
      }),
      "coreutils: Top",
    );

    expect(document.title).toBe("coreutils (info)");
    expect(document.path).toBe("info/coreutils");
  });
});
