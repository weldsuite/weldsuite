/**
 * Helpers for detecting duplicate display names when uploading project files.
 * Comparison is case-insensitive; folders are ignored.
 */

export type NamedFolderEntry = {
  id: string;
  fileName: string;
  isFolder?: boolean;
};

export function findFileNameConflict(
  fileName: string,
  existingFiles: NamedFolderEntry[],
): NamedFolderEntry | null {
  const needle = fileName.trim().toLowerCase();
  if (!needle) return null;
  return (
    existingFiles.find(
      (f) => !f.isFolder && f.fileName.trim().toLowerCase() === needle,
    ) ?? null
  );
}

export type NameConflictChoice = 'replace' | 'new' | 'cancel';
