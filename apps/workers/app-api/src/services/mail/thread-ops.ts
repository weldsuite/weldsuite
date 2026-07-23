/**
 * Thread-level write operations.
 *
 * Read aggregation lives in `./threads.ts` (used by the labels/threads
 * endpoint). This file is the bulk-mutation side — anything that needs
 * to touch every message in a thread in one statement.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema } from '../../db';
import type { Database } from '../../db';

const { mailMessages } = schema;

/**
 * Flip `isRead` on every message in a thread in a single UPDATE.
 *
 * Without this, opening a thread with N unread messages would either
 * leave siblings unread (if only the focused message was marked) or
 * cost N round-trips. We gate on `isRead = !next` so the UPDATE only
 * touches rows that actually change — keeps `updated_at` honest.
 */
export async function markThreadRead(
  db: Database,
  accountId: string,
  threadId: string,
  isRead: boolean,
): Promise<{ updatedCount: number }> {
  const result = await db
    .update(mailMessages)
    .set({ isRead, updatedAt: new Date() })
    .where(
      and(
        eq(mailMessages.accountId, accountId),
        sql`COALESCE(${mailMessages.threadId}, ${mailMessages.id}) = ${threadId}`,
        isNull(mailMessages.deletedAt),
        eq(mailMessages.isRead, !isRead),
      ),
    )
    .returning({ id: mailMessages.id });
  return { updatedCount: result.length };
}
