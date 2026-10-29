/**
 * Mail subscription (mailing list) reads/writes for the Postgres mailbox
 * store (design task B4). Ported from mail-api's `services/mail/subscriptions.ts`
 * and mail-inbound-worker's `email-storage.ts` (`upsertMailSubscription`) —
 * new code here, those files are untouched; wiring them to call through the
 * store is a later task (D1/D4).
 *
 * Two different upsert shapes, both labelled `subscription.upsert`-adjacent in
 * the design, stay separate functions because their conflict-resolution rules
 * differ:
 *  - {@link upsertSubscriptionOnMessage} — one new ham inbound message with a
 *    `List-Unsubscribe` header, folded into `ingest` (design §2 inventory:
 *    "the subscription upsert (when created and ham)"). Bumps the count by
 *    one and refreshes the unsubscribe targets, the way a live mailbox should.
 *  - {@link reconcileSubscriptions} — the `subscription.upsert` op, the bulk
 *    backfill `scanSubscriptions` runs over a window of already-stored
 *    messages. It must never let a stale backfill overwrite what a live
 *    upsert already recorded, so it only ever raises the count
 *    (`GREATEST`) and widens the first-seen date (`LEAST`).
 */

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import type { MailEmailAddress } from '@weldsuite/db/schema/mail-messages';
import type { MailUnsubscribeMethod } from '@weldsuite/db/schema/mail-subscriptions';
import { generateId } from '@weldsuite/worker-kit/id';
import type { SubscriptionValues } from '../types';

const { mailMessages, mailSubscriptions } = schema;

export function listSubscriptions(db: Database, accountId: string, status?: 'active' | 'unsubscribed') {
  const conditions = [eq(mailSubscriptions.accountId, accountId)];
  if (status) conditions.push(eq(mailSubscriptions.status, status));
  return db
    .select()
    .from(mailSubscriptions)
    .where(and(...conditions))
    .orderBy(desc(mailSubscriptions.lastReceivedAt))
    .limit(1000);
}

export async function getSubscription(db: Database, id: string) {
  const [row] = await db.select().from(mailSubscriptions).where(eq(mailSubscriptions.id, id)).limit(1);
  return row ?? null;
}

/**
 * Candidate ham inbound messages for a subscriptions scan: the raw-header
 * reads and the `List-Unsubscribe` parsing stay the caller's job (R2, in
 * mail-api), this is just the SQL `scanSubscriptions` ran before it.
 */
export async function rawSources(
  db: Database,
  accountId: string,
  q: { since: number; limit: number },
): Promise<Array<{ id: string; from: MailEmailAddress; subject: string | null; receivedAt: number }>> {
  const rows = await db
    .select({
      id: mailMessages.id,
      from: mailMessages.from,
      subject: mailMessages.subject,
      receivedDate: mailMessages.receivedDate,
      sentDate: mailMessages.sentDate,
    })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.accountId, accountId),
        eq(mailMessages.source, 'inbound'),
        eq(mailMessages.isSpam, false),
        gte(mailMessages.sentDate, new Date(q.since)),
      ),
    )
    .orderBy(desc(mailMessages.sentDate))
    .limit(q.limit);
  return rows.map((r) => ({
    id: r.id,
    from: r.from,
    subject: r.subject,
    receivedAt: (r.receivedDate ?? r.sentDate).getTime(),
  }));
}

/**
 * One new ham inbound message with a `List-Unsubscribe` header: bump the
 * count, refresh the unsubscribe targets and last subject, keep the
 * unsubscribe status untouched. Ported from `upsertMailSubscription` /
 * `subscriptionConflictSet`.
 */
export async function upsertSubscriptionOnMessage(
  db: Database,
  accountId: string,
  values: SubscriptionValues,
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(mailSubscriptions)
    .values({ id: generateId('msub'), accountId, ...values })
    .onConflictDoUpdate({
      target: [mailSubscriptions.accountId, mailSubscriptions.senderEmail],
      set: {
        senderName: sql`COALESCE(${values.senderName}, ${mailSubscriptions.senderName})`,
        listId: sql`COALESCE(${values.listId}, ${mailSubscriptions.listId})`,
        unsubscribeUrl: values.unsubscribeUrl,
        unsubscribeMailto: values.unsubscribeMailto,
        oneClick: values.oneClick,
        messageCount: sql`${mailSubscriptions.messageCount} + 1`,
        lastSubject: values.lastSubject,
        lastReceivedAt: sql`GREATEST(${mailSubscriptions.lastReceivedAt}, ${values.lastReceivedAt.toISOString()}::timestamp)`,
        updatedAt: now,
      },
    });
}

/**
 * The `subscription.upsert` op: reconcile a backfill window's aggregates
 * against existing rows without ever downgrading what a live upsert already
 * recorded. Ported from `scanSubscriptions`'s per-aggregate upsert.
 */
export async function reconcileSubscriptions(
  db: Database,
  accountId: string,
  values: SubscriptionValues[],
  now: Date = new Date(),
): Promise<void> {
  for (const agg of values) {
    await db
      .insert(mailSubscriptions)
      .values({ id: generateId('msub'), accountId, ...agg })
      .onConflictDoUpdate({
        target: [mailSubscriptions.accountId, mailSubscriptions.senderEmail],
        set: {
          messageCount: sql`GREATEST(${mailSubscriptions.messageCount}, ${agg.messageCount})`,
          firstReceivedAt: sql`LEAST(${mailSubscriptions.firstReceivedAt}, ${agg.firstReceivedAt.toISOString()}::timestamp)`,
          updatedAt: now,
        },
      });
  }
}

export interface SubscriptionStatusPatch {
  status: 'unsubscribed';
  method: MailUnsubscribeMethod;
  at: number;
  by: string;
}

/** The `subscription.status` op: record the outcome of an unsubscribe. The mechanism itself (HTTP/mailto) stays mail-api's job. */
export async function updateSubscriptionStatus(
  db: Database,
  id: string,
  patch: SubscriptionStatusPatch,
): Promise<typeof mailSubscriptions.$inferSelect | null> {
  const at = new Date(patch.at);
  const [updated] = await db
    .update(mailSubscriptions)
    .set({
      status: patch.status,
      unsubscribeMethod: patch.method,
      unsubscribedAt: at,
      unsubscribedBy: patch.by,
      updatedAt: at,
    })
    .where(eq(mailSubscriptions.id, id))
    .returning();
  return updated ?? null;
}
