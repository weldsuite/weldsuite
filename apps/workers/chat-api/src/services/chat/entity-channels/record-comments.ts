import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';

/** Most comment threads, and replies across them, one call returns. */
const MAX_THREADS = 500;
const MAX_REPLIES = 2_000;

/**
 * A record's comment threads (ADR CHAT-007): the top-level messages of its
 * chat posted with `metadata.anchor` (a place in the record, such as a
 * spreadsheet cell or a stretch of a document's text) and every reply in
 * their threads, oldest first. The record keeps where each thread is; the
 * comment panel beside it joins the two by `metadata.anchor.id`. Past the
 * limits, the newest threads and replies are the ones kept: threads whose
 * text or cell is gone leave their messages in the chat, and must not crowd
 * out the ones in use.
 */
export async function listRecordComments(
  db: Database,
  channelId: string,
): Promise<(typeof schema.chatMessages.$inferSelect)[]> {
  const m = schema.chatMessages;
  const threads = await db
    .select()
    .from(m)
    .where(
      and(
        eq(m.channelId, channelId),
        isNull(m.deletedAt),
        isNull(m.parentId),
        sql`(${m.metadata} -> 'anchor') is not null`,
      ),
    )
    .orderBy(desc(m.createdAt))
    .limit(MAX_THREADS);
  if (threads.length === 0) return [];
  threads.reverse();

  const replies = await db
    .select()
    .from(m)
    .where(
      and(
        eq(m.channelId, channelId),
        isNull(m.deletedAt),
        inArray(
          m.parentId,
          threads.map((t) => t.id),
        ),
      ),
    )
    .orderBy(desc(m.createdAt))
    .limit(MAX_REPLIES);
  return [...threads, ...replies.reverse()];
}
