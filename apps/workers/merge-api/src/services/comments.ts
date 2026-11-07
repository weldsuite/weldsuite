/** Comments on an issue. */

import { and, asc, eq, isNull } from 'drizzle-orm';
import { generateId } from '@weldsuite/worker-kit/id';
import { mergeComments, type Db, type MergeCommentRow } from './db';

export async function listComments(db: Db, issueId: string): Promise<MergeCommentRow[]> {
  return db
    .select()
    .from(mergeComments)
    .where(and(eq(mergeComments.issueId, issueId), isNull(mergeComments.deletedAt)))
    .orderBy(asc(mergeComments.createdAt), asc(mergeComments.id));
}

export async function findComment(db: Db, id: string): Promise<MergeCommentRow | null> {
  const [row] = await db
    .select()
    .from(mergeComments)
    .where(and(eq(mergeComments.id, id), isNull(mergeComments.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function createComment(db: Db, issueId: string, authorUserId: string, body: string): Promise<MergeCommentRow> {
  const now = new Date();
  const [row] = await db
    .insert(mergeComments)
    .values({ id: generateId('mcm'), issueId, authorUserId, body: body.trim(), createdAt: now, updatedAt: now })
    .returning();
  return row!;
}

export async function updateComment(db: Db, id: string, body: string): Promise<MergeCommentRow> {
  const [row] = await db
    .update(mergeComments)
    .set({ body: body.trim(), updatedAt: new Date() })
    .where(eq(mergeComments.id, id))
    .returning();
  return row!;
}

export async function deleteComment(db: Db, id: string): Promise<MergeCommentRow> {
  const now = new Date();
  const [row] = await db.update(mergeComments).set({ deletedAt: now, updatedAt: now }).where(eq(mergeComments.id, id)).returning();
  return row!;
}
