import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { mailMessages } from './mail-messages';

// Mail Attachments table
export const mailAttachments = pgTable('mail_attachments', {
  id: varchar('id', { length: 30 }).primaryKey(),
  messageId: varchar('message_id', { length: 30 }).notNull().references(() => mailMessages.id),

  // File Information
  fileName: varchar('file_name', { length: 500 }).notNull(),
  contentType: varchar('content_type', { length: 255 }),
  size: integer('size').notNull().default(0), // bytes

  // Inline attachment info (for embedded images)
  isInline: boolean('is_inline').default(false),
  contentId: varchar('content_id', { length: 255 }), // CID for inline attachments
  contentDisposition: varchar('content_disposition', { length: 100 }),

  // Storage
  checksum: varchar('checksum', { length: 64 }), // SHA-256 hash
  downloadUrl: text('download_url'),
  storagePath: varchar('storage_path', { length: 1000 }), // Path in storage bucket

  // External sync
  externalAttachmentId: varchar('external_attachment_id', { length: 255 }),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('mail_attachments_message_id_idx').on(table.messageId),
  index('mail_attachments_content_type_idx').on(table.contentType),
  index('mail_attachments_is_inline_idx').on(table.isInline),
]);

export type MailAttachment = typeof mailAttachments.$inferSelect;
export type NewMailAttachment = typeof mailAttachments.$inferInsert;
