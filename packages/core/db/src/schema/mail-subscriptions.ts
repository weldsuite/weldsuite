import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { mailAccounts } from './mail-accounts';

export type MailSubscriptionStatus = 'active' | 'unsubscribed';
export type MailUnsubscribeMethod = 'one_click' | 'mailto' | 'link';

/**
 * Mailing lists / newsletters an account receives, one row per sender
 * address. Upserted by mail-inbound-worker whenever a message carries a
 * `List-Unsubscribe` header, and backfilled from stored raw messages by
 * `POST /api/mail-subscriptions/scan`.
 */
export const mailSubscriptions = pgTable('mail_subscriptions', {
  id: varchar('id', { length: 30 }).primaryKey(),
  accountId: varchar('account_id', { length: 30 }).notNull().references(() => mailAccounts.id),

  // Sender (lower-cased address is the identity of a subscription)
  senderEmail: varchar('sender_email', { length: 320 }).notNull(),
  senderName: varchar('sender_name', { length: 255 }),
  senderDomain: varchar('sender_domain', { length: 255 }),
  listId: varchar('list_id', { length: 500 }),

  // Unsubscribe targets from the List-Unsubscribe header
  unsubscribeUrl: text('unsubscribe_url'), // https only
  unsubscribeMailto: text('unsubscribe_mailto'), // full mailto: URI
  oneClick: boolean('one_click').notNull().default(false), // RFC 8058 List-Unsubscribe-Post

  // Activity
  messageCount: integer('message_count').notNull().default(0),
  lastSubject: varchar('last_subject', { length: 998 }),
  firstReceivedAt: timestamp('first_received_at').notNull().defaultNow(),
  lastReceivedAt: timestamp('last_received_at').notNull().defaultNow(),

  // Unsubscribe state
  status: varchar('status', { length: 20 }).$type<MailSubscriptionStatus>().notNull().default('active'),
  unsubscribeMethod: varchar('unsubscribe_method', { length: 20 }).$type<MailUnsubscribeMethod>(),
  unsubscribedAt: timestamp('unsubscribed_at'),
  unsubscribedBy: varchar('unsubscribed_by', { length: 255 }),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('mail_subscriptions_account_sender_uidx').on(table.accountId, table.senderEmail),
  index('mail_subscriptions_account_last_received_idx').on(table.accountId, table.lastReceivedAt),
]);

export type MailSubscription = typeof mailSubscriptions.$inferSelect;
export type NewMailSubscription = typeof mailSubscriptions.$inferInsert;
