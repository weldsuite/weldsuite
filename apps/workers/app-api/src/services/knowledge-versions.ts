/**
 * Knowledge-page version-history service — backs /api/knowledge/pages/:id/versions/*.
 *
 * Immutable BlockNote-JSON snapshots of a knowledge page (the
 * `knowledge_page_versions` table). Auto-snapshots are throttled; named
 * snapshots are explicit. Mirrors services/document-versions.ts.
 */

import { and, desc, eq, gt } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';

const { knowledgePageVersions } = schema;

export type PageBlocks = Record<string, unknown>[];

/** Minimum gap between automatic snapshots for the same page. */
const AUTO_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

export async function listPageVersions(db: Database, pageId: string) {
  return db
    .select({
      id: knowledgePageVersions.id,
      pageId: knowledgePageVersions.pageId,
      label: knowledgePageVersions.label,
      createdById: knowledgePageVersions.createdById,
      createdAt: knowledgePageVersions.createdAt,
    })
    .from(knowledgePageVersions)
    .where(eq(knowledgePageVersions.pageId, pageId))
    .orderBy(desc(knowledgePageVersions.createdAt));
}

export async function getPageVersion(db: Database, pageId: string, versionId: string) {
  const [row] = await db
    .select()
    .from(knowledgePageVersions)
    .where(and(eq(knowledgePageVersions.id, versionId), eq(knowledgePageVersions.pageId, pageId)))
    .limit(1);
  return row ?? null;
}

export async function createPageVersion(
  db: Database,
  pageId: string,
  content: PageBlocks,
  createdById: string,
  label?: string | null,
) {
  const id = generateId('kver');
  await db.insert(knowledgePageVersions).values({
    id,
    pageId,
    content,
    label: label ?? null,
    createdById,
    createdAt: new Date(),
  });
  const [row] = await db
    .select()
    .from(knowledgePageVersions)
    .where(eq(knowledgePageVersions.id, id))
    .limit(1);
  return row!;
}

/**
 * Create an automatic snapshot only if the most recent snapshot for this page
 * is older than the throttle window (or none exists yet). Returns the created
 * row, or null when skipped.
 */
export async function maybeAutoSnapshotPage(
  db: Database,
  pageId: string,
  content: PageBlocks,
  createdById: string,
) {
  const cutoff = new Date(Date.now() - AUTO_SNAPSHOT_INTERVAL_MS);
  const [recent] = await db
    .select({ id: knowledgePageVersions.id })
    .from(knowledgePageVersions)
    .where(and(eq(knowledgePageVersions.pageId, pageId), gt(knowledgePageVersions.createdAt, cutoff)))
    .limit(1);
  if (recent) return null;
  return createPageVersion(db, pageId, content, createdById, null);
}
