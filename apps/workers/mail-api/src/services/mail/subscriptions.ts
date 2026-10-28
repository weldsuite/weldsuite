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
 *
 * Raw MIME lives in R2, never in the Postgres `raw_message` column
 * (docs/plans/weldmail-mailbox-store-design.md decision 4), so the scan reads
 * each candidate message's header bytes from R2
 * (`@weldsuite/mail-domain/store/bodies`) instead of a `raw_message IS NOT
 * NULL` SQL filter — that column is always NULL for workspace mail.
 */

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { ExecutionContext } from 'hono';
import {
  aggregateSubscriptions,
  performUnsubscribe,
  type UnsubscribeOutcome,
} from '@weldsuite/email/list-unsubscribe';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import type { Env } from '../../types';
import { generateId } from '@weldsuite/worker-kit/id';
import { sendAndPersist } from '@weldsuite/mail-domain/send';
import { getRawMimeHeader } from '@weldsuite/mail-domain/store/bodies';

const { mailSubscriptions, mailMessages } = schema;

export type MailSubscriptionRow = typeof mailSubscriptions.$inferSelect;

/** How far back and how many stored messages a scan looks at. */
export const SCAN_WINDOW_DAYS = 180;
export const SCAN_MESSAGE_LIMIT = 2000;
/** Only the header block is needed — never pull whole raw bodies. */
export const RAW_HEADER_BYTES = 32_000;
/** R2 range-reads in flight at once, so a 2000-message scan doesn't fire 2000 requests at once. */
const R2_READ_CONCURRENCY = 20;

/** Runs `fn` over `items` with at most `limit` in flight, preserving result order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function listSubscriptions(
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
 *
 * `env` only needs `MAIL_STORAGE`, the EU mail bucket: without it (or without a
 * raw object for a given message — e.g. it predates this fix, or the inbound
 * R2 write failed) that message simply contributes nothing, same as
 * `aggregateSubscriptions` already does for a null `rawHeaders`.
 */
export async function scanSubscriptions(
  env: { MAIL_STORAGE?: R2Bucket },
  db: Database,
  input: { workspaceId: string; accountId: string },
): Promise<{ scanned: number; subscriptions: number }> {
  const { workspaceId, accountId } = input;
  const since = new Date(Date.now() - SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000);
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
        gte(mailMessages.sentDate, since),
      ),
    )
    .orderBy(desc(mailMessages.sentDate))
    .limit(SCAN_MESSAGE_LIMIT);

  const rawHeaders = env.MAIL_STORAGE
    ? await mapWithConcurrency(rows, R2_READ_CONCURRENCY, (row) =>
        getRawMimeHeader(env.MAIL_STORAGE!, { workspaceId, accountId, messageId: row.id }, RAW_HEADER_BYTES).catch(
          (err) => {
            console.warn(
              `[mail-subscriptions] Failed to read raw MIME header from R2 for ${row.id}:`,
              err instanceof Error ? err.message : err,
            );
            return null;
          },
        ),
      )
    : rows.map(() => null);

  const aggregates = aggregateSubscriptions(
    rows.map((r, i) => ({
      from: r.from,
      subject: r.subject,
      receivedAt: r.receivedDate ?? r.sentDate,
      rawHeaders: rawHeaders[i] ?? null,
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
        { waitUntil: input.waitUntil, outbound: { source: 'subscription', kind: 'new_thread' } },
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
