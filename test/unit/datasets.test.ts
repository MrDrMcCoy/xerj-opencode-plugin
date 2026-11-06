import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatasetService, actionOf, hitsOf, isManaged } from "../../src/datasets/service.ts";
import type { XerjClient } from "../../src/node/client.ts";

const scratch: string[] = [];
afterAll(async () => {
  for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true });
});

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

async function directory(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "xerj-dataset-"));
  scratch.push(created);
  return created;
}

interface FakeClient {
  readonly created: Array<{ index: string; mapping: unknown }>;
  readonly deleted: string[];
  readonly bulks: Array<{ index: string; ids: string[]; docs: Array<Record<string, unknown>> }>;
  readonly searches: Array<Record<string, unknown>>;
}

function client(pages: ReadonlyArray<ReadonlyArray<{ id: string; source: Record<string, unknown> }>> = []): {
  fake: FakeClient;
  client: XerjClient;
} {
  const fake: FakeClient = { created: [], deleted: [], bulks: [], searches: [] };
  let page = 0;

  const stub = {
    indices: async () => [
      { index: "xop-project-1234-docs", docs: 10, bytes: 1000 },
      { index: "my-notes", docs: 2, bytes: 100 },
    ],
    deleteIndex: async (index: string) => void fake.deleted.push(index),
    put: async (path: string, body: { mappings?: unknown }) => {
      fake.created.push({
        index: path.replace(/^\//, ""),
        mapping: body.mappings ?? null,
      });
    },
    mappings: async () => ({ "my-notes": { properties: { body: { type: "text" } } } }),
    search: async (_index: string, body: unknown) => {
      fake.searches.push(body as Record<string, unknown>);
      const hits = pages[page] ?? [];
      page += 1;
      return {
        hits: {
          total: { value: pages.flat().length, relation: "eq" },
          hits: hits.map((hit) => ({ _id: hit.id, _source: hit.source })),
        },
      };
    },
    bulk: async (
      index: string,
      actions: ReadonlyArray<{ id: string; source: Record<string, unknown> }>,
    ) => {
      fake.bulks.push({
        index,
        ids: actions.map((action) => action.id),
        docs: actions.map((action) => action.source),
      });
    },
  } as unknown as XerjClient;

  return { fake, client: stub };
}

describe("DatasetService listing", () => {
  test("marks the plugin's own corpora as managed", async () => {
    const service = new DatasetService(client().client, logger);
    const rows = await service.list();

    expect(rows.map((row) => `${row.index}:${row.managed}`)).toEqual([
      "my-notes:false",
      "xop-project-1234-docs:true",
    ]);
  });

  test("describe returns the mapping and the counts", async () => {
    const service = new DatasetService(client().client, logger);
    const described = await service.describe("my-notes");

    expect(described.info?.docs).toBe(2);
    expect(described.mapping).toEqual({ properties: { body: { type: "text" } } });
  });

  test("describe of a missing index has no info", async () => {
    const service = new DatasetService(client().client, logger);
    const described = await service.describe("absent");

    expect(described.info).toBeNull();
  });
});

describe("DatasetService create and remove", () => {
  test("creating a new index passes the mapping", async () => {
    const { fake, client: stub } = client();
    const service = new DatasetService(stub, logger);

    const result = await service.create("fresh", { properties: { body: { type: "text" } } });

    expect(result).toEqual({ created: true, existed: false });
    expect(fake.created).toEqual([
      { index: "fresh", mapping: { properties: { body: { type: "text" } } } },
    ]);
  });

  test("creating an existing index does nothing", async () => {
    const { fake, client: stub } = client();
    const service = new DatasetService(stub, logger);

    const result = await service.create("my-notes");

    expect(result).toEqual({ created: false, existed: true });
    expect(fake.created).toEqual([]);
  });

  test("an empty or illegal name is refused", async () => {
    const service = new DatasetService(client().client, logger);
    await expect(service.create("  ")).rejects.toThrow(/required/);
    await expect(service.create("bad name")).rejects.toThrow(/invalid/);
  });

  test("deleting a plugin corpus needs force", async () => {
    const { fake, client: stub } = client();
    const service = new DatasetService(stub, logger);

    const refused = await service.remove("xop-project-1234-docs");
    expect(refused.deleted).toBe(false);
    expect(refused.reason).toContain("force");
    expect(fake.deleted).toEqual([]);

    const forced = await service.remove("xop-project-1234-docs", true);
    expect(forced.deleted).toBe(true);
    expect(fake.deleted).toEqual(["xop-project-1234-docs"]);
  });

  test("deleting an absent index says so", async () => {
    const service = new DatasetService(client().client, logger);
    const result = await service.remove("absent");

    expect(result.deleted).toBe(false);
    expect(result.reason).toContain("does not exist");
  });

  test("a user dataset deletes without force", async () => {
    const { fake, client: stub } = client();
    const service = new DatasetService(stub, logger);

    const result = await service.remove("my-notes");

    expect(result.deleted).toBe(true);
    expect(fake.deleted).toEqual(["my-notes"]);
  });
});

describe("DatasetService export", () => {
  test("writes action and source lines for every document", async () => {
    const page = [
      { id: "a", source: { body: "one" } },
      { id: "b", source: { body: "two" } },
    ];
    const { fake, client: stub } = client([page]);
    const service = new DatasetService(stub, logger);
    const dir = await directory();
    const path = join(dir, "dump.ndjson");

    const summary = await service.exportIndex({ index: "my-notes", path, pageSize: 10 });

    expect(summary.docs).toBe(2);
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      index: { _index: "my-notes", _id: "a" },
    });
    expect(JSON.parse(lines[1] ?? "{}")).toEqual({ body: "one" });
    expect(fake.searches[0]?.from).toBe(0);
  });

  test("pages until a short page arrives", async () => {
    const { fake, client: stub } = client([
      [{ id: "1", source: { body: "a" } }, { id: "2", source: { body: "b" } }],
      [{ id: "3", source: { body: "c" } }],
    ]);
    const service = new DatasetService(stub, logger);
    const dir = await directory();

    const summary = await service.exportIndex({
      index: "my-notes",
      path: join(dir, "dump.ndjson"),
      pageSize: 2,
    });

    expect(summary.docs).toBe(3);
    expect(fake.searches.map((body) => body.from)).toEqual([0, 2]);
  });
});

