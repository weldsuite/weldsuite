import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  integer,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

/**
 * WeldDesk v2 — Intercom-model conversation.
 *
 * The single core primitive of the helpdesk. A ticket is NOT a separate
 * entity: it is a conversation with the ticket* columns populated
 * (ticketTypeId + ticketStateId + ticketCategory). See
 * .claude/welddesk-intercom-plan.md §5.
 *
 * Everything that happens in a conversation (replies, notes, state changes,
 * assignments, ratings) is an append-only row in desk_conversation_parts —
 * this table only holds current state + the denormalized statistics rollup.
 */

/** open = active; snoozed = hidden until snoozedUntil / activity; closed = done. */
export type DeskConversationState = 'open' | 'snoozed' | 'closed';

/** Channel the conversation originated on. 'messenger' = the embeddable widget. */
export type DeskChannel = 'messenger' | 'email' | 'phone' | 'whatsapp' | 'sms' | 'api';

/** How the initiating message came to exist. */
export type DeskDeliveredAs =
  | 'customer_initiated'
  | 'admin_initiated'
  | 'automated' // workflow / bot
  | 'campaign_initiated';

export type DeskTicketCategory = 'customer' | 'back_office' | 'tracker';

/** The message that started the conversation (immutable snapshot). */
export interface DeskConversationSource {
  type: DeskChannel;
  deliveredAs: DeskDeliveredAs;
  subject?: string;
  /** HTML body of the first message (also present as the first part). */
  body?: string;
  authorType: 'user' | 'admin' | 'bot';
  authorId?: string;
  /** Page URL the conversation was started from (messenger). */
  url?: string;
}

/**
 * Denormalized reporting rollup, maintained event-by-event by the
 * part-append service (never written anywhere else). All durations are
 * seconds. Nullable fields = event hasn't happened yet.
 */
export interface DeskConversationStatistics {
  firstContactReplyAt?: string;
  firstAdminReplyAt?: string;
  firstAssignmentAt?: string;
  firstCloseAt?: string;
  lastContactReplyAt?: string;
  lastAdminReplyAt?: string;
  lastAssignmentAt?: string;
  lastCloseAt?: string;
  lastClosedById?: string;
  timeToAssignment?: number;
  timeToAdminReply?: number;
  timeToFirstClose?: number;
  timeToLastClose?: number;
  medianTimeToReply?: number;
  /** Reply-time samples used to maintain medianTimeToReply incrementally. */
  replyTimes?: number[];
  countReopens: number;
  countAssignments: number;
  countParts: number;
  /** Seconds from first assignment to close, excluding snoozed/closed time. */
  handlingTime?: number;
}

/** AI-agent involvement snapshot (details in desk_ai_resolutions). */
export interface DeskConversationAiAgent {
  sourceType: 'workflow' | 'preview';
  lastAnswerType?: 'ai_answer' | 'clarification';
  resolutionState?: 'confirmed_resolution' | 'assumed_resolution' | 'routed_to_team' | 'abandoned';
  rating?: number;
  ratingRemark?: string;
  /** Article ids used as sources across the AI's answers. */
  contentSources?: string[];
}

export interface DeskConversationRating {
  rating: number; // 1-5
  remark?: string;
  createdAt: string;
  teammateId?: string;
}

export const deskConversations = pgTable(
  'desk_conversations',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    /** Human-facing sequential number, unique per workspace tenant. */
    conversationNumber: integer('conversation_number').notNull(),

    title: varchar('title', { length: 500 }),

    // ── State ────────────────────────────────────────────────────────────
    state: varchar('state', { length: 10 }).$type<DeskConversationState>().notNull().default('open'),
    read: boolean('read').notNull().default(false),
    /** Boolean priority flag (Intercom semantics), not a scale. */
    priority: boolean('priority').notNull().default(false),
    /**
     * Set when the last reply is from the customer (the ball is in our
     * court); null after an admin/bot reply. Drives "waiting longest" sort,
     * next-reply SLA, and assignment queue order.
     */
    waitingSince: timestamp('waiting_since'),
    snoozedUntil: timestamp('snoozed_until'),

    // ── Assignment (dual — teammate assign preserves team; team assign clears teammate)
    adminAssigneeId: varchar('admin_assignee_id', { length: 255 }),
    teamAssigneeId: varchar('team_assignee_id', { length: 30 }),

    // ── Customer (CRM model) ─────────────────────────────────────────────
    contactId: varchar('contact_id', { length: 30 }),
    counterpartyId: varchar('counterparty_id', { length: 30 }),
    personId: varchar('person_id', { length: 30 }),

    // ── Origin ───────────────────────────────────────────────────────────
    channel: varchar('channel', { length: 20 }).$type<DeskChannel>().notNull(),
    source: jsonb('source').$type<DeskConversationSource>().notNull(),

    // ── Data ─────────────────────────────────────────────────────────────
    /** Conversation data attributes (schema in desk_conversation_attributes). */
    customAttributes: jsonb('custom_attributes').$type<Record<string, unknown>>(),
    tags: jsonb('tags').$type<string[]>(),
    conversationRating: jsonb('conversation_rating').$type<DeskConversationRating>(),
    statistics: jsonb('statistics').$type<DeskConversationStatistics>(),

    // ── AI agent ─────────────────────────────────────────────────────────
    aiAgentParticipated: boolean('ai_agent_participated').notNull().default(false),
    aiAgent: jsonb('ai_agent').$type<DeskConversationAiAgent>(),

    // ── Ticket subtype (all null = plain conversation) ───────────────────
    ticketTypeId: varchar('ticket_type_id', { length: 30 }),
    ticketStateId: varchar('ticket_state_id', { length: 30 }),
    ticketCategory: varchar('ticket_category', { length: 15 }).$type<DeskTicketCategory>(),
    /** Human-facing ticket number (separate sequence from conversationNumber). */
    ticketNumber: integer('ticket_number'),
    /** Values keyed by desk_ticket_type_attributes.id. */
    ticketAttributes: jsonb('ticket_attributes').$type<Record<string, unknown>>(),
    /** Whether the ticket is visible to the customer (always true for category=customer). */
    isShared: boolean('is_shared'),
  },
  (table) => [
    index('desk_conversations_state_waiting_idx').on(table.state, table.waitingSince),
    index('desk_conversations_state_created_idx').on(table.state, table.createdAt),
    index('desk_conversations_admin_assignee_idx').on(table.adminAssigneeId, table.state),
    index('desk_conversations_team_assignee_idx').on(table.teamAssigneeId, table.state),
    index('desk_conversations_contact_idx').on(table.contactId),
    index('desk_conversations_counterparty_idx').on(table.counterpartyId),
    index('desk_conversations_channel_idx').on(table.channel),
    index('desk_conversations_number_idx').on(table.conversationNumber),
    index('desk_conversations_ticket_type_idx').on(table.ticketTypeId),
    index('desk_conversations_ticket_state_idx').on(table.ticketStateId),
    index('desk_conversations_snoozed_until_idx').on(table.snoozedUntil),
  ],
);

export type DeskConversation = typeof deskConversations.$inferSelect;
export type NewDeskConversation = typeof deskConversations.$inferInsert;
