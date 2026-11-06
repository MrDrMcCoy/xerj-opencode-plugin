import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrjdocsIndexer } from "../../src/prjdocs/index.ts";

const root = await mkdtemp(join(tmpdir(), "xerj-prjdocs-"));
afterAll(async () => rm(root, { recursive: true, force: true }));

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

const longBody =
  "This page documents the behaviour in enough detail that it is indexed. ".repeat(6);

function html(title: string, links: string[] = []): string {
  const anchors = links.map((href) => `<a href="${href}">n</a>`).join("");
  return `<html><head><title>${title}</title></head><body><h1>${title}</h1>
    <p>${longBody}</p>${anchors}</body></html>`;
}

interface FakeClient {
  bulks: Array<{ index: string; ids: string[]; sources: Array<Record<string, unknown>> }>;
  deletes: Array<{ index: string; ids: string[] }>;
  puts: string[];
}

function client(): FakeClient {
  const fake: FakeClient = { bulks: [], deletes: [], puts: [] };
  return Object.assign(fake, {
    bulk: async (
      index: string,
      actions: ReadonlyArray<{ id: string; source: Record<string, unknown> }>,
    ) => {
      fake.bulks.push({
        index,
        ids: actions.map((action) => action.id),
        sources: actions.map((action) => action.source),
      });
    },
    bulkDelete: async (index: string, ids: ReadonlyArray<string>) => {
      fake.deletes.push({ index, ids: [...ids] });
    },
    put: async (path: string) => void fake.puts.push(path),
    indices: async () => [],
    deleteIndex: async () => {},
  });
}

/** A documentation site whose pages are all reachable from the entry. */
function site(pages: ReadonlyArray<string>): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    const page = pages.find((candidate) => url.endsWith(candidate));
    if (page === undefined) {
      return new Response("missing", { status: 404 });
    }
    return new Response(html(page, pages.filter((other) => other !== page)), {
      headers: { "content-type": "text/html" },
    });
  }) as unknown as typeof fetch;
}

async function projectWith(dependencies: Record<string, string>): Promise<string> {
  const project = await mkdtemp(join(root, "project-"));
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({ dependencies, devDependencies: {} }),
  );
  return project;
}

function makeIndexer(
  project: string,
  state: string,
  fake: FakeClient,
  fetchImpl: typeof fetch,
): PrjdocsIndexer {
  return new PrjdocsIndexer({
    client: fake as never,
    prefix: "xop-prjdoc-test",
    projectRoot: project,
    stateDir: state,
    logger,
    fetchImpl,
    maxTargets: 1,
  });
}

describe("PrjdocsIndexer", () => {
  test("indexes a detected technology's docs, then skips them unchanged", async () => {
    const project = await projectWith({ react: "^18.2.0" });
    const state = await mkdtemp(join(root, "state-"));
    const fake = client();
    const indexer = makeIndexer(
      project,
      state,
      fake,
      site(["/reference/react", "/reference/react-dom"]),
    );

    const first = await indexer.run();

    expect(first.techs).toContain("react@18.2.0");
    expect(first.targets).toBe(1);
    expect(first.indexed).toBe(2);
    expect(first.skipped).toBe(0);
    expect(first.pruned).toBe(0);
    expect(fake.puts).toHaveLength(1);
    expect(fake.bulks[0]?.index).toBe("xop-prjdoc-test-docs");
    // Each document says which technology and version it came from.
    expect(fake.bulks[0]?.sources[0]?.tech).toBe("react");
    expect(fake.bulks[0]?.sources[0]?.version).toBe("latest");

    const second = await indexer.run();

    expect(second.indexed).toBe(0);
    expect(second.skipped).toBe(2);
    expect(fake.bulks).toHaveLength(1);
  });

  test("prunes every page when the technology leaves the project", async () => {
    const project = await projectWith({ react: "^18.2.0" });
    const state = await mkdtemp(join(root, "state-"));
    const fake = client();
    const pages = ["/reference/react"];

    await makeIndexer(project, state, fake, site(pages)).run();
    expect(fake.bulks).toHaveLength(1);

    // The dependency is gone, so nothing is crawled and the old pages go.
    await writeFile(join(project, "package.json"), JSON.stringify({ dependencies: {} }));
    const after = await makeIndexer(project, state, fake, site(pages)).run();

    expect(after.targets).toBe(0);
    expect(after.pruned).toBe(1);
    expect(fake.deletes[0]?.ids).toHaveLength(1);
  });

  test("reports a technology with no documentation source", async () => {
    const project = await projectWith({ "left-pad-exotic": "1.0.0" });
    const state = await mkdtemp(join(root, "state-"));
    const fake = client();

    const summary = await makeIndexer(project, state, fake, site([])).run();

    // Not a known framework or cloud API, so detection does not claim it.
    expect(summary.techs).toEqual([]);
    expect(summary.unsupported).toEqual([]);
  });

  test("a crawl that returns nothing is counted as a failure, not a crash", async () => {
    const project = await projectWith({ react: "^18.2.0" });
    const state = await mkdtemp(join(root, "state-"));
    const fake = client();
    const broken = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    const summary = await makeIndexer(project, state, fake, broken).run();

    expect(summary.targets).toBe(1);
    expect(summary.indexed).toBe(0);
    expect(summary.failed).toBe(1);
  });
});

