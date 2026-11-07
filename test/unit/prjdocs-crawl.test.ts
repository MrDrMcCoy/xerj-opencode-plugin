import { describe, expect, test } from "bun:test";
import {
  absolute,
  crawlDocs,
  extractPage,
  extractPlain,
  linksIn,
} from "../../src/prjdocs/crawl.ts";
import { docsTargets, versionLabel } from "../../src/prjdocs/sources.ts";
import { HostRateLimiter as RateLimiter } from "../../src/prjdocs/ratelimit.ts";
import {
  builtinSources,
  elasticsearchBranch,
  elasticsearchDocsSource,
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

    expect(targets).toHaveLength(1);
    expect(targets[0]?.id).toBe("react");
    expect(targets[0]?.url).toBe("https://react.dev/reference/react");
    expect(targets[0]?.version).toBe("latest");
    // A single-site source names no component guides.
    expect(targets[0]?.seeds ?? []).toEqual([]);
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

describe("elasticsearch chapter discovery", () => {
  test("chapters come from rest-apis.html, with the summary first", async () => {
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("rest-apis.html")) {
        return new Response(
          `<html><body>
             <a href="indices.html">Indices</a>
             <a href="cat.html">CAT</a>
             <a href="../current/index.html">Current</a>
             <a href="rest-apis.html">Self</a>
           </body></html>`,
        );
      }
      return new Response(
        `<html><head><title>Elasticsearch API</title></head><body><p>${longBody}</p></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }) as unknown as typeof fetch;

    const pages = await elasticsearchDocsSource("8.13.0", {
      logger,
      fetchImpl,
      maxPages: 40,
    }).collect();

    // Only pages inside the branch are collected: `../current/` is dropped.
    expect(pages.every((page) => page.url.includes("/reference/8.13/"))).toBe(true);
    expect(pages.some((page) => page.url.endsWith("/indices.html"))).toBe(true);
    expect(pages.some((page) => page.url.endsWith("/cat.html"))).toBe(true);
  });

  test("a missing rest-apis.html falls back to the known chapter list", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("rest-apis.html")) return new Response("gone", { status: 404 });
      return new Response(
        `<html><head><title>Elasticsearch guide</title></head><body><p>${longBody}</p></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }) as unknown as typeof fetch;

    const pages = await elasticsearchDocsSource("8.13.0", {
      logger,
      fetchImpl,
      maxPages: 12,
    }).collect();

    expect(requested.some((url) => url.endsWith("/query-dsl.html"))).toBe(true);
    expect(pages.length).toBeGreaterThan(0);
  });

  test("a failed chapter crawl does not stop the others", async () => {
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("rest-apis.html")) {
        return new Response(`<a href="indices.html">i</a><a href="cat.html">c</a>`);
      }
      if (url.endsWith("cat.html")) throw new Error("network down");
      return new Response(
        `<html><head><title>Elasticsearch API</title></head><body><p>${longBody}</p></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }) as unknown as typeof fetch;

    const pages = await elasticsearchDocsSource("8.13.0", {
      logger,
      fetchImpl,
      maxPages: 20,
    }).collect();

    expect(pages.some((page) => page.url.endsWith("/indices.html"))).toBe(true);
  });
});

describe("crawl boundary options", () => {
  test("links outside the url prefix are not followed", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      requested.push(url);
      return new Response(
        html("Guide", longBody, ["/guide/a.html", "/blog/post.html"]),
        { headers: { "content-type": "text/html" } },
      );
    }) as unknown as typeof fetch;

    const pages = await crawlDocs({
      entry: "https://example.test/guide/index.html",
      maxPages: 5,
      urlPrefix: "https://example.test/guide/",
      fetchImpl,
      logger,
    });

    expect(pages).toHaveLength(2);
    expect(requested.some((url) => url.includes("/blog/"))).toBe(false);
  });

  test("the delay option is applied between pages", async () => {
    const fetchImpl = (async () =>
      new Response(html("Page", longBody, ["/next"]), {
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;

    const started = Date.now();
    await crawlDocs({
      entry: "https://example.test/one",
      maxPages: 2,
      delayMs: 30,
      fetchImpl,
      logger,
    });

    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });
});

describe("page titles and asset links", () => {
  test("a page without a markdown heading is titled by its path", async () => {
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("api.github.com")) {
        return new Response(JSON.stringify({ tree: [{ type: "blob", path: "docs/plain.md" }] }));
      }
      // No `#` heading anywhere in the body.
      return new Response(`Plain documentation text without a heading.\n\n${longBody}`);
    }) as unknown as typeof fetch;

    const pages = await xerjDocsSource({ logger, fetchImpl }).collect();

    // `stripRoff`-free fallback: the file name plus the first line.
    expect(pages[0]?.title).toContain("plain.md");
  });

  test("asset links next to documentation links are not followed", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      requested.push(url);
      return new Response(
        html("Guide", longBody, ["/docs/page.html", "/docs/manual.pdf", "/docs/app.js"]),
        { headers: { "content-type": "text/html" } },
      );
    }) as unknown as typeof fetch;

    await crawlDocs({
      entry: "https://example.test/docs/index.html",
      maxPages: 5,
      fetchImpl,
      logger,
    });

    expect(requested.some((url) => url.endsWith(".pdf"))).toBe(false);
    expect(requested.some((url) => url.endsWith(".js"))).toBe(false);
  });
});

