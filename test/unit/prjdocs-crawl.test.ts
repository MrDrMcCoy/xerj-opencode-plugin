import { describe, expect, test } from "bun:test";
import {
  absolute,
  crawlDocs,
  extractPage,
  extractPlain,
  linksIn,
} from "../../src/prjdocs/crawl.ts";
import { docsTargets, versionLabel } from "../../src/prjdocs/sources.ts";
import {
  builtinSources,
  elasticsearchBranch,
  listRepoDocs,
  xerjDocsSource,
} from "../../src/prjdocs/builtin.ts";

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

describe("eager crawling", () => {
  test("follows past depth two when allowed", async () => {
    const chain = ["/d0", "/d1", "/d2", "/d3", "/d4"];
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      const index = chain.findIndex((part) => url.endsWith(part));
      const nextLink = chain[index + 1] !== undefined ? [chain[index + 1] ?? ""] : [];
      return new Response(html(`Level ${index}`, longBody, nextLink), {
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;

    const limited = await crawlDocs({
      entry: "https://example.test/d0",
      maxPages: 10,
      fetchImpl,
      logger,
    });
    const eager = await crawlDocs({
      entry: "https://example.test/d0",
      maxPages: 10,
      maxDepth: 10,
      fetchImpl,
      logger,
    });

    expect(limited).toHaveLength(3);
    expect(eager).toHaveLength(5);
  });

  test("accepts plain text and markdown when asked", async () => {
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith(".md")) {
        return new Response(`# Guide\n\n${longBody}` , {
          headers: { "content-type": "text/markdown" },
        });
      }
      return new Response(longBody, { headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch;

    const plain = await crawlDocs({
      entry: "https://example.test/notes.txt",
      maxPages: 3,
      fetchImpl,
      logger,
    });
    const eager = await crawlDocs({
      entry: "https://example.test/notes.txt",
      maxPages: 3,
      anyText: true,
      fetchImpl,
      logger,
    });

    expect(plain).toEqual([]);
    expect(eager).toHaveLength(1);
  });

  test("a judged page keeps its links; a rejected page is not followed", async () => {
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/start")) {
        return new Response(html("Start", longBody, ["/good", "/bad"]), {
          headers: { "content-type": "text/html" },
        });
      }
      if (url.endsWith("/bad")) {
        return new Response(html("Bad", longBody, ["/from-bad"]), {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response(html("Good", longBody), {
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;

    const pages = await crawlDocs({
      entry: "https://example.test/start",
      maxPages: 10,
      fetchImpl,
      logger,
      judge: async (page) => !page.url.includes("/bad"),
    });

    expect(pages.map((page) => page.url.split("/").pop())).toEqual(["start", "good"]);
  });
});

describe("extractPlain", () => {
  test("a short text page is not a document", () => {
    expect(extractPlain("https://example.test/x.txt", "too short")).toBeNull();
  });

  test("the first line becomes the title", () => {
    const page = extractPlain(`https://example.test/x.txt`, `First line\n\n${longBody}`);
    expect(page?.title).toBe("First line");
  });

  test("markdown headings and fences are cleaned but text is kept", () => {
    const body = `# Guide\n\n\`\`\`ts\nconst a = 1;\n\`\`\`\n\n${longBody}`;
    const page = extractPlain("https://example.test/x.md", body, true);

    expect(page?.body).not.toContain("# Guide");
    expect(page?.body).not.toContain("```");
    expect(page?.body).toContain("const a = 1;");
    expect(page?.title).toBe("Guide");
  });
});

describe("crawler limits", () => {
  test("a page larger than maxBytes is skipped", async () => {
    const huge = "x".repeat(5_000);
    const fetchImpl = (async () =>
      new Response(html("Huge", huge), {
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;

    const pages = await crawlDocs({
      entry: "https://example.test/huge",
      maxPages: 3,
      maxBytes: 1_000,
      fetchImpl,
      logger,
    });

    expect(pages).toEqual([]);
  });

  test("a fetch that returns a bad status is skipped", async () => {
    const fetchImpl = (async () =>
      new Response("missing", { status: 404 })) as unknown as typeof fetch;

    const pages = await crawlDocs({
      entry: "https://example.test/missing",
      maxPages: 3,
      fetchImpl,
      logger,
    });

    expect(pages).toEqual([]);
  });
});

describe("builtin documentation sources", () => {
  const tree = {
    tree: [
      { type: "blob", path: "README.md", size: 10 },
      { type: "blob", path: "docs/README.md", size: 10 },
      { type: "blob", path: "docs/recipes/agentic-memory.md", size: 20 },
      { type: "blob", path: "docs/ARCHITECTURE.md", size: 30 },
      { type: "blob", path: "docs/shots/console.png", size: 40 },
      { type: "blob", path: "docs/tool.mjs", size: 50 },
      { type: "tree", path: "docs/sub" },
    ],
  };

  function fetcher(): { calls: string[]; fetchImpl: typeof fetch } {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("api.github.com")) {
        return new Response(JSON.stringify(tree), { status: 200 });
      }
      const name = url.split("/").pop() ?? "page.md";
      return new Response(`# ${name}\n\n${longBody}`, { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  test("lists only markdown under docs, shallow first", async () => {
    const { fetchImpl } = fetcher();
    const paths = await listRepoDocs({ logger, fetchImpl });

    // Depth first, then alphabetical: the overview files land before the tree.
    expect(paths).toEqual([
      "docs/ARCHITECTURE.md",
      "docs/README.md",
      "docs/recipes/agentic-memory.md",
    ]);
  });

  test("fetches each page as markdown and titles it by heading", async () => {
    const { fetchImpl } = fetcher();
    const pages = await xerjDocsSource({ logger, fetchImpl }).collect();

    expect(pages).toHaveLength(3);
    expect(pages[0]?.title).toContain("ARCHITECTURE.md");
    expect(pages[0]?.url).toContain("github.com/xerj-org/xerj/blob/main/docs/ARCHITECTURE.md");
    expect(pages[0]?.body).toContain("Documentation text");
  });

  test("the page budget applies", async () => {
    const { fetchImpl } = fetcher();
    const pages = await xerjDocsSource({ logger, fetchImpl, xerjMaxPages: 1 }).collect();

    expect(pages).toHaveLength(1);
  });

  test("a failed tree listing yields nothing rather than throwing", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const pages = await xerjDocsSource({ logger, fetchImpl }).collect();

    expect(pages).toEqual([]);
  });

  test("a failed page fetch is skipped", async () => {
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("api.github.com")) {
        return new Response(JSON.stringify(tree));
      }
      if (url.endsWith("ARCHITECTURE.md")) return new Response("missing", { status: 404 });
      return new Response(`# Page\n\n${longBody}`);
    }) as unknown as typeof fetch;

    const pages = await xerjDocsSource({ logger, fetchImpl }).collect();
    expect(pages.length).toBe(2);
  });

  test("the elasticsearch branch follows the wire version", () => {
    expect(elasticsearchBranch("8.13.0")).toBe("8.13");
    expect(elasticsearchBranch("8.19.4")).toBe("8.19");
    expect(elasticsearchBranch("unknown")).toBe("8.13");
  });

  test("both sources are built, in order", () => {
    const sources = builtinSources("8.13.0", { logger, fetchImpl: fetcher().fetchImpl });

    expect(sources.map((source) => source.tech)).toEqual(["xerj", "elasticsearch"]);
    expect(sources[1]?.url).toContain("/reference/8.13/index.html");
  });
});
