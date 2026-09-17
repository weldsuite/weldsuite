/**
 * Personal mail subscriptions — the consumer-WeldMail twin of app-api's
 * `services/mail/subscriptions.ts`. Parsing, the unsubscribe mechanism
 * picker and backfill aggregation are shared via
 * `@weldsuite/email/list-unsubscribe`; this file only owns the personal DB
 * access and the personal send path.
 */

import { and, desc, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  aggregateSubscriptions,
  performUnsubscribe,
  type UnsubscribeOutcome,
} from '@weldsuite/email/list-unsubscribe';
import { personalSchema, type PersonalDatabase } from '../db';
import type { PersonalEntitlements } from '../lib/billing';
import { generateId } from '../lib/id';
import type { Env } from '../types';
import { sendAndPersist } from './mail-send';

const { personalMailSubscriptions, personalMailMessages } = personalSchema;

export type PersonalMailSubscriptionRow = typeof personalMailSubscriptions.$inferSelect;

const SCAN_WINDOW_DAYS = 180;
const SCAN_MESSAGE_LIMIT = 2000;
const RAW_HEADER_BYTES = 32_000;

export async function listSubscriptions(
  db: PersonalDatabase,
  input: { personalAccountId: string; accountId: string; status?: 'active' | 'unsubscribed' },
): Promise<PersonalMailSubscriptionRow[]> {
  const conditions = [
    eq(personalMailSubscriptions.personalAccountId, input.personalAccountId),
    eq(personalMailSubscriptions.accountId, input.accountId),
  ];
  if (input.status) conditions.push(eq(personalMailSubscriptions.status, input.status));
  return db
    .select()
    .from(personalMailSubscriptions)
    .where(and(...conditions))
    .orderBy(desc(personalMailSubscriptions.lastReceivedAt))
    .limit(1000);
}

/** Load a subscription the caller owns, or null. */
export async function getSubscription(
  db: PersonalDatabase,
  personalAccountId: string,
  id: string,
): Promise<PersonalMailSubscriptionRow | null> {
  const [row] = await db
    .select()
    .from(personalMailSubscriptions)
    .where(
      and(
        eq(personalMailSubscriptions.id, id),
        eq(personalMailSubscriptions.personalAccountId, personalAccountId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function scanSubscriptions(
  db: PersonalDatabase,
  personalAccountId: string,
  accountId: string,
): Promise<{ scanned: number; subscriptions: number }> {
  const since = new Date(Date.now() - SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      from: personalMailMessages.from,
      subject: personalMailMessages.subject,
      receivedDate: personalMailMessages.receivedDate,
      sentDate: personalMailMessages.sentDate,
      rawHeaders: sql<string | null>`substring(${personalMailMessages.rawMessage} from 1 for ${RAW_HEADER_BYTES})`,
    })
    .from(personalMailMessages)
    .where(
      and(
        eq(personalMailMessages.personalAccountId, personalAccountId),
        eq(personalMailMessages.accountId, accountId),
        eq(personalMailMessages.source, 'inbound'),
        eq(personalMailMessages.isSpam, false),
        isNull(personalMailMessages.deletedAt),
        isNotNull(personalMailMessages.rawMessage),
        gte(personalMailMessages.sentDate, since),
      ),
    )
    .orderBy(desc(personalMailMessages.sentDate))
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
      .insert(personalMailSubscriptions)
      .values({ id: generateId('pmsub'), personalAccountId, accountId, ...agg })
      .onConflictDoUpdate({
        target: [personalMailSubscriptions.accountId, personalMailSubscriptions.senderEmail],
        set: {
          messageCount: sql`GREATEST(${personalMailSubscriptions.messageCount}, ${agg.messageCount})`,
          firstReceivedAt: sql`LEAST(${personalMailSubscriptions.firstReceivedAt}, ${agg.firstReceivedAt.toISOString()}::timestamp)`,
          updatedAt: now,
        },
      });
  }

  return { scanned: rows.length, subscriptions: aggregates.length };
}

export async function unsubscribe(
  env: Env,
  db: PersonalDatabase,
  input: {
    personalAccountId: string;
    entitlements: PersonalEntitlements;
    subscription: PersonalMailSubscriptionRow;
  },
): Promise<{ subscription: PersonalMailSubscriptionRow; outcome: UnsubscribeOutcome }> {
  const { subscription } = input;
  const outcome = await performUnsubscribe(subscription, {
    fetch: (...args) => fetch(...args),
    sendMail: async ({ to, subject, body }) => {
      await sendAndPersist(env, db, input.personalAccountId, input.entitlements, {
        accountId: subscription.accountId,
        to: [to],
        subject,
        textBody: body,
      });
    },
  });

  const now = new Date();
  const [updated] = await db
    .update(personalMailSubscriptions)
    .set({
      status: 'unsubscribed',
      unsubscribeMethod: outcome.method,
      unsubscribedAt: now,
      updatedAt: now,
    })
    .where(eq(personalMailSubscriptions.id, subscription.id))
    .returning();

  return { subscription: updated ?? subscription, outcome };
}
