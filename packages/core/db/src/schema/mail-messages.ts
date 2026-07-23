import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  pgEnum,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { mailAccounts } from './mail-accounts';

// Email priority enum
export const mailPriorityEnum = pgEnum('mail_priority', [
  'highest',
  'high',
  'normal',
  'low',
  'lowest',
]);

// Security status enum
export const mailSecurityStatusEnum = pgEnum('mail_security_status', [
  'pass',
  'fail',
  'softfail',
  'neutral',
  'none',
  'temperror',
  'permerror',
]);

// Email address interface (stored as JSONB)
export interface MailEmailAddress {
  email: string;
  name?: string;
  type?: 'to' | 'cc' | 'bcc' | 'from' | 'reply-to';
}

// Clicked link interface (stored as JSONB)
export interface MailClickedLink {
  url: string;
  clickedAt: string;
  clickCount: number;
}

// Mail Messages table
export const mailMessages = pgTable('mail_messages', {
  id: varchar('id', { length: 30 }).primaryKey(),
  accountId: varchar('account_id', { length: 30 }).notNull().references(() => mailAccounts.id),

  // Message ID (RFC 5322)
  messageId: varchar('message_id', { length: 500 }).notNull(),
  threadId: varchar('thread_id', { length: 255 }),
  conversationId: varchar('conversation_id', { length: 255 }),

  // Headers
  from: jsonb('from').$type<MailEmailAddress>().notNull(),
  to: jsonb('to').$type<MailEmailAddress[]>().notNull(),
  cc: jsonb('cc').$type<MailEmailAddress[]>(),
  bcc: jsonb('bcc').$type<MailEmailAddress[]>(),
  replyTo: jsonb('reply_to').$type<MailEmailAddress>(),

  // Content
  subject: varchar('subject', { length: 998 }), // RFC 5322 limit
  preview: varchar('preview', { length: 500 }), // First ~200 chars of body
  textBody: text('text_body'),
  htmlBody: text('html_body'),
  rawMessage: text('raw_message'), // Optional: store raw email

  // Dates
  sentDate: timestamp('sent_date').notNull(),
  receivedDate: timestamp('received_date'),

  // Flags
  isRead: boolean('is_read').notNull().default(false),
  isStarred: boolean('is_starred').default(false),
  isFlagged: boolean('is_flagged').default(false),
  isImportant: boolean('is_important').default(false),
  isDraft: boolean('is_draft').default(false),
  isSpam: boolean('is_spam').default(false),
  isTrash: boolean('is_trash').default(false),

  // Attachments
  hasAttachments: boolean('has_attachments').notNull().default(false),
  attachmentCount: integer('attachment_count').default(0),

  // Threading
  inReplyTo: varchar('in_reply_to', { length: 500 }),
  references: jsonb('references').$type<string[]>(),
  isReply: boolean('is_reply').default(false),
  isForwarded: boolean('is_forwarded').default(false),

  // Labels & Categories
  labels: jsonb('labels').$type<string[]>(),
  categories: jsonb('categories').$type<string[]>(),

  // Priority
  priority: mailPriorityEnum('priority').default('normal'),

  // Tracking
  readReceipt: boolean('read_receipt').default(false),
  deliveryReceipt: boolean('delivery_receipt').default(false),
  openedAt: timestamp('opened_at'),
  clickedLinks: jsonb('clicked_links').$type<MailClickedLink[]>(),

  // Security
  isEncrypted: boolean('is_encrypted').default(false),
  isSigned: boolean('is_signed').default(false),
  spfStatus: mailSecurityStatusEnum('spf_status'),
  dkimStatus: mailSecurityStatusEnum('dkim_status'),
  dmarcStatus: mailSecurityStatusEnum('dmarc_status'),

  // Scheduling
  scheduledFor: timestamp('scheduled_for'),
  sendStatus: varchar('send_status', { length: 20 }), // 'scheduled' | 'sent' | 'cancelled' | 'failed'
  triggerRunId: varchar('trigger_run_id', { length: 255 }),

  // Send state — extracted from custom_fields blob (see docs/custom-fields-blob-extraction.md)
  sendProvider: varchar('send_provider', { length: 50 }), // e.g. 'mailgun' | 'postal' | 'mailcow'
  providerMessageId: varchar('provider_message_id', { length: 255 }),
  mailgunMessageId: varchar('mailgun_message_id', { length: 255 }),

  // Snooze state — extracted from custom_fields blob (see apps/workers/app-api/src/services/mail/snooze.ts)
  snoozedUntil: timestamp('snoozed_until'),
  snoozedAt: timestamp('snoozed_at'),
  unsnoozedAt: timestamp('unsnoozed_at'),
  unsnoozedEarly: boolean('unsnoozed_early'),
  resnoozedAt: timestamp('resnoozed_at'),
  unsnoozeTriggerRunId: varchar('unsnooze_trigger_run_id', { length: 255 }),

  // Source
  source: varchar('source', { length: 20 }), // 'inbox' | 'sent' | 'composed'

  // Client-generated key that makes a compose/send idempotent: a replayed send
  // (offline queue flush, or retry after a dropped response) with the same key
  // returns the existing sent message instead of sending again. Null for
  // received/synced messages. Uniqueness is enforced per account below; Postgres
  // treats NULLs as distinct, so only real keys participate in dedup.
  idempotencyKey: varchar('idempotency_key', { length: 64 }),

  // External sync (Mailcow)
  externalMessageId: varchar('external_message_id', { length: 255 }),
  mailcowMessageId: varchar('mailcow_message_id', { length: 255 }),

  // Metadata
  headers: jsonb('headers').$type<Record<string, string>>(),
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>(),

  // Size
  sizeBytes: integer('size_bytes'),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('mail_messages_account_id_idx').on(table.accountId),
  // folderId index removed — labels GIN index is used instead
  index('mail_messages_message_id_idx').on(table.messageId),
  index('mail_messages_thread_id_idx').on(table.threadId),
  index('mail_messages_is_read_idx').on(table.isRead),
  // isStarred index removed — STARRED label in GIN index is used instead
  index('mail_messages_sent_date_idx').on(table.sentDate),
  index('mail_messages_external_message_id_idx').on(table.externalMessageId),
  index('mail_messages_labels_gin').using('gin', table.labels),
  // Auto-unsnooze sweep queries this.
  index('mail_messages_snoozed_until_idx').on(table.snoozedUntil),
  // Scheduled-send sweep queries this.
  index('mail_messages_scheduled_for_idx').on(table.scheduledFor),
  // Dedup guard for idempotent sends (NULL keys are distinct in Postgres, so
  // this only constrains real client-provided keys).
  uniqueIndex('mail_messages_account_idempotency_idx').on(table.accountId, table.idempotencyKey),
]);

export type MailMessage = typeof mailMessages.$inferSelect;
export type NewMailMessage = typeof mailMessages.$inferInsert;
