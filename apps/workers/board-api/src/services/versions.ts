/**
 * Board versions (`board_versions`): saved copies of a board, each a
 * snapshot in R2 under the board's own key prefix. Pure functions over the
 * tenant DB; access checks happen in the routes, snapshots are written by the
 * board's room (it holds the live board). The same as WeldDocs' versions.
 */

import { and, count, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { BoardVersion } from '@weldsuite/app-api-client/schemas/boards';
import type { DataFor } from '@weldsuite/entity-events/events';

const { boardVersions } = schema;

export type BoardVersionRecord = typeof boardVersions.$inferSelect;

/**
 * Where a version's snapshot goes: next to the board's checkpoint
 * (`…/boards/<id>/board.json.gz` → `…/boards/<id>/versions/<versionId>.json.gz`).
 */
export function versionKeyFor(boardSnapshotKey: string, versionId: string): string {
  const slash = boardSnapshotKey.lastIndexOf('/');
  return `${boardSnapshotKey.slice(0, slash + 1)}versions/${versionId}.json.gz`;
}

export function toVersion(row: BoardVersionRecord): BoardVersion {
  return {
    id: row.id,
    boardId: row.boardId,
    revision: row.revision,
    name: row.name,
    size: row.size,
    createdAt: row.createdAt.toISOString(),
    createdById: row.createdById,
  };
}

export function versionEventData(row: BoardVersionRecord): DataFor<'board_version'> {
  return { id: row.id, boardId: row.boardId, name: row.name, revision: row.revision, createdById: row.createdById };
}

export async function insertVersion(
  db: Database,
  params: { id: string; boardId: string; revision: number; name: string | null; snapshotKey: string; size: number; createdById: string | null },
): Promise<BoardVersionRecord> {
  const [row] = await db
    .insert(boardVersions)
    .values({ ...params, createdAt: new Date() })
    .returning();
  if (!row) throw new Error(`Version ${params.id} was not inserted`);
  return row;
}

/** One version of a board, or null. */
export async function getVersion(db: Database, boardId: string, versionId: string): Promise<BoardVersionRecord | null> {
  const [row] = await db
    .select()
    .from(boardVersions)
    .where(and(eq(boardVersions.boardId, boardId), eq(boardVersions.id, versionId)))
    .limit(1);
  return row ?? null;
}

/**
 * A board's versions, newest first. `after` is the id of the last version of
 * the previous page (a keyset cursor, so versions saved while someone pages
 * through the list do not shift it); an unknown id gives an empty page.
 */
export async function listVersions(
  db: Database,
  boardId: string,
  params: { limit: number; after?: string },
): Promise<{ rows: BoardVersionRecord[]; total: number; hasMore: boolean }> {
  const ofBoard = eq(boardVersions.boardId, boardId);
  const [{ total } = { total: 0 }] = await db.select({ total: count() }).from(boardVersions).where(ofBoard);
  let where: SQL | undefined = ofBoard;
  if (params.after) {
    const last = await getVersion(db, boardId, params.after);
    if (!last) return { rows: [], total, hasMore: false };
    where = and(
      ofBoard,
      or(lt(boardVersions.createdAt, last.createdAt), and(eq(boardVersions.createdAt, last.createdAt), lt(boardVersions.id, last.id))),
    );
  }
  const rows = await db
    .select()
    .from(boardVersions)
    .where(where)
    .orderBy(desc(boardVersions.createdAt), desc(boardVersions.id))
    .limit(params.limit + 1);
  return { rows: rows.slice(0, params.limit), total, hasMore: rows.length > params.limit };
}

/** Renames a version; null when the board has no such version. */
export async function renameVersion(db: Database, boardId: string, versionId: string, name: string): Promise<BoardVersionRecord | null> {
  const [row] = await db
    .update(boardVersions)
    .set({ name })
    .where(and(eq(boardVersions.boardId, boardId), eq(boardVersions.id, versionId)))
    .returning();
  return row ?? null;
}
