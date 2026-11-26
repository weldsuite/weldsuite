/**
 * Spreadsheet versions (`sheet_versions`): saved copies of a workbook, each a
 * snapshot in R2 under the sheet's own key prefix. Pure functions over the
 * tenant DB; access checks happen in the routes, snapshots are written by the
 * sheet's room (it holds the live workbook). Same shape as WeldDocs'.
 */

import { and, count, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { SheetVersion } from '@weldsuite/app-api-client/schemas/sheets';
import type { DataFor } from '@weldsuite/entity-events/events';

const { sheetVersions } = schema;

export type SheetVersionRecord = typeof sheetVersions.$inferSelect;

/**
 * Where a version's snapshot goes: next to the sheet's checkpoint
 * (`…/sheets/<id>/workbook.json.gz` → `…/sheets/<id>/versions/<versionId>.json.gz`).
 */
export function versionKeyFor(sheetSnapshotKey: string, versionId: string): string {
  const slash = sheetSnapshotKey.lastIndexOf('/');
  return `${sheetSnapshotKey.slice(0, slash + 1)}versions/${versionId}.json.gz`;
}

export function toVersion(row: SheetVersionRecord): SheetVersion {
  return {
    id: row.id,
    sheetId: row.sheetId,
    revision: row.revision,
    name: row.name,
    size: row.size,
    createdAt: row.createdAt.toISOString(),
    createdById: row.createdById,
  };
}

export function versionEventData(row: SheetVersionRecord): DataFor<'sheet_version'> {
  return { id: row.id, sheetId: row.sheetId, name: row.name, revision: row.revision, createdById: row.createdById };
}

export async function insertVersion(
  db: Database,
  params: { id: string; sheetId: string; revision: number; name: string | null; snapshotKey: string; size: number; createdById: string | null },
): Promise<SheetVersionRecord> {
  const [row] = await db
    .insert(sheetVersions)
    .values({ ...params, createdAt: new Date() })
    .returning();
  if (!row) throw new Error(`Version ${params.id} was not inserted`);
  return row;
}

/** One version of a sheet, or null. */
export async function getVersion(db: Database, sheetId: string, versionId: string): Promise<SheetVersionRecord | null> {
  const [row] = await db
    .select()
    .from(sheetVersions)
    .where(and(eq(sheetVersions.sheetId, sheetId), eq(sheetVersions.id, versionId)))
    .limit(1);
  return row ?? null;
}

/**
 * A sheet's versions, newest first. `after` is the id of the last version of
 * the previous page (a keyset cursor, so versions saved while someone pages
 * through the list do not shift it); an unknown id gives an empty page.
 */
export async function listVersions(
  db: Database,
  sheetId: string,
  params: { limit: number; after?: string },
): Promise<{ rows: SheetVersionRecord[]; total: number; hasMore: boolean }> {
  const ofSheet = eq(sheetVersions.sheetId, sheetId);
  const [{ total } = { total: 0 }] = await db.select({ total: count() }).from(sheetVersions).where(ofSheet);
  let where: SQL | undefined = ofSheet;
  if (params.after) {
    const last = await getVersion(db, sheetId, params.after);
    if (!last) return { rows: [], total, hasMore: false };
    where = and(
      ofSheet,
      or(lt(sheetVersions.createdAt, last.createdAt), and(eq(sheetVersions.createdAt, last.createdAt), lt(sheetVersions.id, last.id))),
    );
  }
  const rows = await db
    .select()
    .from(sheetVersions)
    .where(where)
    .orderBy(desc(sheetVersions.createdAt), desc(sheetVersions.id))
    .limit(params.limit + 1);
  return { rows: rows.slice(0, params.limit), total, hasMore: rows.length > params.limit };
}

/** Renames a version; null when the sheet has no such version. */
export async function renameVersion(db: Database, sheetId: string, versionId: string, name: string): Promise<SheetVersionRecord | null> {
  const [row] = await db
    .update(sheetVersions)
    .set({ name })
    .where(and(eq(sheetVersions.sheetId, sheetId), eq(sheetVersions.id, versionId)))
    .returning();
  return row ?? null;
}
