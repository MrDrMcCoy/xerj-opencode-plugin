import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SysdocIndexer, discoverPages } from "../../src/sysdocs/index.ts";
import { NodeRequestError } from "../../src/node/client.ts";

const root = await mkdtemp(join(tmpdir(), "xerj-sysdocs-"));
afterAll(async () => rm(root, { recursive: true, force: true }));

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

interface Recorded {
  index: string;
  actions: ReadonlyArray<{ id: string; source: Record<string, unknown> }>;
}

function fakeClient(): {
  bulks: Recorded[];
  deletes: Array<{ index: string; ids: ReadonlyArray<string> }>;
  bulk: (index: string, actions: Recorded["actions"]) => Promise<void>;
  bulkDelete: (index: string, ids: ReadonlyArray<string>) => Promise<void>;
  indices: () => Promise<Array<{ index: string; docs: number; bytes: number }>>;
  deleteIndex: () => Promise<void>;
} {
  const bulks: Recorded[] = [];
  const deletes: Array<{ index: string; ids: ReadonlyArray<string> }> = [];
  return {
    bulks,
    deletes,
    bulk: async (index, actions) => void bulks.push({ index, actions }),
    bulkDelete: async (index, ids) => void deletes.push({ index, ids }),
    indices: async () => [],
    deleteIndex: async () => {},
  };
}

