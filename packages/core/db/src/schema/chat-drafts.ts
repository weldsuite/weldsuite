import { pgTable, varchar, text, jsonb, timestamp, index, unique } from 'drizzle-orm/pg-core';
import type { ChatAttachment } from './chat-messages';

export const chatDrafts = pgTable('chat_drafts', {
  id: varchar('id', { length: 30 }).primaryKey(),
  workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
  userId: varchar('user_id', { length: 255 }).notNull(),
  channelId: varchar('channel_id', { length: 30 }),
  threadParentMessageId: varchar('thread_parent_message_id', { length: 30 }),
  content: text('content').notNull(),
  attachments: jsonb('attachments').$type<ChatAttachment[]>(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => [
  index('chat_drafts_user_workspace_idx').on(t.userId, t.workspaceId),
  // NULLS NOT DISTINCT so channel-level drafts (NULL thread parent) and global drafts
  // (NULL channel) collide on (userId, channelId, threadParentMessageId) in ON CONFLICT.
  unique('chat_drafts_location_unique')
    .on(t.userId, t.channelId, t.threadParentMessageId)
    .nullsNotDistinct(),
]);

export type ChatDraft = typeof chatDrafts.$inferSelect;
export type NewChatDraft = typeof chatDrafts.$inferInsert;
