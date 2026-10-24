import { sql } from 'drizzle-orm';
import { pgTable, varchar, boolean, timestamp, jsonb, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';

export interface WeldAgentManagedSessionState {
  /** `sesn_…` id. */
  sessionId: string;
  /** Anthropic agent object id + version the session was created from. */
  agentObjectId: string;
  agentVersion: number;
  /** Hash of the session's tool list; a different list starts a new session. */
  toolsHash: string;
  /** Hash of the system context last given to the session. */
  systemHash: string;
  /**
   * How many history messages (user + assistant rows, oldest first) the
   * session has already seen. An absolute count, so a turn that loads only the
   * recent part of a long chat still knows which messages are new.
   */
  syncedMessages: number;
  /** Session list cost (USD) already charged to the credit wallet. */
  chargedUsd: number;
}

// WeldAgent conversations - persistent chat threads per user
export const weldagentConversations = pgTable('weldagent_conversations', {
  id: varchar('id', { length: 30 }).primaryKey(),
  userId: varchar('user_id', { length: 255 }).notNull(),

  // Thread info
  name: varchar('name', { length: 255 }).notNull().default('New Conversation'),
  moduleKey: varchar('module_key', { length: 50 }), // 'general', 'crm', 'projects', etc.

  /** When set, chat is bound to a workspace agent (tools + instructions). */
  agentId: varchar('agent_id', { length: 30 }),

  /**
   * The person's one continuous chat with `agentId` (at most one per user and
   * agent). Other rows are older threads, kept but no longer shown.
   */
  isMain: boolean('is_main').notNull().default(false),

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
    /**
     * The Claude Managed Agents session that carries this agent conversation
     * (one per conversation, replaced when the agent's config changes).
     */
    managedSession?: WeldAgentManagedSessionState;
    [key: string]: unknown;
  }>(),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }), // Soft delete
}, (table) => [
  index('weldagent_conversations_user_idx').on(table.userId),
  index('weldagent_conversations_last_message_idx').on(table.lastMessageAt),
  uniqueIndex('weldagent_conversations_main_idx')
    .on(table.userId, table.agentId)
    .where(sql`${table.isMain} = true AND ${table.deletedAt} IS NULL`),
]);

export type WeldAgentConversation = typeof weldagentConversations.$inferSelect;
export type NewWeldAgentConversation = typeof weldagentConversations.$inferInsert;
