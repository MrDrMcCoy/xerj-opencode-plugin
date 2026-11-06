// A project's agent notes usually live in dot-directories, and the engine skips
// hidden paths unconditionally. Nothing indexes them unless the configuration
// names them, so the panel says which folders are being missed instead of
// leaving an empty search to explain itself.

/** Dot-directories that commonly hold project notes. */
export const DOC_FOLDERS = [".agents", ".github", ".claude"] as const;

/**
 * The docs folders present in this project. Used as the default hidden corpus
 * so project notes are searchable without configuration.
 */
export function detectDocsFolders(exists: (folder: string) => boolean): string[] {
  return DOC_FOLDERS.filter((folder) => exists(folder));
}

export function unindexedDocsHint(
  exists: (folder: string) => boolean,
  configured: ReadonlyArray<string>,
): string | null {
  const covered = new Set(configured.map(normalize));
  const missing = DOC_FOLDERS.filter((folder) => exists(folder) && !covered.has(folder));
  if (missing.length === 0) return null;

  const names = missing.map((folder) => `"${folder}"`).join(", ");
  return (
    `${missing.join(", ")} not indexed: the engine skips hidden folders. ` +
    `Add ${names} to index.hidden to search project notes, ` +
    "or to index.brain to build graph edges as well."
  );
}

function normalize(folder: string): string {
  return folder.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}
