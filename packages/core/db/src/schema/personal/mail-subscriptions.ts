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
import { personalMailAccounts } from './mail-accounts';

export type PersonalMailSubscriptionStatus = 'active' | 'unsubscribed';
export type PersonalMailUnsubscribeMethod = 'one_click' | 'mailto' | 'link';

/**
 * Personal twin of the tenant `mail_subscriptions` table: mailing lists a
 * consumer WeldMail mailbox receives, one row per sender address. Upserted
 * by mail-inbound-worker, backfilled by personal-api's scan endpoint.
 */
export const personalMailSubscriptions = pgTable(
  'personal_mail_subscriptions',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    personalAccountId: varchar('personal_account_id', { length: 30 }).notNull(),
    accountId: varchar('account_id', { length: 30 })
      .notNull()
      .references(() => personalMailAccounts.id),

    senderEmail: varchar('sender_email', { length: 320 }).notNull(),
    senderName: varchar('sender_name', { length: 255 }),
    senderDomain: varchar('sender_domain', { length: 255 }),
    listId: varchar('list_id', { length: 500 }),

    unsubscribeUrl: text('unsubscribe_url'),
    unsubscribeMailto: text('unsubscribe_mailto'),
    oneClick: boolean('one_click').notNull().default(false),

    messageCount: integer('message_count').notNull().default(0),
    lastSubject: varchar('last_subject', { length: 998 }),
    firstReceivedAt: timestamp('first_received_at').notNull().defaultNow(),
    lastReceivedAt: timestamp('last_received_at').notNull().defaultNow(),

    status: varchar('status', { length: 20 }).$type<PersonalMailSubscriptionStatus>().notNull().default('active'),
    unsubscribeMethod: varchar('unsubscribe_method', { length: 20 }).$type<PersonalMailUnsubscribeMethod>(),
    unsubscribedAt: timestamp('unsubscribed_at'),

    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('personal_mail_subscriptions_account_sender_uidx').on(table.accountId, table.senderEmail),
    index('personal_mail_subscriptions_personal_account_id_idx').on(table.personalAccountId),
  ],
);

export type PersonalMailSubscription = typeof personalMailSubscriptions.$inferSelect;
export type NewPersonalMailSubscription = typeof personalMailSubscriptions.$inferInsert;
