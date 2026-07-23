import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { projects } from './projects';

export const projectMessages = pgTable('project_messages', {
  // BaseEntity fields
  id: varchar('id', { length: 255 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Reference - conversationId is typically the projectId for project messages
  projectId: varchar('project_id', { length: 255 }).references(() => projects.id),
  conversationId: varchar('conversation_id', { length: 255 }).notNull(),

  // Sender
  senderId: varchar('sender_id', { length: 255 }).notNull(),

  // Message content
  message: text('message').notNull(),
  messageType: varchar('message_type', { length: 50 }).notNull().default('text'),

  // Reply
  replyToId: varchar('reply_to_id', { length: 255 }),

  // Attachments
  attachments: jsonb('attachments').$type<Record<string, unknown>>(),

  // Edit tracking
  editedAt: timestamp('edited_at'),

  // Read status
  isRead: boolean('is_read').notNull().default(false),
  readBy: jsonb('read_by').$type<string[]>(),

  // Reactions (emoji -> userIds)
  reactions: jsonb('reactions').$type<Record<string, string[]>>(),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('project_messages_project_idx').on(table.projectId),
  index('project_messages_conversation_idx').on(table.conversationId),
  index('project_messages_sender_idx').on(table.senderId),
  index('project_messages_created_idx').on(table.createdAt),
]);

export type ProjectMessage = typeof projectMessages.$inferSelect;
export type NewProjectMessage = typeof projectMessages.$inferInsert;
