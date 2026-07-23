import { pgTable, varchar, boolean, timestamp, jsonb, integer, index } from 'drizzle-orm/pg-core';

// WeldAgent conversations - persistent chat threads per user
export const weldagentConversations = pgTable('weldagent_conversations', {
  id: varchar('id', { length: 30 }).primaryKey(),
  userId: varchar('user_id', { length: 255 }).notNull(),

  // Thread info
  name: varchar('name', { length: 255 }).notNull().default('New Conversation'),
  moduleKey: varchar('module_key', { length: 50 }), // 'general', 'crm', 'projects', etc.

  // State
  isPinned: boolean('is_pinned').notNull().default(false),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  messageCount: integer('message_count').notNull().default(0),

  // Extra context (entityContext, etc.)
  metadata: jsonb('metadata').$type<{
    entityContext?: {
      type: string;
      id: string;
      title?: string;
      data?: Record<string, unknown>;
    };
    [key: string]: unknown;
  }>(),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }), // Soft delete
}, (table) => [
  index('weldagent_conversations_user_idx').on(table.userId),
  index('weldagent_conversations_last_message_idx').on(table.lastMessageAt),
]);

export type WeldAgentConversation = typeof weldagentConversations.$inferSelect;
export type NewWeldAgentConversation = typeof weldagentConversations.$inferInsert;
