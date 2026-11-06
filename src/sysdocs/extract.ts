// Pure pieces for the system-docs corpus: naming a man or info page, turning
// roff into searchable text, deduplicating by name, and diffing the discovered
// set against the manifest written by the previous run.

export type SysdocSource = "man" | "info";

export interface SysdocPage {
  readonly path: string;
  readonly name: string;
  readonly section: string;
  readonly source: SysdocSource;
  readonly mtime: number;
  readonly size: number;
}

export interface SysdocDocument {
  readonly path: string;
  readonly absPath: string;
  readonly title: string;
  readonly body: string;
  readonly source: SysdocSource;
}

/** `git.1.gz` under a `man1` directory is page `git` of section `1`. */
export function manPageName(path: string): { name: string; section: string } | null {
  const file = path.split("/").pop() ?? "";
  // `.1.gz` compresses to a file with no stem; it is not a page.
  // `name.section` with an optional compression suffix, which is what a man
  // tree holds: `git.1.gz`, `perlfunc.3p`, `hosts.5`.
  const match = /^([^.\/][^\/]*)\.([1-9][a-z]*)(?:\.(?:gz|xz|bz2))?$/.exec(file);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { name: match[1], section: match[2] };
}

/**
 * Keeps one page per name and section: the first path wins, so a MANPATH order
 * decides which copy `man` would show. Later duplicates are dropped rather than
 * indexed twice.
 */
export function dedupePages(pages: ReadonlyArray<SysdocPage>): SysdocPage[] {
  const seen = new Set<string>();
  const kept: SysdocPage[] = [];

  for (const page of pages) {
    const key = `${page.source}:${page.name}:${page.section}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(page);
  }

  return kept;
}

const BLANK_LINE_RUN = /\n{3,}/g;

/**
 * Strips roff control lines and escapes so the page reads as prose. Formatting
 * is lost on purpose: this text is for search, not for display.
 */
export function stripRoff(text: string): string {
  const lines: string[] = [];

  for (const line of text.split("\n")) {
    // A control line starts with `.` or `'`; dropping it keeps the arguments
    // only when they were prose, which roff separates with the same syntax.
    if (/^[.']/.test(line)) {
      // Section headings stay in the text: a man page names every subject in
      // one, so they are the strongest search signal the page has. The title
      // header (`.TH`) is dropped because the document title already carries it.
      const section = /^[.'](?:SH|SS)\s+(.+)$/.exec(line);
      if (section?.[1] !== undefined) {
        lines.push(section[1].replace(/["']/g, "").trim());
      }
      continue;
    }
    lines.push(line);
  }

  return lines
    .join("\n")
    .replace(/\\f[BIRP]/g, "")
    .replace(/\\\([a-z]{2}/g, "")
    .replace(/\\-/g, "-")
    .replace(/\\e/g, "\\")
    .replace(/\\&/g, "")
    .replace(BLANK_LINE_RUN, "\n\n")
    .trim();
}

/** Cuts text to `max` characters on a word boundary and marks the cut. */
export function truncate(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text;

  const slice = text.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(" ");
  const head = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${head.trimEnd()}…`;
}

export function formatSysdoc(
  page: SysdocPage,
  body: string,
): SysdocDocument {
  const where =
    page.source === "man" ? `man/${page.name}.${page.section}` : `info/${page.name}`;
  const title =
    page.source === "man" ? `${page.name}(${page.section})` : `${page.name} (info)`;

  return {
    path: where,
    absPath: page.path,
    title,
    // Provenance first, so a snippet on its own says where it came from.
    body: `# ${title}\nSource: ${page.path}\n\n${body}`,
    source: page.source,
  };
}

export interface ManifestEntry {
  readonly id: string;
  readonly mtime: number;
  readonly size: number;
  readonly source: SysdocSource;
}

export interface IngestPlan {
  readonly ingest: SysdocPage[];
  readonly prune: string[];
  readonly skipped: number;
}

/**
 * What a run has to do: `ingest` holds new or changed pages, `prune` holds ids
 * whose file is gone, and `skipped` counts pages already indexed unchanged.
 */
export function planIngest(
  pages: ReadonlyArray<SysdocPage>,
  manifest: Readonly<Record<string, ManifestEntry>>,
): IngestPlan {
  const ingest: SysdocPage[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const page of pages) {
    seen.add(page.path);
    const entry = manifest[page.path];
    if (entry !== undefined && entry.mtime === page.mtime && entry.size === page.size) {
      skipped += 1;
      continue;
    }
    ingest.push(page);
  }

  const prune = Object.entries(manifest)
    .filter(([path]) => !seen.has(path))
    .map(([, entry]) => entry.id);

  return { ingest, prune, skipped };
}
