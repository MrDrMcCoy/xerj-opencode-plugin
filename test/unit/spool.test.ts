import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../../src/log.ts";
import { NodeRequestError, type XerjClient } from "../../src/node/client.ts";
import {
  digest,
  isSecretPath,
  redact,
  RemoteSpool,
  truncate,
} from "../../src/remote/spool.ts";

const root = await mkdtemp(join(tmpdir(), "xerj-spool-"));
afterAll(async () => rm(root, { recursive: true, force: true }));

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

const client = {
  put: async () => {},
  bulk: async () => {},
} as unknown as XerjClient;

function spool(): RemoteSpool {
  return new RemoteSpool({
    root,
    projectRoot: root,
    prefix: "xop-web-test",
    externalPrefix: "xop-ext-test",
    maxBytes: 10_000,
    client,
    logger,
  });
}

describe("redact", () => {
  test("masks bearer tokens and provider keys", () => {
    const text = "Authorization: Bearer abcdef1234567890 and sk-1234567890abcdefghij";
    const masked = redact(text);
    expect(masked).not.toContain("abcdef1234567890");
    expect(masked).not.toContain("1234567890abcdefghij");
    expect(masked).toContain("Bearer [redacted]");
  });

  test("masks credentials in config shapes", () => {
    const text = [
      '{"password": "hunter2hunter2", "api_key": "abcd1234abcd1234"}',
      "token: abcdef1234567890",
      "aws = AKIAABCDEFGHIJKLMNOP",
    ].join("\n");
    const masked = redact(text);

    expect(masked).not.toContain("hunter2hunter2");
    expect(masked).not.toContain("abcd1234abcd1234");
    expect(masked).not.toContain("abcdef1234567890");
    expect(masked).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(masked).toContain("[redacted]");
  });

  test("masks a whole private key block", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----";
    expect(redact(`before\n${key}\nafter`)).toBe(
      "before\n[redacted private key]\nafter",
    );
  });

  test("leaves ordinary prose alone", () => {
    expect(redact("a normal sentence")).toBe("a normal sentence");
  });
});

describe("isSecretPath", () => {
  test("refuses credential files and directories", () => {
    expect(isSecretPath("/data/opencode/service.json")).toBe(true);
    expect(isSecretPath("/home/u/.ssh/id_rsa")).toBe(true);
    expect(isSecretPath("/home/u/.aws/credentials")).toBe(true);
    expect(isSecretPath("/repo/.env.local")).toBe(true);
  });

  test("allows an ordinary source file", () => {
    expect(isSecretPath("/repo/src/index.ts")).toBe(false);
    expect(isSecretPath("/repo/docs/architecture.md")).toBe(false);
  });
});

describe("truncate", () => {
  test("returns short text unchanged", () => {
    expect(truncate("short", 100)).toBe("short");
  });

  test("cuts on a character boundary", () => {
    const text = "é".repeat(100);
    const cut = truncate(text, 51);
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(51);
    expect(cut).not.toContain("\uFFFD");
  });
});

describe("digest", () => {
  test("is stable and url-specific", () => {
    expect(digest("https://example.com")).toBe(digest("https://example.com"));
    expect(digest("https://example.com")).not.toBe(digest("https://example.org"));
  });
});

describe("RemoteSpool.isEmpty", () => {
  test("is true with no page and false once one lands", async () => {
    const spooler = new RemoteSpool({
      root,
      projectRoot: root,
      prefix: "xop-web-empty",
      externalPrefix: "xop-ext-empty",
      maxBytes: 10_000,
      client,
      logger,
    });
    await spooler.init();
    expect(await spooler.isEmpty()).toBe(true);

    await spooler.ingestUrl("https://example.com/page", "some page text");
    expect(await spooler.isEmpty()).toBe(false);
  });
});

describe("RemoteSpool.ingestUrl", () => {
  test("writes a document with source metadata", async () => {
    const store = spool();
    const stored = await store.ingestUrl("https://example.com/page", "Hello page body.");

    expect(stored).not.toBeNull();
    const content = await readFile(stored!.path, "utf8");
    expect(content).toContain("# https://example.com/page");
    expect(content).toContain("Source: https://example.com/page");
    expect(content).toContain("Hello page body.");
  });

  test("replaces the earlier version of the same URL", async () => {
    const store = spool();
    const first = await store.ingestUrl("https://example.com/replace", "first");
    const second = await store.ingestUrl("https://example.com/replace", "second");

    expect(second!.path).toBe(first!.path);
    const content = await readFile(second!.path, "utf8");
    expect(content).toContain("second");
    expect(content).not.toContain("first");
  });

  test("refuses empty content", async () => {
    expect(await spool().ingestUrl("https://example.com/empty", "   ")).toBeNull();
  });

  test("ingests a text file outside the project", async () => {
    const file = join(root, "outside.md");
    await writeFile(file, "# Note\n\nExternal body.");

    const stored = await spool().ingestExternalFile(file);
    expect(stored?.path).toBe("outside.md");
    expect(stored?.bytes).toBeGreaterThan(0);
  });

  test("refuses an unsupported extension", async () => {
    const file = join(root, "blob.exe");
    await writeFile(file, "binary");
    expect(await spool().ingestExternalFile(file)).toBeNull();
  });

  test("refuses secret-shaped files", async () => {
    const file = join(root, ".env");
    await writeFile(file, "TOKEN=abc");
    expect(await spool().ingestExternalFile(file)).toBeNull();
  });

  test("skips re-bulking an unchanged external file", async () => {
    const file = join(root, "cached.md");
    await writeFile(file, "first version");
    let bulks = 0;
    const counting = {
      put: async () => {},
      bulk: async () => void (bulks += 1),
    } as unknown as XerjClient;
    const spooler = new RemoteSpool({
      root,
      projectRoot: root,
      prefix: "xop-web-cache",
      externalPrefix: "xop-ext-cache",
      maxBytes: 10_000,
      client: counting,
      logger,
    });

    expect(await spooler.ingestExternalFile(file, { skipUnchanged: true })).not.toBeNull();
    expect(await spooler.ingestExternalFile(file, { skipUnchanged: true })).toBeNull();
    expect(bulks).toBe(1);
  });

  test("tolerates an external index that already exists", async () => {
    const file = join(root, "existing.md");
    await writeFile(file, "body under an existing index");
    const existing = {
      put: async () => {
        throw new NodeRequestError("exists", 409, "already exists");
      },
      bulk: async () => {},
    } as unknown as XerjClient;
    const spooler = new RemoteSpool({
      root,
      projectRoot: root,
      prefix: "xop-web-existing",
      externalPrefix: "xop-ext-existing",
      maxBytes: 10_000,
      client: existing,
      logger,
    });

    expect(await spooler.ingestExternalFile(file)).not.toBeNull();
  });

  test("reuses the document id when the file changes", async () => {
    const file = join(root, "changing.md");
    const ids: string[] = [];
    const capturing = {
      put: async () => {},
      bulk: async (_index: string, actions: ReadonlyArray<{ id: string }>) => {
        ids.push(...actions.map((action) => action.id));
      },
    } as unknown as XerjClient;
    const spooler = new RemoteSpool({
      root,
      projectRoot: root,
      prefix: "xop-web-change",
      externalPrefix: "xop-ext-change",
      maxBytes: 10_000,
      client: capturing,
      logger,
    });

    await writeFile(file, "first");
    await spooler.ingestExternalFile(file);
    await writeFile(file, "second version");
    await spooler.ingestExternalFile(file);

    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });
});
