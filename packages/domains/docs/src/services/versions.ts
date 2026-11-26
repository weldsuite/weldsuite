/**
 * Document versions (`doc_versions`): saved copies of a WeldDocs document,
 * each a snapshot in R2 under the document's own key prefix. Pure functions
 * over the tenant DB; access checks happen in the routes, snapshots are
 * written by the document's room (it holds the live document).
 */

import { and, count, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { DocVersion } from '@weldsuite/app-api-client/schemas/docs';
import type { DataFor } from '@weldsuite/entity-events/events';

const { docVersions } = schema;

export type DocVersionRecord = typeof docVersions.$inferSelect;

/**
 * Where a version's snapshot goes: next to the document's checkpoint
 * (`…/docs/<id>/document.json.gz` → `…/docs/<id>/versions/<versionId>.json.gz`).
 */
export function versionKeyFor(docSnapshotKey: string, versionId: string): string {
  const slash = docSnapshotKey.lastIndexOf('/');
  return `${docSnapshotKey.slice(0, slash + 1)}versions/${versionId}.json.gz`;
}

export function toVersion(row: DocVersionRecord): DocVersion {
  return {
    id: row.id,
    docId: row.docId,
    revision: row.revision,
    name: row.name,
    size: row.size,
    createdAt: row.createdAt.toISOString(),
    createdById: row.createdById,
  };
}

export function versionEventData(row: DocVersionRecord): DataFor<'doc_version'> {
  return { id: row.id, docId: row.docId, name: row.name, revision: row.revision, createdById: row.createdById };
}

export async function insertVersion(
  db: Database,
  params: { id: string; docId: string; revision: number; name: string | null; snapshotKey: string; size: number; createdById: string | null },
): Promise<DocVersionRecord> {
  const [row] = await db
    .insert(docVersions)
    .values({ ...params, createdAt: new Date() })
    .returning();
  if (!row) throw new Error(`Version ${params.id} was not inserted`);
  return row;
}

/** One version of a document, or null. */
export async function getVersion(db: Database, docId: string, versionId: string): Promise<DocVersionRecord | null> {
  const [row] = await db
    .select()
    .from(docVersions)
    .where(and(eq(docVersions.docId, docId), eq(docVersions.id, versionId)))
    .limit(1);
  return row ?? null;
}

/**
 * A document's versions, newest first. `after` is the id of the last version
 * of the previous page (a keyset cursor, so versions saved while someone
 * pages through the list do not shift it); an unknown id gives an empty page.
 */
export async function listVersions(
  db: Database,
  docId: string,
  params: { limit: number; after?: string },
): Promise<{ rows: DocVersionRecord[]; total: number; hasMore: boolean }> {
  const ofDoc = eq(docVersions.docId, docId);
  const [{ total } = { total: 0 }] = await db.select({ total: count() }).from(docVersions).where(ofDoc);
  let where: SQL | undefined = ofDoc;
  if (params.after) {
    const last = await getVersion(db, docId, params.after);
    if (!last) return { rows: [], total, hasMore: false };
    where = and(
      ofDoc,
      or(lt(docVersions.createdAt, last.createdAt), and(eq(docVersions.createdAt, last.createdAt), lt(docVersions.id, last.id))),
    );
  }
  const rows = await db
    .select()
    .from(docVersions)
    .where(where)
    .orderBy(desc(docVersions.createdAt), desc(docVersions.id))
    .limit(params.limit + 1);
  return { rows: rows.slice(0, params.limit), total, hasMore: rows.length > params.limit };
}

/** Renames a version; null when the document has no such version. */
export async function renameVersion(db: Database, docId: string, versionId: string, name: string): Promise<DocVersionRecord | null> {
  const [row] = await db
    .update(docVersions)
    .set({ name })
    .where(and(eq(docVersions.docId, docId), eq(docVersions.id, versionId)))
    .returning();
  return row ?? null;
}
