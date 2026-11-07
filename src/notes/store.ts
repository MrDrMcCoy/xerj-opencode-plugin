// Project notes: deferred intentions with surface conditions.
//
// Notes live in `<project>/.xerj/notes.jsonl`, mode 0600, and hold no file
// writes. A note is surfaced when the current prompt matches one of its
// conditions or tags; without conditions, its own content terms must match.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Logger } from "../log.ts";
import { contentTerms } from "../search/rank.ts";

export interface NoteRecord {
  readonly id: string;
  readonly text: string;
  readonly created: string;
  readonly conditions: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<string>;
  readonly hits: number;
  readonly lastHit: string | null;
}

export interface NoteInput {
  readonly text: string;
  readonly conditions?: ReadonlyArray<string>;
  readonly tags?: ReadonlyArray<string>;
}

export interface NoteStoreOptions {
  /** `<project>/.xerj`. */
  readonly directory: string;
  readonly logger: Logger;
}

const MAX_NOTES = 500;
const MAX_TERMS = 12;

export class NoteStore {
  private readonly file: string;
  private notes: NoteRecord[] | null = null;

  constructor(private readonly options: NoteStoreOptions) {
    this.file = join(options.directory, "notes.jsonl");
  }

  async list(): Promise<ReadonlyArray<NoteRecord>> {
    return this.load();
  }

  async add(input: NoteInput): Promise<NoteRecord> {
    const text = input.text.trim();
    if (text.length === 0) throw new Error("a note needs text");
    const notes = await this.load();
    const id = createHash("sha256").update(text).digest("hex").slice(0, 16);
    const existing = notes.find((note) => note.id === id);
    if (existing !== undefined) return existing;

    const note: NoteRecord = {
      id,
      text,
      created: new Date().toISOString(),
      conditions: clean(input.conditions),
      tags: clean(input.tags),
      hits: 0,
      lastHit: null,
    };
    const next = [...notes, note].slice(-MAX_NOTES);
    await this.save(next);
    return note;
  }

  async remove(id: string): Promise<boolean> {
    const notes = await this.load();
    const next = notes.filter((note) => note.id !== id);
    if (next.length === notes.length) return false;
    await this.save(next);
    return true;
  }

  /**
   * The best note for this prompt, or null. Conditions and tags score 3;
   * note text terms score 1 and need two matches when no condition exists.
   */
  async match(prompt: string): Promise<NoteRecord | null> {
    const notes = await this.load();
    if (notes.length === 0) return null;
    const terms = new Set(contentTerms(prompt));
    if (terms.size === 0) return null;

    let best: { note: NoteRecord; score: number } | null = null;
    for (const note of notes) {
      const cueTerms = [...note.conditions, ...note.tags]
        .flatMap((value) => contentTerms(value))
        .filter((term) => term.length >= 3);
      let score = 0;
      let matchedCue = false;
      for (const term of cueTerms) {
        if (terms.has(term)) {
          score += 3;
          matchedCue = true;
        }
      }
      if (!matchedCue) {
        let textMatches = 0;
        for (const term of contentTerms(note.text)) {
          if (term.length >= 4 && terms.has(term)) textMatches += 1;
        }
        if (textMatches < 2) continue;
        score += textMatches;
      }
      if (best === null || score > best.score) best = { note, score };
    }
    return best?.note ?? null;
  }

  /** Notes whose text, conditions, or tags contain the query terms. */
  async search(query: string, limit = 10): Promise<ReadonlyArray<NoteRecord>> {
    const terms = new Set(contentTerms(query));
    if (terms.size === 0) return [];
    const notes = await this.load();
    const scored: Array<{ note: NoteRecord; score: number }> = [];
    for (const note of notes) {
      const haystack = contentTerms(
        `${note.text} ${note.conditions.join(" ")} ${note.tags.join(" ")}`,
      );
      let score = 0;
      for (const term of haystack) if (terms.has(term)) score += 1;
      if (score > 0) scored.push({ note, score });
    }
    scored.sort((left, right) => right.score - left.score);
    return scored.slice(0, Math.max(1, limit)).map((entry) => entry.note);
  }

  async recordHit(id: string): Promise<void> {
    const notes = await this.load();
    const index = notes.findIndex((note) => note.id === id);
    if (index === -1) return;
    const note = notes[index]!;
    notes[index] = {
      ...note,
      hits: note.hits + 1,
      lastHit: new Date().toISOString(),
    };
    await this.save(notes);
  }

  private async load(): Promise<NoteRecord[]> {
    if (this.notes !== null) return this.notes;
    try {
      const text = await readFile(this.file, "utf8");
      const parsed: NoteRecord[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const value = JSON.parse(line) as Partial<NoteRecord>;
          if (typeof value.id !== "string" || typeof value.text !== "string") continue;
          parsed.push({
            id: value.id,
            text: value.text,
            created: typeof value.created === "string" ? value.created : "",
            conditions: stringArray(value.conditions),
            tags: stringArray(value.tags),
            hits: typeof value.hits === "number" ? value.hits : 0,
            lastHit: typeof value.lastHit === "string" ? value.lastHit : null,
          });
        } catch {
          // A corrupt line is skipped; the rest of the file is kept.
        }
      }
      this.notes = parsed;
    } catch {
      this.notes = [];
    }
    return this.notes;
  }

  private async save(notes: ReadonlyArray<NoteRecord>): Promise<void> {
    this.notes = [...notes];
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.partial-${process.pid}`;
      await writeFile(
        temporary,
        `${notes.map((note) => JSON.stringify(note)).join("\n")}\n`,
        { mode: 0o600 },
      );
      await rename(temporary, this.file);
    } catch (error) {
      this.options.logger.debug("could not save notes", String(error));
    }
  }
}

export function formatNote(note: NoteRecord, maxChars = 400): string {
  const text =
    note.text.length <= maxChars ? note.text : `${note.text.slice(0, maxChars - 1)}…`;
  return [
    "<xerj-note>",
    `A saved note matched this prompt (id ${note.id}):`,
    text,
    "</xerj-note>",
  ].join("\n");
}

function clean(values: ReadonlyArray<string> | undefined): string[] {
  if (values === undefined) return [];
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
