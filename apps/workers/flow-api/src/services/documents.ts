/**
 * Documents service — pure functions backing /api/documents/*.
 *
 * Operates on the `docs` table: documents from before WeldDocs, whose
 * canonical content is BlockNote block JSON (source of truth). Each row is
 * paired 1:1 with a drive `files` row via `fileId`. docx/pdf are derived on
 * demand and are never persisted as the source of truth. The same table holds
 * WeldDocs documents (docs-api; `content` null): see `isWeldDocsRow`.
 */

import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

const { docs } = schema;

export type DocBlocks = Record<string, unknown>[];

/**
 * Whether a `docs` row is a WeldDocs document (docs-api), whose content lives
 * in its DocRoom and R2 checkpoints, not in `content`. That is `content` null
 * (the only way a row gets one) or a checkpoint key (what docs-api records);
 * both hold for every WeldDocs row, either alone is enough to keep BlockNote
 * JSON out of it. This module's endpoints must never write to such a row.
 */
export function isWeldDocsRow(row: { content: unknown; snapshotKey: string | null }): boolean {
  return row.content === null || row.snapshotKey !== null;
}

/** Why a write to a WeldDocs row is refused (HTTP 409). */
export const WELDDOCS_ROW_MESSAGE = 'This document is edited in WeldDocs and cannot be changed through this endpoint';

/** Thrown when a write would put BlockNote JSON into a WeldDocs row. */
export class WeldDocsRowError extends Error {
  constructor() {
    super(WELDDOCS_ROW_MESSAGE);
  }
}

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
  // Backstop for the routes' own check: never overwrite a WeldDocs document.
  if (isWeldDocsRow(existing)) throw new WeldDocsRowError();
  await db
    .update(docs)
    .set({ content, updatedById: userId, updatedAt: now })
    .where(and(eq(docs.id, existing.id)));
  const [row] = await db.select().from(docs).where(eq(docs.id, existing.id)).limit(1);
  return row!;
}
