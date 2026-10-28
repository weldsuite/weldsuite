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
import type { MailEmailAddress } from '@weldsuite/db/schema/mail-messages';
import type { Env } from '../../types';
import { generateId } from '@weldsuite/worker-kit/id';
import { sendAndPersist } from '@weldsuite/mail-domain/send';
import { getRawMimeHeader } from '@weldsuite/mail-domain/store/bodies';
import type { MailboxStore, MailStoreMode } from '@weldsuite/mail-domain/store/types';

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

/**
 * Through `store.listSubscriptions` when one is supplied (design task D1),
 * else the direct-Postgres rows below, unchanged.
 */
export function listSubscriptions(
  db: Database,
  input: { accountId: string; status?: 'active' | 'unsubscribed' },
  store?: MailboxStore,
): Promise<MailSubscriptionRow[]> {
  if (store) return store.listSubscriptions({ status: input.status });
  const conditions = [eq(mailSubscriptions.accountId, input.accountId)];
  if (input.status) conditions.push(eq(mailSubscriptions.status, input.status));
  return db
    .select()
    .from(mailSubscriptions)
    .where(and(...conditions))
    .orderBy(desc(mailSubscriptions.lastReceivedAt))
    .limit(1000);
}

/**
 * Find a subscription by id alone, not yet knowing its account — the route's
 * way of answering "does this id exist, and which account does it belong to"
 * before it can check access. `MailboxStore`/`WorkspaceMailStore` have no
 * cross-account "locate a subscription" op (design task D1's own scope: list/
 * scan/unsubscribe, all already account-scoped by the time they run), so this
 * stays the direct-Postgres row in every mode — a store API gap, not a bug:
 * once the id resolves to an account, `unsubscribe` below writes through that
 * account's store.
 */
export async function getSubscription(db: Database, id: string): Promise<MailSubscriptionRow | null> {
  const [row] = await db.select().from(mailSubscriptions).where(eq(mailSubscriptions.id, id)).limit(1);
  return row ?? null;
}

/** One scan candidate, whichever source it came from. */
interface ScanCandidate {
  id: string;
  from: MailEmailAddress;
  subject: string | null;
  receivedAt: Date;
}

/** Through `store.rawSources` when one is supplied — ported verbatim from this function's own query (`store/postgres/subscriptions.ts`) — else the direct-Postgres rows below, unchanged. */
async function loadScanCandidates(
  db: Database,
  store: MailboxStore | undefined,
  accountId: string,
  since: Date,
  limit: number,
): Promise<ScanCandidate[]> {
  if (store) {
    const rows = await store.rawSources({ since: since.getTime(), limit });
    return rows.map((r) => ({ id: r.id, from: r.from, subject: r.subject, receivedAt: new Date(r.receivedAt) }));
  }
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
    .limit(limit);
  return rows.map((r) => ({ id: r.id, from: r.from, subject: r.subject, receivedAt: r.receivedDate ?? r.sentDate }));
}

/**
 * Rebuild subscription rows for an account from the raw headers of its
 * recently received messages. Unsubscribe state on existing rows is kept.
 *
 * `env` only needs `MAIL_STORAGE`, the EU mail bucket: without it (or without a
 * raw object for a given message — e.g. it predates this fix, or the inbound
 * R2 write failed) that message simply contributes nothing, same as
 * `aggregateSubscriptions` already does for a null `rawHeaders`.
 *
 * The candidate-message read and the upsert both go through the store when
 * one is supplied (design task D1); without one, the direct-Postgres path
 * below is unchanged.
 */
export async function scanSubscriptions(
  env: { MAIL_STORAGE?: R2Bucket },
  db: Database,
  input: { workspaceId: string; accountId: string },
  store?: MailboxStore,
): Promise<{ scanned: number; subscriptions: number }> {
  const { workspaceId, accountId } = input;
  const since = new Date(Date.now() - SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const candidates = await loadScanCandidates(db, store, accountId, since, SCAN_MESSAGE_LIMIT);

  const rawHeaders = env.MAIL_STORAGE
    ? await mapWithConcurrency(candidates, R2_READ_CONCURRENCY, (row) =>
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
    : candidates.map(() => null);

  const aggregates = aggregateSubscriptions(
    candidates.map((r, i) => ({
      from: r.from,
      subject: r.subject,
      receivedAt: r.receivedAt,
      rawHeaders: rawHeaders[i] ?? null,
    })),
  );

  const now = new Date();
  if (store) {
    if (aggregates.length > 0) await store.apply({ kind: 'subscription.upsert', values: aggregates }, now.getTime());
  } else {
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
  }

  return { scanned: candidates.length, subscriptions: aggregates.length };
}

/**
 * `sendMail` (the `mailto:` unsubscribe mechanism) goes through `send.ts`'s
 * own store wiring when a store is supplied, same as any other compose; the
 * status write below goes through the store's `subscription.status` op.
 * Without a store, both are the direct-Postgres path, unchanged.
 */
export async function unsubscribe(
  env: Env,
  db: Database,
  input: {
    orgId: string;
    userId: string;
    subscription: MailSubscriptionRow;
    waitUntil?: ExecutionContext['waitUntil'];
  },
  store?: MailboxStore,
  mailStoreMode?: MailStoreMode,
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
        { waitUntil: input.waitUntil, outbound: { source: 'subscription', kind: 'new_thread' }, store, mailStoreMode },
      );
    },
  });

  const now = new Date();
  if (store) {
    await store.apply(
      {
        kind: 'subscription.status',
        id: subscription.id,
        patch: { status: 'unsubscribed', method: outcome.method, at: now.getTime(), by: input.userId },
      },
      now.getTime(),
    );
    const updated = await store.getSubscription(subscription.id);
    return { subscription: updated ?? subscription, outcome };
  }

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
