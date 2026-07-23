/**
 * Documents service — pure functions backing /api/documents/*.
 *
 * Operates on the `docs` table: native rich-text documents whose canonical
 * content is BlockNote block JSON (source of truth). Each row is paired 1:1
 * with a drive `files` row via `fileId`. docx/pdf are derived on demand and
 * are never persisted as the source of truth.
 */

import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';

const { docs } = schema;

export type DocBlocks = Record<string, unknown>[];

export async function getDocByFileId(db: Database, fileId: string) {
  const [row] = await db
    .select()
    .from(docs)
    .where(eq(docs.fileId, fileId))
    .limit(1);
  return row ?? null;
}

/** Create an empty document row for a freshly-created file. */
export async function createDocForFile(
  db: Database,
  fileId: string,
  userId: string,
  content: DocBlocks = [],
) {
  const id = generateId('doc');
  const now = new Date();
  await db.insert(docs).values({
    id,
    fileId,
    content,
    updatedById: userId,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db.select().from(docs).where(eq(docs.id, id)).limit(1);
  return row!;
}

/**
 * Persist the document's block JSON. Inserts a row on first save (a doc that
 * predates Phase 1 has no row yet), otherwise updates the existing row.
 */
export async function upsertDocContent(
  db: Database,
  fileId: string,
  content: DocBlocks,
  userId: string,
) {
  const existing = await getDocByFileId(db, fileId);
  const now = new Date();
  if (!existing) {
    return createDocForFile(db, fileId, userId, content);
  }
  await db
    .update(docs)
    .set({ content, updatedById: userId, updatedAt: now })
    .where(and(eq(docs.id, existing.id)));
  const [row] = await db.select().from(docs).where(eq(docs.id, existing.id)).limit(1);
  return row!;
}
