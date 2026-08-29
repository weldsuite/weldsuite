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
import { personalMailAccounts } from './mail-accounts';

export const personalMailPriorityEnum = pgEnum('personal_mail_priority', [
  'highest',
  'high',
  'normal',
  'low',
  'lowest',
]);

export const personalMailSecurityStatusEnum = pgEnum('personal_mail_security_status', [
  'pass',
  'fail',
  'softfail',
  'neutral',
  'none',
  'temperror',
  'permerror',
]);

export interface PersonalMailEmailAddress {
  email: string;
  name?: string;
  type?: 'to' | 'cc' | 'bcc' | 'from' | 'reply-to';
}

export const personalMailMessages = pgTable(
  'personal_mail_messages',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    personalAccountId: varchar('personal_account_id', { length: 30 }).notNull(),
    accountId: varchar('account_id', { length: 30 })
      .notNull()
      .references(() => personalMailAccounts.id),

    messageId: varchar('message_id', { length: 500 }).notNull(),
    threadId: varchar('thread_id', { length: 255 }),

    from: jsonb('from').$type<PersonalMailEmailAddress>().notNull(),
    to: jsonb('to').$type<PersonalMailEmailAddress[]>().notNull(),
    cc: jsonb('cc').$type<PersonalMailEmailAddress[]>(),
    bcc: jsonb('bcc').$type<PersonalMailEmailAddress[]>(),
    replyTo: jsonb('reply_to').$type<PersonalMailEmailAddress>(),

    subject: varchar('subject', { length: 998 }),
    preview: varchar('preview', { length: 500 }),
    textBody: text('text_body'),
    htmlBody: text('html_body'),
    rawMessage: text('raw_message'),

    sentDate: timestamp('sent_date').notNull(),
    receivedDate: timestamp('received_date'),

    isRead: boolean('is_read').notNull().default(false),
    isStarred: boolean('is_starred').default(false),
    isDraft: boolean('is_draft').default(false),
    isSpam: boolean('is_spam').default(false),
    isTrash: boolean('is_trash').default(false),

    hasAttachments: boolean('has_attachments').notNull().default(false),
    attachmentCount: integer('attachment_count').default(0),

    inReplyTo: varchar('in_reply_to', { length: 500 }),
    references: jsonb('references').$type<string[]>(),
    isReply: boolean('is_reply').default(false),

    labels: jsonb('labels').$type<string[]>(),
    priority: personalMailPriorityEnum('priority').default('normal'),

    spfStatus: personalMailSecurityStatusEnum('spf_status'),
    dkimStatus: personalMailSecurityStatusEnum('dkim_status'),
    dmarcStatus: personalMailSecurityStatusEnum('dmarc_status'),

    sendStatus: varchar('send_status', { length: 20 }),
    sendProvider: varchar('send_provider', { length: 50 }),
    providerMessageId: varchar('provider_message_id', { length: 255 }),

    source: varchar('source', { length: 20 }),
    idempotencyKey: varchar('idempotency_key', { length: 64 }),

    headers: jsonb('headers').$type<Record<string, string>>(),
    sizeBytes: integer('size_bytes'),

    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => [
    index('personal_mail_messages_personal_account_id_idx').on(table.personalAccountId),
    index('personal_mail_messages_account_id_idx').on(table.accountId),
    index('personal_mail_messages_thread_id_idx').on(table.threadId),
    index('personal_mail_messages_sent_date_idx').on(table.sentDate),
    index('personal_mail_messages_is_read_idx').on(table.isRead),
    uniqueIndex('personal_mail_messages_account_idempotency_idx').on(
      table.accountId,
      table.idempotencyKey,
    ),
  ],
);

export type PersonalMailMessage = typeof personalMailMessages.$inferSelect;
export type NewPersonalMailMessage = typeof personalMailMessages.$inferInsert;