describe("version pruning", () => {
  /** Serves Node docs for either major version, with one page each. */
  function nodeDocs(): typeof fetch {
    return (async (input: string | URL) => {
      const url = String(input);
      const major = /latest-v(\d+)\.x/.exec(url)?.[1] ?? "unknown";
      return new Response(html(`Node ${major} API`), {
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;
  }

  async function projectOnNode(version: string): Promise<string> {
    const project = await mkdtemp(join(root, "node-project-"));
    await writeFile(join(project, ".nvmrc"), `${version}\n`);
    return project;
  }

  test("indexes the used and latest versions, then prunes the old one", async () => {
    const state = await mkdtemp(join(root, "state-"));
    const fake = client();

    const project20 = await projectOnNode("20.11.1");
    const first = new PrjdocsIndexer({
      client: fake as never,
      prefix: "xop-prjdoc-version",
      projectRoot: project20,
      stateDir: state,
      logger,
      fetchImpl: nodeDocs(),
      latestVersion: async () => "22.1.0",
      maxTargets: 1,
    });

    const run1 = await first.run();
    expect(run1.targets).toBe(2);
    expect(run1.indexed).toBe(2);
    expect(fake.bulks.flatMap((entry) => entry.sources.map((source) => source.version)).sort())
      .toEqual(["20", "22"]);

    // The project moves to Node 22: the 20 pages no longer belong.
    await writeFile(join(project20, ".nvmrc"), "22.1.0\n");
    const run2 = await first.run();

    expect(run2.targets).toBe(1);
    expect(run2.pruned).toBe(1);
    expect(fake.deletes.at(-1)?.ids).toHaveLength(1);
  });
});

describe("eager mode", () => {
  /** A site with a deep chain plus one page the judge should reject. */
  function chainSite(): typeof fetch {
    return (async (input: string | URL) => {
      const url = String(input);
      const depth = Number(/\/l(\d+)/.exec(url)?.[1] ?? 0);
      const links = depth < 4 ? [`/l${depth + 1}`] : [];
      if (url.includes("/noise")) {
        return new Response(html("Team page", []), {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response(html(`React level ${depth}`, links), {
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;
  }

  test("crawls deeper than the default and keeps judged pages only", async () => {
    const project = await projectWith({ react: "^18.2.0" });
    const state = await mkdtemp(join(root, "state-"));
    const fake = client();
    const indexer = new PrjdocsIndexer({
      client: fake as never,
      prefix: "xop-prjdoc-eager",
      projectRoot: project,
      stateDir: state,
      logger,
      fetchImpl: chainSite(),
      eager: { maxPages: 20, maxDepth: 8 },
      maxTargets: 1,
    });

    const summary = await indexer.run();

    // The entry page plus four levels of links, past the default depth of two.
    expect(summary.indexed).toBe(5);
  });

  test("an unknown technology is discovered through search", async () => {
    const project = await projectWith({ "acme-sdk": "^2.0.0" });
    const state = await mkdtemp(join(root, "state-"));
    const fake = client();
    const searched: string[] = [];
    const indexer = new PrjdocsIndexer({
      client: fake as never,
      prefix: "xop-prjdoc-eager",
      projectRoot: project,
      stateDir: state,
      logger,
      // Every page the discovery points at names the technology, so the
      // heuristic judge keeps it.
      fetchImpl: (async () =>
        new Response(html("acme-sdk documentation"), {
          headers: { "content-type": "text/html" },
        })) as unknown as typeof fetch,
      maxTargets: 1,
      eager: {
        maxPages: 5,
        maxDepth: 3,
        search: {
          query: async ({ query }) => {
            searched.push(query);
            return {
              data: { results: [{ url: "https://docs.acme.test/", title: "acme-sdk" }] },
            } as never;
          },
        },
      },
    });

    const summary = await indexer.run();

    expect(searched).toEqual(["acme-sdk official documentation"]);
    expect(summary.targets).toBe(1);
    expect(summary.unsupported).toEqual([]);
    expect(fake.bulks.length).toBeGreaterThan(0);
  });

  test("without a search surface an unknown technology stays unsupported", async () => {
    const project = await projectWith({ "other-sdk": "^1.0.0" });
    const state = await mkdtemp(join(root, "state-"));
    const fake = client();
    const indexer = new PrjdocsIndexer({
      client: fake as never,
      prefix: "xop-prjdoc-eager",
      projectRoot: project,
      stateDir: state,
      logger,
      fetchImpl: site(["/"]),
      maxTargets: 1,
      // `acme-sdk` is not a known framework id either, so detection skips it;
      // `react` is known, so this proves the path where search is absent.
      eager: { maxPages: 3, maxDepth: 2 },
    });

    const summary = await indexer.run();
    expect(summary.targets).toBe(0);
  });
});

describe("project docs failures", () => {
  test("a failed bulk write counts as a failure and keeps the old manifest", async () => {
    const project = await projectWith({ react: "^18.2.0" });
    const state = await mkdtemp(join(root, "state-"));
    const fake = client();
    const failing = {
      ...fake,
      bulk: async () => {
        throw new Error("node refused the write");
      },
    };

    const warnings: string[] = [];
    const summary = await new PrjdocsIndexer({
      client: failing as never,
      prefix: "xop-prjdoc-test",
      projectRoot: project,
      stateDir: state,
      logger: { ...logger, warn: (message: string) => void warnings.push(message) },
      fetchImpl: site(["/reference/react"]),
      maxTargets: 1,
    }).run();

    expect(summary.indexed).toBe(0);
    expect(summary.failed).toBeGreaterThan(0);
    expect(warnings).toContain("could not index project docs");
  });

  test("an unwritable state directory does not fail the run", async () => {
    const project = await projectWith({ react: "^18.2.0" });
    const state = join(root, "not-a-directory");
    await writeFile(state, "a file, not a directory");

    const summary = await new PrjdocsIndexer({
      client: client() as never,
      prefix: "xop-prjdoc-test",
      projectRoot: project,
      stateDir: state,
      logger,
      fetchImpl: site(["/reference/react"]),
      maxTargets: 1,
    }).run();

    expect(summary.indexed).toBe(1);
  });

  test("a page that changes is indexed again", async () => {
    const project = await projectWith({ react: "^18.2.0" });
    const state = await mkdtemp(join(root, "state-"));
    const fake = client();
    let body = longBody;

    const fetchImpl = (async () =>
      new Response(
        `<html><head><title>React reference</title></head><body><p>${body}</p></body></html>`,
        { headers: { "content-type": "text/html" } },
      )) as unknown as typeof fetch;

    const first = await new PrjdocsIndexer({
      client: fake as never,
      prefix: "xop-prjdoc-test",
      projectRoot: project,
      stateDir: state,
      logger,
      fetchImpl,
      maxTargets: 1,
    }).run();
    expect(first.indexed).toBe(1);

    body = `${longBody} New paragraph.`;
    const second = await new PrjdocsIndexer({
      client: fake as never,
      prefix: "xop-prjdoc-test",
      projectRoot: project,
      stateDir: state,
      logger,
      fetchImpl,
      maxTargets: 1,
    }).run();

    expect(second.indexed).toBe(1);
    expect(second.skipped).toBe(0);
  });
});

describe("always-on documentation", () => {
  const tree = {
    tree: [
      { type: "blob", path: "docs/README.md" },
      { type: "blob", path: "docs/recipes/agentic-memory.md" },
    ],
  };

  /** Serves the XERJ tree, raw markdown, and an Elasticsearch index page. */
  function builtinFetch(): typeof fetch {
    return (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("api.github.com")) return new Response(JSON.stringify(tree));
      if (url.includes("raw.githubusercontent.com")) {
        return new Response(`# XERJ page\n\n${longBody}`);
      }
      return new Response(
        `<html><head><title>Elasticsearch guide</title></head><body><p>${longBody}</p></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }) as unknown as typeof fetch;
  }

  test("XERJ docs and the Elasticsearch reference are indexed with no project tech", async () => {
    const project = await mkdtemp(join(root, "empty-project-"));
    const state = await mkdtemp(join(root, "state-"));
    const fake = client();

    const summary = await new PrjdocsIndexer({
      client: fake as never,
      prefix: "xop-prjdoc-builtin",
      projectRoot: project,
      stateDir: state,
      logger,
      fetchImpl: builtinFetch(),
      builtin: {
        enabled: true,
        elasticsearchVersion: "8.13.0",
        xerjPages: 10,
        elasticsearchPages: 2,
        refreshDays: 7,
      },
      maxTargets: 1,
    }).run();

    expect(summary.targets).toBe(2);
    expect(summary.indexed).toBeGreaterThanOrEqual(2);
    const sources = fake.bulks.flatMap((bulk) => bulk.sources);
    expect(sources.some((source) => source.tech === "xerj")).toBe(true);
    expect(sources.some((source) => source.tech === "elasticsearch")).toBe(true);
  });

  test("the builtin sources can be switched off", async () => {
    const project = await mkdtemp(join(root, "empty-project-"));
    const state = await mkdtemp(join(root, "state-"));
    const fake = client();

    const summary = await new PrjdocsIndexer({
      client: fake as never,
      prefix: "xop-prjdoc-builtin",
      projectRoot: project,
      stateDir: state,
      logger,
      fetchImpl: builtinFetch(),
      builtin: {
        enabled: false,
        elasticsearchVersion: "8.13.0",
        xerjPages: 10,
        elasticsearchPages: 2,
        refreshDays: 7,
      },
      maxTargets: 1,
    }).run();

    expect(summary.targets).toBe(0);
    expect(fake.bulks).toEqual([]);
  });
});

describe("builtin refresh window", () => {
  const tree = { tree: [{ type: "blob", path: "docs/README.md" }] };

  function countingFetch(counter: { calls: number }): typeof fetch {
    return (async (input: string | URL) => {
      const url = String(input);
      counter.calls += 1;
      if (url.includes("api.github.com")) return new Response(JSON.stringify(tree));
      if (url.includes("raw.githubusercontent.com")) {
        return new Response(`# XERJ page\n\n${longBody}`);
      }
      return new Response(
        `<html><head><title>Elasticsearch guide</title></head><body><p>${longBody}</p></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }) as unknown as typeof fetch;
  }

  function indexer(
    project: string,
    state: string,
    fake: ReturnType<typeof client>,
    fetchImpl: typeof fetch,
    refreshDays: number,
  ): PrjdocsIndexer {
    return new PrjdocsIndexer({
      client: fake as never,
      prefix: "xop-prjdoc-builtin",
      projectRoot: project,
      stateDir: state,
      logger,
      fetchImpl,
      builtin: {
        enabled: true,
        elasticsearchVersion: "8.13.0",
        xerjPages: 5,
        elasticsearchPages: 2,
        refreshDays,
      },
      maxTargets: 1,
    });
  }

  test("a second run inside the window does not fetch or prune", async () => {
    const project = await mkdtemp(join(root, "empty-project-"));
    const state = await mkdtemp(join(root, "state-"));
    const fake = client();
    const counter = { calls: 0 };
    const fetchImpl = countingFetch(counter);

    const first = await indexer(project, state, fake, fetchImpl, 7).run();
    expect(first.indexed).toBeGreaterThan(0);
    const afterFirst = counter.calls;

    const second = await indexer(project, state, fake, fetchImpl, 7).run();

    expect(counter.calls).toBe(afterFirst);
    expect(second.pruned).toBe(0);
    expect(second.indexed).toBe(0);
  });

  test("a zero window always refreshes", async () => {
    const project = await mkdtemp(join(root, "empty-project-"));
    const state = await mkdtemp(join(root, "state-"));
    const fake = client();
    const counter = { calls: 0 };
    const fetchImpl = countingFetch(counter);

    await indexer(project, state, fake, fetchImpl, 0).run();
    const afterFirst = counter.calls;
    await indexer(project, state, fake, fetchImpl, 0).run();

    expect(counter.calls).toBeGreaterThan(afterFirst);
  });

  test("a changed version refreshes even inside the window", async () => {
    const project = await mkdtemp(join(root, "empty-project-"));
    const state = await mkdtemp(join(root, "state-"));
    const fake = client();
    const counter = { calls: 0 };
    const fetchImpl = countingFetch(counter);

    await indexer(project, state, fake, fetchImpl, 7).run();
    const afterFirst = counter.calls;

    // A new wire version means a new docs branch, so the old pages must go.
    await new PrjdocsIndexer({
      client: fake as never,
      prefix: "xop-prjdoc-builtin",
      projectRoot: project,
      stateDir: state,
      logger,
      fetchImpl,
      builtin: {
        enabled: true,
        elasticsearchVersion: "8.19.0",
        xerjPages: 5,
        elasticsearchPages: 2,
        refreshDays: 7,
      },
      maxTargets: 1,
    }).run();

    expect(counter.calls).toBeGreaterThan(afterFirst);
  });
});
