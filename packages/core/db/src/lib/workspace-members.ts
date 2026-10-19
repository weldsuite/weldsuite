/**
 * Free a `workspace_members.user_id` still held by a removed (soft-deleted)
 * member, so a live row can take it.
 *
 * `user_id` is unique over every row, deleted ones included, and removing a
 * member only sets `deleted_at`. Without this, re-inviting someone who was a
 * member before fails twice: the `invited_<email>` placeholder insert, and on
 * accept the update that sets their real Clerk user id. The old row's
 * `user_id` is rewritten to `removed_<row id>`, which keeps it unique and
 * leaves the live row as the only match for that user id. That matters
 * because many reads join or look up members on `user_id` without filtering
 * `deleted_at`.
 *
 * Call it right before any write that sets `user_id` on a live row. It only
 * touches deleted rows, so it is a no-op for everyone who was never removed.
 */

import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../schema';

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

const { workspaceMembers } = schema;

export async function releaseRemovedMemberUserId(db: AnyDb, userId: string): Promise<void> {
  await db
    .update(workspaceMembers)
    .set({ userId: sql`'removed_' || ${workspaceMembers.id}` })
    .where(and(eq(workspaceMembers.userId, userId), isNotNull(workspaceMembers.deletedAt)));
}
