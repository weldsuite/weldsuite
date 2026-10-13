/** Taking a dispatched message for one queue consumer. */

import { and, eq, sql } from 'drizzle-orm';
import { messages, type MasterDatabase, type WarmupMessage } from './db';
import { timestamptz } from './sql';

/**
 * Take the row for this consumer. A message the dispatcher handed out twice (a
 * claim that expired while the queue was backed up) reaches two consumers; the
 * compare-and-set on `claimed_at` lets only one of them through. The same
 * consumer may take it again after a queue retry: that retry sees the value it
 * wrote itself.
 */
export async function takeClaim(
  master: MasterDatabase,
  row: Pick<WarmupMessage, 'id' | 'claimedAt'>,
  status: 'scheduled' | 'sent',
  now: Date,
): Promise<boolean> {
  const held = row.claimedAt
    ? sql`${messages.claimedAt} = ${timestamptz(row.claimedAt)}`
    : sql`${messages.claimedAt} is null`;
  const taken = await master
    .update(messages)
    .set({ claimedAt: now })
    .where(and(eq(messages.id, row.id), eq(messages.status, status), held))
    .returning({ id: messages.id });
  return taken.length > 0;
}
