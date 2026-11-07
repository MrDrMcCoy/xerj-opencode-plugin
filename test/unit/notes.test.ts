import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoteStore, formatNote } from "../../src/notes/store.ts";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

const scratch: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "xerj-notes-"));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of scratch.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("notes", () => {
  test("adds, persists, searches, and removes a note", async () => {
    const directory = await tempDir();
    const store = new NoteStore({ directory, logger });
    const note = await store.add({
      text: "Ask Dana before changing the release process.",
      conditions: ["release", "deploy"],
      tags: ["process"],
    });

    expect(note.id).toHaveLength(16);
    const again = new NoteStore({ directory, logger });
    expect(await again.list()).toHaveLength(1);
    expect((await again.search("release"))[0]?.id).toBe(note.id);
    expect(await again.remove(note.id)).toBe(true);
    expect(await again.list()).toHaveLength(0);
  });

  test("matches a condition and records a hit", async () => {
    const directory = await tempDir();
    const store = new NoteStore({ directory, logger });
    const note = await store.add({
      text: "Remember the release checklist.",
      conditions: ["release"],
    });

    const matched = await store.match("what is on the release checklist?");
    expect(matched?.id).toBe(note.id);
    await store.recordHit(note.id);
    const listed = await store.list();
    expect(listed[0]?.hits).toBe(1);
  });

  test("matches two content terms when there is no condition", async () => {
    const directory = await tempDir();
    const store = new NoteStore({ directory, logger });
    await store.add({
      text: "The nightly sweep compares storage journal sizes.",
    });
    expect(await store.match("storage journal")).not.toBeNull();
    expect(await store.match("unrelated prompt")).toBeNull();
  });

  test("formats one bounded block", () => {
    const block = formatNote(
      {
        id: "abc",
        text: "x".repeat(50),
        created: "",
        conditions: [],
        tags: [],
        hits: 0,
        lastHit: null,
      },
      20,
    );
    expect(block).toContain("<xerj-note>");
    expect(block).toContain("…");
    expect(block.length).toBeLessThan(100);
  });
});
