import { pgTable, varchar, timestamp, integer, boolean, jsonb, index } from 'drizzle-orm/pg-core';

/**
 * Everyone the workspace exchanged mail with, one row per lower-cased address.
 *
 * The outbound guard uses it to tell a reply or an existing relationship from
 * a **first contact**: a recipient with no `firstInboundAt` never wrote to the
 * workspace. That share, and how often first contacts write back
 * (`repliedAfterFirstContact`), are the core cold-email signals
 * (docs/plans/weldmail-outbound-abuse.md).
 *
 * Inbound side: a trigger on `mail_messages` (every insert that is not a SENT
 * copy) keeps `*Inbound*` current, so mail-inbound-worker, IMAP sync and
 * anything else that stores received mail are covered without code changes.
 * Outbound side: the guard's commit step, for every send path (CRM sequences
 * and WeldConnect store no SENT copy). The migration backfills both from
 * existing mail.
 */
export const mailCorrespondents = pgTable(
  'mail_correspondents',
  {
    email: varchar('email', { length: 320 }).primaryKey(),
    firstInboundAt: timestamp('first_inbound_at'),
    lastInboundAt: timestamp('last_inbound_at'),
    inboundCount: integer('inbound_count').notNull().default(0),
    firstOutboundAt: timestamp('first_outbound_at'),
    lastOutboundAt: timestamp('last_outbound_at'),
    outboundCount: integer('outbound_count').notNull().default(0),
    /** We wrote first and they answered later. */
    repliedAfterFirstContact: boolean('replied_after_first_contact').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [index('mail_correspondents_first_outbound_idx').on(table.firstOutboundAt)],
);

export type MailCorrespondent = typeof mailCorrespondents.$inferSelect;
export type NewMailCorrespondent = typeof mailCorrespondents.$inferInsert;

export const MAIL_SUPPRESSION_REASONS = ['hard_bounce', 'complaint', 'manual'] as const;
export type MailSuppressionReason = (typeof MAIL_SUPPRESSION_REASONS)[number];

/**
 * Recipients the workspace should not mail again: hard bounces and spam
 * complaints from Cloudflare Email Sending events, plus manual entries.
 * Cloudflare suppresses them per sending domain too; this table is what lets
 * the guard refuse a send to a complainer and the UI explain why.
 */
export const mailSuppressions = pgTable(
  'mail_suppressions',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    email: varchar('email', { length: 320 }).notNull().unique(),
    reason: varchar('reason', { length: 20 }).$type<MailSuppressionReason>().notNull(),
    /** Which sending address the bounce or complaint was about. */
    senderEmail: varchar('sender_email', { length: 320 }),
    /** `cloudflare_event` or `manual`. */
    source: varchar('source', { length: 40 }).notNull(),
    details: jsonb('details').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [index('mail_suppressions_reason_idx').on(table.reason)],
);

export type MailSuppression = typeof mailSuppressions.$inferSelect;
export type NewMailSuppression = typeof mailSuppressions.$inferInsert;
