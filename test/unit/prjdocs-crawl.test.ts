import { describe, expect, test } from "bun:test";
import {
  absolute,
  crawlDocs,
  extractPage,
  linksIn,
} from "../../src/prjdocs/crawl.ts";
import { docsTargets, versionLabel } from "../../src/prjdocs/sources.ts";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

function html(title: string, body: string, links: string[] = []): string {
  const anchors = links.map((href) => `<a href="${href}">link</a>`).join(" ");
  return `<html><head><title>${title}</title><style>.x{}</style></head><body>
    <nav>skip me</nav><h1>${title}</h1><p>${body}</p>${anchors}
    <script>console.log("skip")</script></body></html>`;
}

const longBody = "Documentation text that is long enough to be indexed. ".repeat(6);

describe("extractPage", () => {
  test("keeps prose and drops scripts, styles, and navigation", () => {
    const page = extractPage("https://example.test/doc", html("Guide", longBody));

    expect(page?.title).toBe("Guide");
    expect(page?.body).toContain("Documentation text");
    expect(page?.body).not.toContain("console.log");
    expect(page?.body).not.toContain("skip me");
    expect(page?.body).not.toContain("<p>");
  });

  test("a page with almost no text is not a document", () => {
    expect(extractPage("https://example.test/", "<html><body>hi</body></html>")).toBeNull();
  });
});

describe("linksIn and absolute", () => {
  test("collects anchors and resolves them against the page", () => {
    const links = linksIn(html("T", longBody, ["/a.html", "sub/b.html", "mailto:x@y"]));

    expect(links).toEqual(["/a.html", "sub/b.html"]);
    expect(absolute("/a.html", "https://example.test/docs/")).toBe(
      "https://example.test/a.html",
    );
    expect(absolute("sub/b.html", "https://example.test/docs/x.html")).toBe(
      "https://example.test/docs/sub/b.html",
    );
    expect(absolute("#top", "https://example.test/docs/")).toBe(
      "https://example.test/docs/",
    );
  });
});

describe("crawlDocs", () => {
  test("follows same-origin pages, skips assets, and respects the cap", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/start")) {
        return new Response(
          html("Start", longBody, ["/one", "/two", "/image.png", "https://other.test/x"]),
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url.endsWith("/one")) {
        return new Response(html("One", longBody, ["/start", "/two"]), {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response(html("Two", longBody), {
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;

    const pages = await crawlDocs({
      entry: "https://example.test/start",
      maxPages: 10,
      fetchImpl,
      logger,
    });

    expect(pages.map((page) => page.title)).toEqual(["Start", "One", "Two"]);
    expect(requested.some((url) => url.endsWith("image.png"))).toBe(false);
    expect(requested.some((url) => url.includes("other.test"))).toBe(false);
  });

  test("a non-HTML response is skipped", async () => {
    const fetchImpl = (async () =>
      new Response("{}", { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const pages = await crawlDocs({
      entry: "https://example.test/data",
      maxPages: 5,
      fetchImpl,
      logger,
    });

    expect(pages).toEqual([]);
  });

  test("a failing fetch is not an error", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const pages = await crawlDocs({
      entry: "https://example.test/",
      maxPages: 3,
      fetchImpl,
      logger,
    });

    expect(pages).toEqual([]);
  });
});

describe("docsTargets", () => {
  test("a versioned source gets one URL per version", () => {
    const targets = docsTargets(
      { id: "node", kind: "language", used: "20.11.0", evidence: "x" },
      "22.1.0",
    );

    expect(targets.map((target) => target.url)).toEqual([
      "https://nodejs.org/docs/latest-v20.x/api/",
      "https://nodejs.org/docs/latest-v22.x/api/",
    ]);
    expect(targets.map((target) => target.version)).toEqual(["20", "22"]);
  });

  test("python keeps major and minor", () => {
    const targets = docsTargets(
      { id: "python", kind: "language", used: "3.13.2", evidence: "x" },
      "3.14.0",
    );

    expect(targets.map((target) => target.url)).toEqual([
      "https://docs.python.org/3.13/library/index.html",
      "https://docs.python.org/3.14/library/index.html",
    ]);
  });

  test("the same version twice is one target", () => {
    const targets = docsTargets(
      { id: "node", kind: "language", used: "20.1.0", evidence: "x" },
      "20.9.0",
    );

    expect(targets).toHaveLength(1);
  });

  test("an unversioned source produces one target", () => {
    const targets = docsTargets(
      { id: "react", kind: "framework", used: "18.2.0", evidence: "x" },
      "19.0.0",
    );

    expect(targets).toEqual([
      {
        id: "react",
        url: "https://react.dev/reference/react",
        version: "latest",
      },
    ]);
  });

  test("an unknown technology has no targets", () => {
    expect(
      docsTargets({ id: "left-pad", kind: "framework", used: null, evidence: "x" }, null),
    ).toEqual([]);
  });

  test("a versionless project still gets one URL", () => {
    const targets = docsTargets(
      { id: "node", kind: "language", used: null, evidence: "x" },
      null,
    );

    expect(targets[0]?.version).toBe("latest");
    expect(targets[0]?.url).toBe("https://nodejs.org/api/");
    expect(targets[0]?.url).not.toContain("{");
  });
});

describe("versionLabel", () => {
  test("trims a version to what the docs site uses", () => {
    expect(versionLabel("node", "20.11.1")).toBe("20");
    expect(versionLabel("python", "3.13.2")).toBe("3.13");
    expect(versionLabel("rust", "1.75.0")).toBe("1.75.0");
    expect(versionLabel("python", "3")).toBeNull();
    expect(versionLabel("node", "latest")).toBeNull();
  });
});
