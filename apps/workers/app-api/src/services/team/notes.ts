/**
 * Private per-viewer notes on a team member.
 *
 * Each (authorUserId, subjectUserId) pair has at most one row.
 * Notes are always scoped to the viewer — no admin override.
 *
 * Ported from apps/core-api/src/services/team/notes.ts.
 */

import { eq, and } from 'drizzle-orm';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import type { MemberNote } from '@weldsuite/app-api-client/schemas/team-members';

function toApi(row: typeof schema.memberNotes.$inferSelect): MemberNote {
  return {
    id: row.id,
    authorUserId: row.authorUserId,
    subjectUserId: row.subjectUserId,
    body: row.body ?? '',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getMyNoteFor(
  db: Database,
  authorUserId: string,
  subjectUserId: string,
): Promise<MemberNote | null> {
  const { memberNotes } = schema;
  const [row] = await db
    .select()
    .from(memberNotes)
    .where(
      and(
        eq(memberNotes.authorUserId, authorUserId),
        eq(memberNotes.subjectUserId, subjectUserId),
      ),
    )
    .limit(1);
  return row ? toApi(row) : null;
}

export async function upsertMyNote(
  db: Database,
  authorUserId: string,
  subjectUserId: string,
  body: string,
): Promise<MemberNote> {
  const { memberNotes } = schema;
  const now = new Date();

  const [existing] = await db
    .select()
    .from(memberNotes)
    .where(
      and(
        eq(memberNotes.authorUserId, authorUserId),
        eq(memberNotes.subjectUserId, subjectUserId),
      ),
    )
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(memberNotes)
      .set({ body, updatedAt: now })
      .where(eq(memberNotes.id, existing.id))
      .returning();
    return toApi(updated);
  }

  const id = generateId('mnote');
  const [inserted] = await db
    .insert(memberNotes)
    .values({
      id,
      authorUserId,
      subjectUserId,
      body,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return toApi(inserted);
}

export async function deleteMyNote(
  db: Database,
  authorUserId: string,
  subjectUserId: string,
): Promise<void> {
  const { memberNotes } = schema;
  await db
    .delete(memberNotes)
    .where(
      and(
        eq(memberNotes.authorUserId, authorUserId),
        eq(memberNotes.subjectUserId, subjectUserId),
      ),
    );
}
