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
import { mailAccounts } from './mail-accounts';

// Mail Drafts table
export const mailDrafts = pgTable('mail_drafts', {
  id: varchar('id', { length: 30 }).primaryKey(),
  accountId: varchar('account_id', { length: 30 }).notNull().references(() => mailAccounts.id),

  // Recipients
  subject: varchar('subject', { length: 998 }),
  to: jsonb('to').$type<string[]>(),
  cc: jsonb('cc').$type<string[]>(),
  bcc: jsonb('bcc').$type<string[]>(),
  replyTo: jsonb('reply_to').$type<string[]>(),

  // Content
  body: text('body'), // Plain text
  htmlBody: text('html_body'),

  // Importance/Priority
  importance: varchar('importance', { length: 20 }).default('normal'), // 'low' | 'normal' | 'high'

  // Labels
  labels: jsonb('labels').$type<string[]>(),

  // Attachments (reference to uploaded files, not yet attached to a message)
  hasAttachments: boolean('has_attachments').default(false),
  attachmentCount: integer('attachment_count').default(0),
  attachmentIds: jsonb('attachment_ids').$type<string[]>(), // Pending upload IDs

  // Reply/Forward context
  inReplyTo: varchar('in_reply_to', { length: 500 }), // Original message ID for replies
  originalMessageId: varchar('original_message_id', { length: 30 }), // Reference to original message
  isReply: boolean('is_reply').default(false),
  isForward: boolean('is_forward').default(false),

  // Auto-save tracking
  lastAutoSavedAt: timestamp('last_auto_saved_at'),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('mail_drafts_account_id_idx').on(table.accountId),
  index('mail_drafts_updated_at_idx').on(table.updatedAt),
]);

export type MailDraft = typeof mailDrafts.$inferSelect;
export type NewMailDraft = typeof mailDrafts.$inferInsert;