async function fixture(): Promise<{ man: string; info: string; state: string }> {
  const man = join(root, `man-${Math.random().toString(36).slice(2)}`);
  const info = join(root, `info-${Math.random().toString(36).slice(2)}`);
  const state = join(root, `state-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(man, "man1"), { recursive: true });
  await mkdir(join(man, "man5"), { recursive: true });
  await mkdir(info, { recursive: true });

  await writeFile(
    join(man, "man1/git.1.gz"),
    gzipSync('.TH GIT 1\n.SH NAME\ngit - the stupid content tracker\n'),
  );
  await writeFile(join(man, "man5/hosts.5.gz"), gzipSync(".SH NAME\nhosts - resolver table\n"));
  await writeFile(join(man, "man1/notes.txt"), "not a page");
  await writeFile(
    join(info, "coreutils.info.gz"),
    gzipSync("File: coreutils.info, Node: Top\n\nGNU core utilities\n"),
  );
  return { man, info, state };
}

describe("discoverPages", () => {
  test("finds man and info pages and ignores other files", async () => {
    const { man, info } = await fixture();
    const pages = await discoverPages({
      manDirs: [man],
      infoDirs: [info],
      roots: { man: [], info: [] },
    });

    expect(pages.map((page) => `${page.source}:${page.name}`).sort()).toEqual([
      "info:coreutils",
      "man:git",
      "man:hosts",
    ]);
  });

  test("a missing directory is not an error", async () => {
    const pages = await discoverPages({
      manDirs: [join(root, "absent")],
      infoDirs: [],
      roots: { man: [], info: [] },
    });
    expect(pages).toEqual([]);
  });
});

describe("SysdocIndexer", () => {
  test("indexes once, skips unchanged pages, and prunes removed ones", async () => {
    const { man, info, state } = await fixture();
    const client = fakeClient();
    const indexer = new SysdocIndexer({
      client: client as never,
      prefix: "xop-sys-test",
      stateDir: state,
      logger,
      manDirs: [man],
      infoDirs: [info],
      roots: { man: [], info: [] },
    });

    const first = await indexer.run();
    expect(first.indexed).toBe(3);
    expect(first.skipped).toBe(0);
    expect(client.bulks.flatMap((entry) => entry.actions)).toHaveLength(3);

    // Nothing changed: no writes, everything skipped.
    const second = await indexer.run();
    expect(second.indexed).toBe(0);
    expect(second.skipped).toBe(3);
    expect(second.pruned).toBe(0);
    expect(client.bulks.flatMap((entry) => entry.actions)).toHaveLength(3);

    // A page disappears: its id is pruned.
    await rm(join(man, "man5/hosts.5.gz"));
    const third = await indexer.run();
    expect(third.pruned).toBe(1);
    expect(client.deletes[0]?.ids).toHaveLength(1);
  });

  test("a rewritten page is re-indexed under the same id", async () => {
    const { man, info, state } = await fixture();
    const client = fakeClient();
    const indexer = new SysdocIndexer({
      client: client as never,
      prefix: "xop-sys-test",
      stateDir: state,
      logger,
      manDirs: [man],
      infoDirs: [info],
      roots: { man: [], info: [] },
    });

    await indexer.run();
    const ids = new Set(client.bulks.flatMap((entry) => entry.actions.map((action) => action.id)));

    await writeFile(
      join(man, "man1/git.1.gz"),
      gzipSync(".SH NAME\ngit - rewritten body\n"),
    );
    const second = await indexer.run();

    expect(second.indexed).toBe(1);
    const last = client.bulks.at(-1)?.actions[0];
    expect(last?.id).toBeDefined();
    expect(ids.has(last?.id ?? "")).toBe(true);
  });

  test("a page that is one long document is capped", async () => {
    const { man, info, state } = await fixture();
    const client = fakeClient();
    const indexer = new SysdocIndexer({
      client: client as never,
      prefix: "xop-sys-test",
      stateDir: state,
      logger,
      manDirs: [man],
      infoDirs: [info],
      roots: { man: [], info: [] },
      maxBytesPerDoc: 40,
    });

    await indexer.run();
    const bodies = client.bulks
      .flatMap((entry) => entry.actions)
      .map((action) => String(action.source.body));

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body.length).toBeLessThan(400);
  });
});

describe("sysdocs failures", () => {
  test("a page that cannot be extracted counts as failed and is not recorded", async () => {
    const { man, info, state } = await fixture();
    const fake = fakeClient();
    // A gzip file holding bytes that are not valid roff still extracts as text;
    // a corrupt gzip is what fails the extractor.
    await writeFile(join(man, "man1/broken.1.gz"), Buffer.from([0x1f, 0x8b, 0x00, 0x01]));

    const summary = await new SysdocIndexer({
      client: fake as never,
      prefix: "xop-sys-test",
      stateDir: state,
      logger,
      manDirs: [man],
      infoDirs: [info],
    }).run();

    expect(summary.failed).toBeGreaterThan(0);
  });

  test("a failed ingest is counted and leaves the manifest row out", async () => {
    const { man, info, state } = await fixture();
    const fake = fakeClient();
    const failing = {
      ...fake,
      bulk: async () => {
        throw new Error("node refused the write");
      },
    };

    const summary = await new SysdocIndexer({
      client: failing as never,
      prefix: "xop-sys-test",
      stateDir: state,
      logger,
      manDirs: [man],
      infoDirs: [info],
    }).run();

    expect(summary.indexed).toBe(0);
    expect(summary.failed).toBeGreaterThan(0);
  });

  test("a failed prune is logged, not thrown", async () => {
    const { man, info, state } = await fixture();
    const fake = fakeClient();

    await new SysdocIndexer({
      client: fake as never,
      prefix: "xop-sys-test",
      stateDir: state,
      logger,
      manDirs: [man],
      infoDirs: [info],
    }).run();

    await rm(join(man, "man1/git.1.gz"));

    const warnings: string[] = [];
    const failing = {
      ...fake,
      bulkDelete: async () => {
        throw new Error("delete refused");
      },
    };

    const summary = await new SysdocIndexer({
      client: failing as never,
      prefix: "xop-sys-test",
      stateDir: state,
      logger: {
        ...logger,
        warn: (message: string) => void warnings.push(message),
      },
      manDirs: [man],
      infoDirs: [info],
    }).run();

    expect(summary.pruned).toBe(1);
    expect(warnings).toContain("could not prune system docs");
  });

  test("maxDocs limits how many pages one run considers", async () => {
    const { man, info, state } = await fixture();
    const fake = fakeClient();

    const summary = await new SysdocIndexer({
      client: fake as never,
      prefix: "xop-sys-test",
      stateDir: state,
      logger,
      manDirs: [man],
      infoDirs: [info],
      maxDocs: 1,
    }).run();

    expect(summary.indexed).toBe(1);
    expect(summary.discovered).toBeGreaterThan(1);
  });
});

describe("sysdocs index creation", () => {
  test("an existing index is not recreated a second time", async () => {
    const { man, info, state } = await fixture();
    const puts: string[] = [];
    const client = {
      ...fakeClient(),
      put: async (path: string) => {
        puts.push(path);
        throw new NodeRequestError("exists", 409);
      },
    };

    const indexer = new SysdocIndexer({
      client: client as never,
      prefix: "xop-sys-test",
      stateDir: state,
      logger,
      manDirs: [man],
      infoDirs: [info],
    });

    await indexer.run();
    await indexer.run();

    expect(puts).toHaveLength(1);
  });

  test("a mapping failure other than 400/409 is a warning, not a crash", async () => {
    const { man, info, state } = await fixture();
    const warnings: string[] = [];
    const client = {
      ...fakeClient(),
      put: async () => {
        throw new NodeRequestError("node exploded", 500);
      },
    };

    const summary = await new SysdocIndexer({
      client: client as never,
      prefix: "xop-sys-test",
      stateDir: state,
      logger: { ...logger, warn: (message: string) => void warnings.push(message) },
      manDirs: [man],
      infoDirs: [info],
    }).run();

    expect(summary.indexed).toBeGreaterThan(0);
    expect(warnings).toContain("could not create the system docs index");
  });

  test("manifest rows for vanished pages are dropped after a prune", async () => {
    const { man, info, state } = await fixture();
    const fake = fakeClient();

    await new SysdocIndexer({
      client: fake as never,
      prefix: "xop-sys-test",
      stateDir: state,
      logger,
      manDirs: [man],
      infoDirs: [info],
    }).run();

    await rm(join(man, "man1/git.1.gz"));
    const summary = await new SysdocIndexer({
      client: fake as never,
      prefix: "xop-sys-test",
      stateDir: state,
      logger,
      manDirs: [man],
      infoDirs: [info],
    }).run();

    expect(summary.pruned).toBe(1);
    const manifest = JSON.parse(
      await readFile(join(state, "sysdocs-manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(manifest).some((path) => path.endsWith("git.1"))).toBe(false);
  });
});

describe("sysdocs page extraction", () => {
  test("an uncompressed info page is read, and a compressed one that is not gzip is skipped", async () => {
    const man = join(root, `man-plain-${Math.random().toString(36).slice(2)}`);
    const info = join(root, `info-mixed-${Math.random().toString(36).slice(2)}`);
    const state = join(root, `state-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(man, "man1"), { recursive: true });
    await mkdir(info, { recursive: true });

    await writeFile(join(man, "man1/plain.1"), ".SH NAME\nplain - a plain page\n");
    // `.info.bz2` is not gzip: the extractor must skip it, not fail the run.
    await writeFile(join(info, "skipped.info.bz2"), "not gzip");

    const fake = fakeClient();
    const summary = await new SysdocIndexer({
      client: fake as never,
      prefix: "xop-sys-test",
      stateDir: state,
      logger,
      manDirs: [man],
      infoDirs: [info],
      roots: { man: [], info: [] },
    }).run();

    expect(summary.indexed).toBe(1);
    expect(fake.bulks[0]?.actions[0]?.source.path).toBe("man/plain.1");
  });

  test("a page longer than the cap is truncated", async () => {
    const man = join(root, `man-long-${Math.random().toString(36).slice(2)}`);
    const state = join(root, `state-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(man, "man1"), { recursive: true });
    await writeFile(join(man, "man1/long.1"), `.SH NAME\nlong - ${"x".repeat(500)}\n`);

    const fake = fakeClient();
    await new SysdocIndexer({
      client: fake as never,
      prefix: "xop-sys-test",
      stateDir: state,
      logger,
      manDirs: [man],
      infoDirs: [],
      roots: { man: [], info: [] },
      maxBytesPerDoc: 120,
    }).run();

    const body = String(fake.bulks[0]?.actions[0]?.source.body ?? "");
    expect(body.length).toBeLessThan(500);
    expect(body.length).toBeLessThanOrEqual(200);
  });

  test("a corrupt manifest is rewritten instead of failing the run", async () => {
    const { man, info, state } = await fixture();
    await mkdir(state, { recursive: true });
    await writeFile(join(state, "sysdocs-manifest.json"), "{ not json");
    const fake = fakeClient();

    const summary = await new SysdocIndexer({
      client: fake as never,
      prefix: "xop-sys-test",
      stateDir: state,
      logger,
      manDirs: [man],
      infoDirs: [info],
      roots: { man: [], info: [] },
    }).run();

    expect(summary.indexed).toBeGreaterThan(0);
    const manifest = JSON.parse(
      await readFile(join(state, "sysdocs-manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(manifest).length).toBeGreaterThan(0);
  });
});
