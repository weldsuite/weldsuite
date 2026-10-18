/**
 * Drive folder tree rules, shared by every worker that writes `folders`
 * (app-api /api/folders, external-api and mcp-server /v1/folders).
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const { folders } = schema;

/** Ancestors walked before giving up; guards against a loop already in the data. */
const MAX_FOLDER_DEPTH = 64;

export type FolderParentCheck = 'ok' | 'parent_not_found' | 'cycle';

/** Error messages for the failed checks, as the routes return them. */
export const FOLDER_PARENT_ERRORS: Record<Exclude<FolderParentCheck, 'ok'>, string> = {
  parent_not_found: 'The destination folder does not exist',
  cycle: 'A folder cannot be moved into itself or one of its subfolders',
};

/**
 * May folder `folderId` (null for a folder that is still to be created) live
 * under `parentId` (null for My Drive)? The parent has to be a live folder,
 * and it can't be the folder itself or one of its subfolders: that would cut
 * the folder and everything in it off from My Drive.
 */
export async function checkFolderParent(
  db: Database,
  folderId: string | null,
  parentId: string | null | undefined,
): Promise<FolderParentCheck> {
  if (!parentId) return 'ok';
  if (folderId && parentId === folderId) return 'cycle';

  const [parent] = await db
    .select({ id: folders.id, parentId: folders.parentId })
    .from(folders)
    .where(and(eq(folders.id, parentId), isNull(folders.deletedAt)))
    .limit(1);
  if (!parent) return 'parent_not_found';
  if (!folderId) return 'ok';

  // Walk up from the new parent: meeting the folder on the way means the
  // parent sits somewhere inside it.
  const seen = new Set<string>([parent.id]);
  let current = parent.parentId;
  for (let depth = 0; current && depth < MAX_FOLDER_DEPTH; depth++) {
    if (current === folderId) return 'cycle';
    if (seen.has(current)) break;
    seen.add(current);
    const [row] = await db
      .select({ parentId: folders.parentId })
      .from(folders)
      .where(eq(folders.id, current))
      .limit(1);
    current = row?.parentId ?? null;
  }
  return 'ok';
}
