import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  integer,
  jsonb,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * WeldDesk v2 — AI agent (Fin-equivalent) settings, resolution tracking,
 * and knowledge-embedding bookkeeping.
 *
 * The answer pipeline lives in apps/agent-worker (all Anthropic calls +
 * credit charging). Knowledge source in v1 = published help-center articles
 * (helpdesk_articles); vectors live in Cloudflare Vectorize, this DB only
 * tracks chunk metadata for sync/invalidation.
 */

export interface DeskAiHandoverConfig {
  /** Send expectation-setting messages on handover. */
  sendExpectations: boolean;
  /** Collect email/details before handover when the customer is anonymous. */
  collectContactInfo: boolean;
  /** Default team to route to when no workflow handover path applies. */
  fallbackTeamId?: string;
}

export const deskAiSettings = pgTable(
  'desk_ai_settings',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    /** One row per tenant. */
    scope: varchar('scope', { length: 10 }).notNull().default('default'),

    enabled: boolean('enabled').notNull().default(false),
    /** Display name of the agent in the Messenger, e.g. "Fin"-equivalent. */
    agentName: varchar('agent_name', { length: 100 }).notNull().default('AI Agent'),
    agentAvatarUrl: varchar('agent_avatar_url', { length: 500 }),
    /** Identity / tone system-prompt addition (soft guidance). */
    toneInstructions: text('tone_instructions'),

    handover: jsonb('handover').$type<DeskAiHandoverConfig>(),

    /**
     * Billing: whether assumed resolutions (24h customer silence after the
     * last AI answer) are billable, or only confirmed ones.
     */
    billAssumedResolutions: boolean('bill_assumed_resolutions').notNull().default(true),
    /** Hours of customer silence before an answered conversation counts as assumed-resolved. */
    assumedResolutionHours: integer('assumed_resolution_hours').notNull().default(24),
    /** Auto-close the conversation when a resolution is reached. */
    closeOnResolution: boolean('close_on_resolution').notNull().default(true),
  },
  (table) => [uniqueIndex('desk_ai_settings_scope_idx').on(table.scope)],
);

/**
 * Resolution state machine, one row per conversation the AI participated in:
 *   involved → answered → (confirmed | assumed | escalated | abandoned)
 * Max ONE billable outcome per conversation; creditChargeId is the
 * idempotency key for the @weldsuite/credits charge.
 */
export type DeskAiResolutionState =
  | 'involved' // AI engaged but has not answered yet (e.g. clarifying)
  | 'answered' // at least one real answer delivered, outcome pending
  | 'confirmed' // customer positively confirmed after the last answer
  | 'assumed' // customer silent for assumedResolutionHours after the last answer
  | 'escalated' // routed to a human (request, rules, or pipeline failure)
  | 'abandoned'; // clarifying question then silence — NOT an outcome

export const deskAiResolutions = pgTable(
  'desk_ai_resolutions',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    conversationId: varchar('conversation_id', { length: 30 }).notNull(),
    state: varchar('state', { length: 10 }).$type<DeskAiResolutionState>().notNull().default('involved'),
    answerCount: integer('answer_count').notNull().default(0),
    clarificationCount: integer('clarification_count').notNull().default(0),
    lastAnswerAt: timestamp('last_answer_at'),
    /** When a terminal state was reached. */
    outcomeAt: timestamp('outcome_at'),
    /** Why the conversation escalated, when state=escalated. */
    escalationReason: varchar('escalation_reason', { length: 30 }).$type<
      'human_request' | 'cant_answer' | 'frustration' | 'loop' | 'safety' | 'validation_failed'
    >(),
    /** Idempotency key of the credits charge; null = not (yet) billed. */
    creditChargeId: varchar('credit_charge_id', { length: 60 }),
    /** Article ids used as sources across this conversation's answers. */
    contentSources: jsonb('content_sources').$type<string[]>(),
  },
  (table) => [
    uniqueIndex('desk_ai_resolutions_conversation_idx').on(table.conversationId),
    // The assumed-resolution sweep scans answered conversations by lastAnswerAt.
    index('desk_ai_resolutions_state_answer_idx').on(table.state, table.lastAnswerAt),
  ],
);

/**
 * Chunk bookkeeping for article embeddings. The vectors themselves live in
 * Cloudflare Vectorize (vector id = this row's id; metadata carries
 * workspaceId + articleId for tenant-scoped filtering). contentHash lets
 * the ingest job skip unchanged chunks on article updates.
 */
export const deskArticleEmbeddings = pgTable(
  'desk_article_embeddings',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    articleId: varchar('article_id', { length: 30 }).notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    /** Plain-text chunk content (also stored as Vectorize metadata for retrieval). */
    content: text('content').notNull(),
  },
  (table) => [
    uniqueIndex('desk_article_embeddings_chunk_idx').on(table.articleId, table.chunkIndex),
  ],
);

export type DeskAiSettings = typeof deskAiSettings.$inferSelect;
export type NewDeskAiSettings = typeof deskAiSettings.$inferInsert;
export type DeskAiResolution = typeof deskAiResolutions.$inferSelect;
export type NewDeskAiResolution = typeof deskAiResolutions.$inferInsert;
export type DeskArticleEmbedding = typeof deskArticleEmbeddings.$inferSelect;
export type NewDeskArticleEmbedding = typeof deskArticleEmbeddings.$inferInsert;
