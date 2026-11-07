// Heuristic unused-export detection for the inspect tool.
//
// A name is unused when it is exported once and no project file mentions it
// again, including its own declaration file. This is identifier matching, not
// type analysis: a dynamic import, a string reference, or a re-export can make
// a live export look unused, so the result is labelled heuristic.

export interface ExportName {
  readonly name: string;
  readonly kind: string;
  readonly line: number;
}

export interface UnusedExport extends ExportName {
  readonly path: string;
}

const EXPORT =
  /^[ \t]*export[ \t]+(?:async[ \t]+)?(function|const|let|var|class|interface|type|enum)[ \t]+([A-Za-z_$][\w$]*)/gm;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/** Exported top-level names in one file, in source order. */
export function exportedNames(text: string): ExportName[] {
  const names: ExportName[] = [];
  EXPORT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EXPORT.exec(text)) !== null) {
    const name = match[2];
    if (name === undefined) continue;
    names.push({
      name,
      kind: match[1] ?? "value",
      line: text.slice(0, match.index).split("\n").length,
    });
  }
  return names;
}

/** Counts each identifier per file, then reports exports with no other use. */
export function unusedExports(
  files: ReadonlyMap<string, string>,
  limit = 50,
): UnusedExport[] {
  const counts = new Map<string, Map<string, number>>();
  for (const [path, text] of files) {
    IDENTIFIER.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IDENTIFIER.exec(text)) !== null) {
      const name = match[0];
      const byPath = counts.get(name) ?? new Map<string, number>();
      byPath.set(path, (byPath.get(path) ?? 0) + 1);
      counts.set(name, byPath);
    }
  }

  const unused: UnusedExport[] = [];
  for (const [path, text] of files) {
    for (const exported of exportedNames(text)) {
      const byPath = counts.get(exported.name);
      if (byPath === undefined) continue;
      const total = [...byPath.values()].reduce((sum, value) => sum + value, 0);
      const own = byPath.get(path) ?? 0;
      if (total <= own && own <= 1) {
        unused.push({ ...exported, path });
        if (unused.length >= limit) return unused;
      }
    }
  }
  return unused;
}
