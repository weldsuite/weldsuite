import {
  pgTable,
  varchar,
  timestamp,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { chatMessages } from './chat-messages';
import { chatChannels } from './chat-channels';

export const chatBookmarks = pgTable('chat_bookmarks', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  // References
  userId: varchar('user_id', { length: 255 }).notNull(),
  messageId: varchar('message_id', { length: 30 }).notNull().references(() => chatMessages.id),
  channelId: varchar('channel_id', { length: 30 }).notNull().references(() => chatChannels.id),

  // Personal note
  note: text('note'),
}, (table) => [
  uniqueIndex('chat_bookmarks_unique_idx').on(table.userId, table.messageId),
  index('chat_bookmarks_user_idx').on(table.userId),
]);

export type ChatBookmark = typeof chatBookmarks.$inferSelect;
export type NewChatBookmark = typeof chatBookmarks.$inferInsert;
