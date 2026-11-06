import { describe, expect, test } from "bun:test";
import { DocsDiscovery, pickOfficial } from "../../src/prjdocs/discover.ts";
import {
  PageJudge,
  parseAnswer,
  projectTerms,
  promptFor,
} from "../../src/prjdocs/relevance.ts";

const logger = { debug: () => {} };

function judge(
  generate: ((prompt: string) => Promise<string>) | undefined,
  maxModelCalls = 10,
): PageJudge {
  return new PageJudge(
    { tech: "react", version: "latest", terms: ["component", "props"] },
    { generate, maxModelCalls, logger },
  );
}

const text = "React components accept props and return elements. ".repeat(10);

describe("PageJudge heuristic", () => {
  test("keeps a page that names the technology", async () => {
    const verdict = await judge(undefined).judge(
      "https://example.test/reference/react",
      "React reference",
      text,
    );

    expect(verdict.relevant).toBe(true);
    expect(verdict.byModel).toBe(false);
  });

  test("keeps a documentation path that does not repeat the name", async () => {
    const verdict = await judge(undefined).judge(
      "https://example.test/docs/api/hooks",
      "Hooks",
      "Hooks let a component read state. ".repeat(20),
    );

    expect(verdict.relevant).toBe(true);
  });

  test("drops a page with no technology, no docs path, and few terms", async () => {
    const verdict = await judge(undefined).judge(
      "https://example.test/about",
      "Our team",
      "We build things for people around the world. ".repeat(10),
    );

    expect(verdict.relevant).toBe(false);
    expect(verdict.reason).toContain("no technology");
  });

  test("drops site chrome by path", async () => {
    const verdict = await judge(undefined).judge(
      "https://example.test/pricing",
      "React pricing",
      text,
    );

    expect(verdict.relevant).toBe(false);
  });
});

describe("PageJudge with a model", () => {
  test("a model answer wins over the heuristic", async () => {
    const verdict = await judge(async () => "no").judge(
      "https://example.test/docs/api/hooks",
      "Hooks",
      text,
    );

    expect(verdict.relevant).toBe(false);
    expect(verdict.byModel).toBe(true);
  });

  test("a model that fails falls back to the heuristic", async () => {
    const verdict = await judge(async () => {
      throw new Error("no model");
    }).judge("https://example.test/docs/api/hooks", "Hooks", text);

    expect(verdict.relevant).toBe(true);
    expect(verdict.byModel).toBe(false);
  });

  test("an unusable answer falls back to the heuristic", async () => {
    const verdict = await judge(async () => "maybe?").judge(
      "https://example.test/docs/api/hooks",
      "Hooks",
      text,
    );

    expect(verdict.byModel).toBe(false);
  });

  test("the same page is judged once", async () => {
    let calls = 0;
    const pageJudge = judge(async () => {
      calls += 1;
      return "yes";
    });

    await pageJudge.judge("https://example.test/a", "a", text);
    await pageJudge.judge("https://example.test/a", "a", text);

    expect(calls).toBe(1);
  });

  test("the model call budget is a hard cap", async () => {
    let calls = 0;
    const pageJudge = judge(async () => {
      calls += 1;
      return "yes";
    }, 2);

    for (const path of ["a", "b", "c", "d"]) {
      await pageJudge.judge(`https://example.test/${path}`, path, text);
    }

    expect(calls).toBe(2);
    expect(pageJudge.exhausted).toBe(true);
  });
});

describe("promptFor and parseAnswer", () => {
  test("the prompt names the technology and asks for one word", () => {
    const prompt = promptFor(
      { tech: "react", version: "18", terms: [] },
      "https://example.test/x",
      "Title",
      text,
    );

    expect(prompt).toContain("react");
    expect(prompt).toContain("one word");
    expect(prompt).toContain("https://example.test/x");
  });

  test("answers are read leniently but only yes and no count", () => {
    expect(parseAnswer("Yes.")).toBe(true);
    expect(parseAnswer("NO")).toBe(false);
    expect(parseAnswer("  true  ")).toBe(true);
    expect(parseAnswer("probably")).toBeNull();
    expect(parseAnswer("")).toBeNull();
  });
});

describe("projectTerms", () => {
  test("ranks repeated words and drops filler and short tokens", () => {
    const terms = projectTerms([
      "the component props are typed",
      "component props validation",
      "with that this",
    ]);

    expect(terms.slice(0, 2)).toEqual(["component", "props"]);
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("this");
  });
});

describe("docs discovery through search", () => {
  const quiet = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    entries: async () => [],
    flush: async () => {},
  };

  test("prefers a documentation host over a generic page", () => {
    const url = pickOfficial("acme-sdk", [
      { url: "https://blog.example.test/acme-sdk-intro", title: "acme-sdk intro" },
      { url: "https://docs.acme.test/reference", title: "acme-sdk reference" },
    ]);

    expect(url).toBe("https://docs.acme.test/reference");
  });

  test("rejects aggregators and unrelated results", () => {
    expect(
      pickOfficial("acme-sdk", [
        { url: "https://medium.com/x/acme-sdk", title: "acme-sdk" },
        { url: "https://example.test/other", title: "something else" },
      ]),
    ).toBeNull();
  });

  test("a discovered URL is cached and reused without another query", async () => {
    let queries = 0;
    const search = {
      query: async () => {
        queries += 1;
        return {
          data: {
            results: [{ url: "https://docs.acme.test/", title: "acme-sdk docs" }],
          },
        } as never;
      },
    };

    const discovery = new DocsDiscovery(
      { search, stateDir: "/tmp", logger: quiet },
      {},
    );

    expect(await discovery.find("acme-sdk")).toBe("https://docs.acme.test/");
    expect(await discovery.find("acme-sdk")).toBe("https://docs.acme.test/");
    expect(queries).toBe(1);
    expect(discovery.snapshot()).toEqual({ "acme-sdk": "https://docs.acme.test/" });
  });

  test("no search surface means nothing is discovered", async () => {
    const discovery = new DocsDiscovery(
      { search: undefined, stateDir: "/tmp", logger: quiet },
      {},
    );

    expect(await discovery.find("acme-sdk")).toBeNull();
  });

  test("the query budget stops a long tail of unknown technologies", async () => {
    let queries = 0;
    const search = {
      query: async () => {
        queries += 1;
        return { data: { results: [] } } as never;
      },
    };
    const discovery = new DocsDiscovery(
      { search, stateDir: "/tmp", logger: quiet, maxQueries: 2 },
      {},
    );

    await discovery.find("a-one");
    await discovery.find("b-two");
    await discovery.find("c-three");

    expect(queries).toBe(2);
  });
});

describe("hyphenated technology names", () => {
  test("prose spelling of a hyphenated name still counts", async () => {
    const pageJudge = new PageJudge(
      { tech: "solid-js", version: "latest", terms: [] },
      { logger: { debug: () => {} } },
    );

    const verdict = await pageJudge.judge(
      "https://docs.example.test/",
      "SolidJS Documentation",
      "SolidJS is a reactive library. ".repeat(10),
    );

    expect(verdict.relevant).toBe(true);
  });
});
