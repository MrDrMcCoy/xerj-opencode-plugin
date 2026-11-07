// The command service orchestrates the store, the runner, and the corpus.
// These tests drive the store half directly: ingest, listing, reading, and the
// path checks that keep an ingest inside the project.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { blockedPipeMessage, isFilteredCommand } from "../../src/cmd/filter.ts";
import { CmdService } from "../../src/cmd/service.ts";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

const scratch: string[] = [];

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "xerj-cmd-service-"));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of scratch.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function service(project: string): CmdService {
  const instance = new CmdService({
    config: DEFAULT_CONFIG.cmd,
    storageRoot: join(project, ".xerj"),
    projectRoot: project,
    indexName: "xop-test-cmd-docs",
    getClient: () => null,
    logger,
    signal: new AbortController().signal,
  });
  return instance;
}

describe("CmdService.ingest", () => {
  // The resolved absolute path is what must be read. A relative path used to
  // be passed to readFile unchanged, so the server's working directory
  // decided which file it opened.
  test("reads a relative path from the project root", async () => {
    const project = await tempProject();
    await writeFile(join(project, "notes.txt"), "hello from the project");
    const cmd = service(project);
    try {
      await cmd.start();
      const entry = await cmd.ingest("notes.txt");
      expect(entry).not.toBeNull();
      expect(entry?.command).toContain("notes.txt");

      const read = await cmd.show(entry!.stem, 1, 10);
      expect(read?.lines.join("\n")).toContain("hello from the project");
    } finally {
      cmd.stop();
    }
  });

  test("reads an absolute path inside the project", async () => {
    const project = await tempProject();
    const file = join(project, "build.log");
    await writeFile(file, "line one\nline two\n");
    const cmd = service(project);
    try {
      await cmd.start();
      const entry = await cmd.ingest(file);
      expect(entry).not.toBeNull();
    } finally {
      cmd.stop();
    }
  });

  test("refuses a path outside the project", async () => {
    const project = await tempProject();
    const outside = await mkdtemp(join(tmpdir(), "xerj-cmd-outside-"));
    scratch.push(outside);
    await writeFile(join(outside, "secret.txt"), "not yours");
    const cmd = service(project);
    try {
      await cmd.start();
      expect(await cmd.ingest(join(outside, "secret.txt"))).toBeNull();
      expect(await cmd.ingest("../secret.txt")).toBeNull();
      expect(await cmd.ingest("missing.txt")).toBeNull();
    } finally {
      cmd.stop();
    }
  });

  test("an unknown stem is null, not a guessed file", async () => {
    const project = await tempProject();
    const cmd = service(project);
    try {
      await cmd.start();
      expect(await cmd.show("20260101T000000000Z", 1, 5)).toBeNull();
      expect(cmd.entry("20260101T000000000Z")).toBeNull();
    } finally {
      cmd.stop();
    }
  });
});

describe("isFilteredCommand", () => {
  test("recognizes the pipe-to-filter habit", () => {
    expect(isFilteredCommand("npm test 2>&1 | head -20")).toBe(true);
    expect(isFilteredCommand("cat build.log | grep -i error")).toBe(true);
    expect(isFilteredCommand("journalctl -u xerj | tail -n 100")).toBe(true);
    expect(isFilteredCommand("find . -name '*.ts' | wc -l")).toBe(false);
    expect(isFilteredCommand("npm test")).toBe(false);
  });

  test("the refusal points at xerj_run", () => {
    expect(blockedPipeMessage("npm test | head -5")).toContain("xerj_run");
    expect(blockedPipeMessage("npm test")).toBeNull();
  });
});
