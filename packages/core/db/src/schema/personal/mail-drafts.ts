import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { personalMailAccounts } from './mail-accounts';

export const personalMailDrafts = pgTable(
  'personal_mail_drafts',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    personalAccountId: varchar('personal_account_id', { length: 30 }).notNull(),
    accountId: varchar('account_id', { length: 30 })
      .notNull()
      .references(() => personalMailAccounts.id),

    subject: varchar('subject', { length: 998 }),
    to: jsonb('to').$type<string[]>(),
    cc: jsonb('cc').$type<string[]>(),
    bcc: jsonb('bcc').$type<string[]>(),
    replyTo: jsonb('reply_to').$type<string[]>(),

    body: text('body'),
    htmlBody: text('html_body'),
    importance: varchar('importance', { length: 20 }).default('normal'),
    labels: jsonb('labels').$type<string[]>(),

    hasAttachments: boolean('has_attachments').default(false),
    attachmentCount: integer('attachment_count').default(0),
    attachmentIds: jsonb('attachment_ids').$type<string[]>(),

    inReplyTo: varchar('in_reply_to', { length: 500 }),
    originalMessageId: varchar('original_message_id', { length: 30 }),
    isReply: boolean('is_reply').default(false),
    isForward: boolean('is_forward').default(false),

    lastAutoSavedAt: timestamp('last_auto_saved_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => [
    index('personal_mail_drafts_personal_account_id_idx').on(table.personalAccountId),
    index('personal_mail_drafts_account_id_idx').on(table.accountId),
  ],
);

export type PersonalMailDraft = typeof personalMailDrafts.$inferSelect;
export type NewPersonalMailDraft = typeof personalMailDrafts.$inferInsert;