describe("eager elasticsearch guide coverage", () => {
  const guide = `<html><body>
      <a href="getting-started.html">Start</a>
      <a href="concepts.html">Concepts</a>
      <a href="rest-apis.html">API</a>
      <a href="release-notes.html">Release notes</a>
      <a href="migrating-8.13.html">Migrating</a>
      <a href="deprecated-apis.html">Deprecated</a>
    </body></html>`;

  function fetcher(requested: string[]): typeof fetch {
    return (async (input: string | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/index.html")) return new Response(guide);
      return new Response(
        `<html><head><title>Elasticsearch guide</title></head><body><p>${longBody}</p></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }) as unknown as typeof fetch;
  }

  test("eager mode crawls the guide's chapters", async () => {
    const requested: string[] = [];
    const pages = await elasticsearchDocsSource("8.13.0", {
      logger,
      fetchImpl: fetcher(requested),
      maxPages: 60,
      eager: true,
    }).collect();

    expect(requested.some((url) => url.endsWith("/concepts.html"))).toBe(true);
    expect(pages.some((page) => page.url.endsWith("/concepts.html"))).toBe(true);
  });

  test("release notes, migration, and deprecated pages stay out", async () => {
    const requested: string[] = [];
    const pages = await elasticsearchDocsSource("8.13.0", {
      logger,
      fetchImpl: fetcher(requested),
      maxPages: 60,
      eager: true,
    }).collect();

    const urls = pages.map((page) => page.url).join(" ");
    expect(urls).not.toContain("release-notes");
    expect(urls).not.toContain("migrating-");
    expect(urls).not.toContain("deprecated-");
    expect(requested.some((url) => url.includes("release-notes"))).toBe(false);
  });

  test("the default crawl still starts from the API chapters", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("rest-apis.html")) {
        return new Response(`<a href="indices.html">i</a><a href="cat.html">c</a>`);
      }
      return new Response(
        `<html><head><title>Elasticsearch API</title></head><body><p>${longBody}</p></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }) as unknown as typeof fetch;

    await elasticsearchDocsSource("8.13.0", { logger, fetchImpl, maxPages: 20 }).collect();

    expect(requested.some((url) => url.endsWith("/rest-apis.html"))).toBe(true);
    expect(requested.some((url) => url.endsWith("/index.html"))).toBe(false);
  });
});

describe("crawl politeness", () => {
  test("sends the crawler user agent and retries a throttled response", async () => {
    const agents: string[] = [];
    let calls = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      agents.push(String((init?.headers as Record<string, string>)["user-agent"]));
      calls += 1;
      if (calls === 1) {
        return new Response("", { status: 429, headers: { "retry-after": "0" } });
      }
      return new Response(html("Guide", longBody), {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;
    const limiter = new RateLimiter({ intervalMs: 0, sleep: async () => {} });

    const pages = await crawlDocs({
      entry: "https://example.test/doc",
      maxPages: 1,
      logger,
      fetchImpl,
      limiter,
    });

    expect(agents[0]).toContain("Googlebot");
    expect(calls).toBe(2);
    expect(pages).toHaveLength(1);
  });

  test("a configured user agent wins", async () => {
    const agents: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      agents.push(String((init?.headers as Record<string, string>)["user-agent"]));
      return new Response(html("Guide", longBody), {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;

    await crawlDocs({
      entry: "https://example.test/doc",
      maxPages: 1,
      logger,
      fetchImpl,
      userAgent: "XerjDocsBot/1.0",
    });

    expect(agents[0]).toBe("XerjDocsBot/1.0");
  });
});