describe("DatasetService import", () => {
  test("loads a standard dump and creates the index it names", async () => {
    const { fake, client: stub } = client();
    const service = new DatasetService(stub, logger);
    const dir = await directory();
    const path = join(dir, "dump.ndjson");
    await writeFile(
      path,
      [
        '{"index":{"_index":"imported","_id":"1"}}',
        '{"body":"first"}',
        '{"index":{"_index":"imported","_id":"2"}}',
        '{"body":"second"}',
        "",
      ].join("\n"),
    );

    const summary = await service.importDump({ path });

    expect(summary).toMatchObject({ index: "imported", docs: 2, batches: 1, skipped: 0 });
    expect(fake.created[0]?.index).toBe("imported");
    expect(fake.bulks[0]?.ids).toEqual(["1", "2"]);
  });

  test("a target index overrides the dump's own name", async () => {
    const { fake, client: stub } = client();
    const service = new DatasetService(stub, logger);
    const dir = await directory();
    const path = join(dir, "dump.ndjson");
    await writeFile(
      path,
      '{"index":{"_index":"original","_id":"1"}}\n{"body":"x"}\n',
    );

    const summary = await service.importDump({ path, index: "target" });

    expect(summary.index).toBe("target");
    expect(fake.bulks[0]?.index).toBe("target");
  });

  test("documents are written in batches", async () => {
    const { fake, client: stub } = client();
    const service = new DatasetService(stub, logger);
    const dir = await directory();
    const path = join(dir, "dump.ndjson");
    const lines: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      lines.push(`{"index":{"_index":"batched","_id":"${index}"}}`, `{"body":"${index}"}`);
    }
    await writeFile(path, `${lines.join("\n")}\n`);

    const summary = await service.importDump({ path, batchSize: 2 });

    expect(summary.docs).toBe(5);
    expect(summary.batches).toBe(3);
    expect(fake.bulks.map((bulk) => bulk.ids.length)).toEqual([2, 2, 1]);
  });

  test("a dump without ids gets stable ones", async () => {
    const { fake, client: stub } = client();
    const service = new DatasetService(stub, logger);
    const dir = await directory();
    const path = join(dir, "dump.ndjson");
    await writeFile(path, '{"index":{"_index":"noids"}}\n{"body":"x"}\n');

    await service.importDump({ path });

    expect(fake.bulks[0]?.ids).toEqual(["doc-0"]);
  });

  test("malformed lines are counted and skipped", async () => {
    const { fake, client: stub } = client();
    const service = new DatasetService(stub, logger);
    const dir = await directory();
    const path = join(dir, "dump.ndjson");
    await writeFile(
      path,
      [
        "not json",
        '{"index":{"_index":"mixed","_id":"1"}}',
        '{"body":"ok"}',
        '{"index":{"_index":"mixed","_id":"2"}}',
        "also broken",
        "",
      ].join("\n"),
    );

    const summary = await service.importDump({ path });

    expect(summary.docs).toBe(1);
    expect(summary.skipped).toBeGreaterThanOrEqual(2);
    expect(fake.bulks[0]?.ids).toEqual(["1"]);
  });

  test("an empty dump is an error", async () => {
    const service = new DatasetService(client().client, logger);
    const dir = await directory();
    const path = join(dir, "empty.ndjson");
    await writeFile(path, "");

    await expect(service.importDump({ path })).rejects.toThrow(/no documents/);
  });

  test("an explicit mapping is used when the index is created", async () => {
    const { fake, client: stub } = client();
    const service = new DatasetService(stub, logger);
    const dir = await directory();
    const path = join(dir, "dump.ndjson");
    await writeFile(path, '{"index":{"_index":"mapped","_id":"1"}}\n{"body":"x"}\n');

    await service.importDump({
      path,
      mapping: { properties: { body: { type: "text" } } },
    });

    expect(fake.created[0]?.mapping).toEqual({ properties: { body: { type: "text" } } });
  });
});

describe("dump helpers", () => {
  test("managed prefixes cover the plugin's corpora and the engine's", () => {
    expect(isManaged("xop-project-docs")).toBe(true);
    expect(isManaged(".xerj-memory-user")).toBe(true);
    expect(isManaged(".xerj_prefs")).toBe(true);
    expect(isManaged("my-notes")).toBe(false);
  });

  test("actionOf recognizes index and create lines only", () => {
    expect(actionOf({ index: { _index: "a" } })).toEqual({ index: { _index: "a" } });
    expect(actionOf({ create: { _index: "a" } })).toEqual({ create: { _index: "a" } });
    expect(actionOf({ body: "text" })).toBeNull();
    expect(actionOf({ delete: { _id: "x" } })).toBeNull();
  });

  test("hitsOf tolerates a body without hits", () => {
    expect(hitsOf({})).toEqual([]);
    expect(hitsOf({ hits: { hits: [{ _id: "1", _source: { a: 1 } }] } })).toEqual([
      { id: "1", source: { a: 1 } },
    ]);
    expect(hitsOf({ hits: { hits: [{ _id: "1" }] } })).toEqual([]);
  });
});
