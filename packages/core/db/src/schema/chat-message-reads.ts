import {
  pgTable,
  varchar,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { chatMessages } from './chat-messages';
import { chatChannels } from './chat-channels';

export const chatMessageReads = pgTable('chat_message_reads', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  // References
  messageId: varchar('message_id', { length: 30 }).notNull().references(() => chatMessages.id),
  channelId: varchar('channel_id', { length: 30 }).notNull().references(() => chatChannels.id),
  userId: varchar('user_id', { length: 255 }).notNull(),

  // When the message was read
  readAt: timestamp('read_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('chat_message_reads_message_user_idx').on(table.messageId, table.userId),
  index('chat_message_reads_channel_user_idx').on(table.channelId, table.userId),
  index('chat_message_reads_message_idx').on(table.messageId),
]);

export type ChatMessageRead = typeof chatMessageReads.$inferSelect;
export type NewChatMessageRead = typeof chatMessageReads.$inferInsert;
