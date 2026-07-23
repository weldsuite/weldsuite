/**
 * Document version-history service — backs /api/documents/:fileId/versions/*.
 *
 * Immutable BlockNote-JSON snapshots of a document (the `document_versions`
 * table). Auto-snapshots are throttled; named snapshots are explicit.
 */

import { and, desc, eq, gt } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';
import type { DocBlocks } from './documents';

const { documentVersions } = schema;

/** Minimum gap between automatic snapshots for the same document. */
const AUTO_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

export async function listVersions(db: Database, fileId: string) {
  return db
    .select({
      id: documentVersions.id,
      fileId: documentVersions.fileId,
      label: documentVersions.label,
      createdById: documentVersions.createdById,
      createdAt: documentVersions.createdAt,
    })
    .from(documentVersions)
    .where(eq(documentVersions.fileId, fileId))
    .orderBy(desc(documentVersions.createdAt));
}

export async function getVersion(db: Database, fileId: string, versionId: string) {
  const [row] = await db
    .select()
    .from(documentVersions)
    .where(and(eq(documentVersions.id, versionId), eq(documentVersions.fileId, fileId)))
    .limit(1);
  return row ?? null;
}

export async function createVersion(
  db: Database,
  fileId: string,
  content: DocBlocks,
  createdById: string,
  label?: string | null,
) {
  const id = generateId('docver');
  await db.insert(documentVersions).values({
    id,
    fileId,
    content,
    label: label ?? null,
    createdById,
    createdAt: new Date(),
  });
  const [row] = await db.select().from(documentVersions).where(eq(documentVersions.id, id)).limit(1);
  return row!;
}

/**
 * Create an automatic snapshot only if the most recent snapshot for this
 * document is older than the throttle window (or none exists yet). Returns the
 * created row, or null when skipped.
 */
export async function maybeAutoSnapshot(
  db: Database,
  fileId: string,
  content: DocBlocks,
  createdById: string,
) {
  const cutoff = new Date(Date.now() - AUTO_SNAPSHOT_INTERVAL_MS);
  const [recent] = await db
    .select({ id: documentVersions.id })
    .from(documentVersions)
    .where(and(eq(documentVersions.fileId, fileId), gt(documentVersions.createdAt, cutoff)))
    .limit(1);
  if (recent) return null;
  return createVersion(db, fileId, content, createdById, null);
}
