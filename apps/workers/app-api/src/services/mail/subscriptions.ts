/**
 * Mail subscriptions — mailing lists / newsletters an account receives,
 * with Gmail-style unsubscribe.
 *
 * Rows in `mail_subscriptions` are upserted by mail-inbound-worker on every
 * message that carries a `List-Unsubscribe` header. `scanSubscriptions`
 * backfills the table from the raw headers of already-stored messages.
 * Header parsing, the unsubscribe mechanism picker and the backfill
 * aggregation live in `@weldsuite/email/list-unsubscribe`, shared with
 * personal-api.
 */

import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import type { ExecutionContext } from 'hono';
import {
  aggregateSubscriptions,
  performUnsubscribe,
  type UnsubscribeOutcome,
} from '@weldsuite/email/list-unsubscribe';
import { schema } from '../../db';
import type { Database } from '../../db';
import type { Env } from '../../types';
import { generateId } from '../../lib/id';
import { sendAndPersist } from './send';

const { mailSubscriptions, mailMessages } = schema;

export type MailSubscriptionRow = typeof mailSubscriptions.$inferSelect;

/** How far back and how many stored messages a scan looks at. */
export const SCAN_WINDOW_DAYS = 180;
export const SCAN_MESSAGE_LIMIT = 2000;
/** Only the header block is needed — never pull whole raw bodies. */
export const RAW_HEADER_BYTES = 32_000;

export async function listSubscriptions(
  db: Database,
  input: { accountId: string; status?: 'active' | 'unsubscribed' },
): Promise<MailSubscriptionRow[]> {
  const conditions = [eq(mailSubscriptions.accountId, input.accountId)];
  if (input.status) conditions.push(eq(mailSubscriptions.status, input.status));
  return db
    .select()
    .from(mailSubscriptions)
    .where(and(...conditions))
    .orderBy(desc(mailSubscriptions.lastReceivedAt))
    .limit(1000);
}

export async function getSubscription(db: Database, id: string): Promise<MailSubscriptionRow | null> {
  const [row] = await db.select().from(mailSubscriptions).where(eq(mailSubscriptions.id, id)).limit(1);
  return row ?? null;
}

/**
 * Rebuild subscription rows for an account from the raw headers of its
 * recently received messages. Unsubscribe state on existing rows is kept.
 */
export async function scanSubscriptions(
  db: Database,
  accountId: string,
): Promise<{ scanned: number; subscriptions: number }> {
  const since = new Date(Date.now() - SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      from: mailMessages.from,
      subject: mailMessages.subject,
      receivedDate: mailMessages.receivedDate,
      sentDate: mailMessages.sentDate,
      rawHeaders: sql<string | null>`substring(${mailMessages.rawMessage} from 1 for ${RAW_HEADER_BYTES})`,
    })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.accountId, accountId),
        eq(mailMessages.source, 'inbound'),
        eq(mailMessages.isSpam, false),
        isNotNull(mailMessages.rawMessage),
        gte(mailMessages.sentDate, since),
      ),
    )
    .orderBy(desc(mailMessages.sentDate))
    .limit(SCAN_MESSAGE_LIMIT);

  const aggregates = aggregateSubscriptions(
    rows.map((r) => ({
      from: r.from,
      subject: r.subject,
      receivedAt: r.receivedDate ?? r.sentDate,
      rawHeaders: r.rawHeaders,
    })),
  );

  const now = new Date();
  for (const agg of aggregates) {
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

  return { scanned: rows.length, subscriptions: aggregates.length };
}

export async function unsubscribe(
  env: Env,
  db: Database,
  input: {
    orgId: string;
    userId: string;
    subscription: MailSubscriptionRow;
    waitUntil?: ExecutionContext['waitUntil'];
  },
): Promise<{ subscription: MailSubscriptionRow; outcome: UnsubscribeOutcome }> {
  const { subscription } = input;
  const outcome = await performUnsubscribe(subscription, {
    fetch: (...args) => fetch(...args),
    sendMail: async ({ to, subject, body }) => {
      await sendAndPersist(
        env,
        db,
        input.orgId,
        input.userId,
        subscription.accountId,
        { to: [to], subject, body },
        input.waitUntil,
      );
    },
  });

  const now = new Date();
  const [updated] = await db
    .update(mailSubscriptions)
    .set({
      status: 'unsubscribed',
      unsubscribeMethod: outcome.method,
      unsubscribedAt: now,
      unsubscribedBy: input.userId,
      updatedAt: now,
    })
    .where(eq(mailSubscriptions.id, subscription.id))
    .returning();

  return { subscription: updated ?? subscription, outcome };
}
