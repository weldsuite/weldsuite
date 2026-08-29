import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { personalMailMessages } from './mail-messages';

export const personalMailAttachments = pgTable(
  'personal_mail_attachments',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    personalAccountId: varchar('personal_account_id', { length: 30 }).notNull(),
    messageId: varchar('message_id', { length: 30 })
      .notNull()
      .references(() => personalMailMessages.id),

    fileName: varchar('file_name', { length: 500 }).notNull(),
    contentType: varchar('content_type', { length: 255 }),
    size: integer('size').notNull().default(0),

    isInline: boolean('is_inline').default(false),
    contentId: varchar('content_id', { length: 255 }),
    contentDisposition: varchar('content_disposition', { length: 100 }),

    checksum: varchar('checksum', { length: 64 }),
    downloadUrl: text('download_url'),
    storagePath: varchar('storage_path', { length: 1000 }),

    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => [
    index('personal_mail_attachments_personal_account_id_idx').on(table.personalAccountId),
    index('personal_mail_attachments_message_id_idx').on(table.messageId),
  ],
);

export type PersonalMailAttachment = typeof personalMailAttachments.$inferSelect;
export type NewPersonalMailAttachment = typeof personalMailAttachments.$inferInsert;
