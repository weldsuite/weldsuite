import { pgTable, varchar, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

// Tool invocation type for message storage
export interface StoredToolInvocation {
  toolName: string;
  state: 'call' | 'result' | 'error';
  args?: unknown;
  result?: unknown;
}

// WeldAgent messages - individual chat messages within a conversation
export const weldagentMessages = pgTable('weldagent_messages', {
  id: varchar('id', { length: 30 }).primaryKey(),
  conversationId: varchar('conversation_id', { length: 30 }).notNull(),

  // Message content
  role: varchar('role', { length: 20 }).notNull(), // 'user' | 'assistant' | 'system'
  content: text('content').notNull(),

  // Tool invocations (for assistant messages)
  toolInvocations: jsonb('tool_invocations').$type<StoredToolInvocation[]>(),

  // Form state (for inline form persistence)
  formState: jsonb('form_state').$type<{
    formId?: string;
    formType?: string;
    values?: Record<string, unknown>;
    submitted?: boolean;
  }>(),

  // Extra data
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }), // Soft delete
}, (table) => [
  index('weldagent_messages_conversation_idx').on(table.conversationId),
  index('weldagent_messages_created_at_idx').on(table.createdAt),
]);

export type WeldAgentMessage = typeof weldagentMessages.$inferSelect;
export type NewWeldAgentMessage = typeof weldagentMessages.$inferInsert;
