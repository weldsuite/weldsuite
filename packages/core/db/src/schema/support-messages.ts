import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';
import { supportChannels } from './support-channels';

export type SupportAuthorType = 'customer' | 'support';

export interface SupportAttachment {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
}

export const supportMessages = pgTable('support_messages', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Channel reference
  channelId: varchar('channel_id', { length: 30 }).notNull().references(() => supportChannels.id),

  // Author
  authorId: varchar('author_id', { length: 255 }).notNull(),
  authorName: varchar('author_name', { length: 255 }).notNull(),
  authorAvatar: varchar('author_avatar', { length: 500 }),
  authorType: varchar('author_type', { length: 20 }).notNull().default('customer'),

  // Content
  content: text('content').notNull(),
  htmlContent: text('html_content'),

  // Edit tracking
  isEdited: boolean('is_edited').notNull().default(false),

  // Attachments
  attachments: jsonb('attachments').$type<SupportAttachment[]>(),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('support_messages_channel_created_idx').on(table.channelId, table.createdAt),
  index('support_messages_channel_idx').on(table.channelId),
  index('support_messages_author_idx').on(table.authorId),
]);

export type SupportMessage = typeof supportMessages.$inferSelect;
export type NewSupportMessage = typeof supportMessages.$inferInsert;
