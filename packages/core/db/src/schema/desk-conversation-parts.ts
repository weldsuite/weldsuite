import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';
import type { MessageBlock, BlockResponse } from './welddesk-blocks';
import type { DeskConversationState } from './desk-conversations';

/**
 * WeldDesk v2 — conversation parts: the append-only timeline.
 *
 * EVERYTHING that happens in a conversation is a part: customer/admin
 * replies, internal notes, and every state/assignment/rating change. The
 * conversation pane renders messages + audit trail from this one stream.
 *
 * Invariant: rows are append-only and are ONLY written through the
 * part-append service (which also maintains desk_conversations.statistics,
 * waitingSince, state, etc. in the same transaction). No side-door inserts.
 */

export type DeskPartType =
  // content
  | 'comment' // customer or admin reply
  | 'note' // internal, never sent to the customer
  | 'note_and_reopen'
  | 'quick_reply' // customer clicked a reply button
  // state changes
  | 'open'
  | 'close'
  | 'snoozed'
  | 'unsnoozed'
  | 'timer_unsnooze'
  // assignment
  | 'assignment' // manual assign (teammate or team)
  | 'assign_and_unsnooze'
  | 'away_mode_assignment' // auto-reassign because assignee went away
  | 'default_assignment' // workflow / default rules
  | 'balanced_assignment' // distribution engine (incl. "pull conversation")
  // participants & rating
  | 'participant_added'
  | 'participant_removed'
  | 'conversation_rating_changed'
  | 'conversation_rating_remark_added'
  // tickets
  | 'ticket_state_changed'
  | 'ticket_attribute_updated'
  | 'converted_to_ticket'
  | 'linked_object_added'
  | 'linked_object_removed'
  // workflow / AI events
  | 'workflow_started'
  | 'workflow_ended'
  | 'ai_answer'
  | 'ai_handover';

export type DeskPartAuthorType = 'admin' | 'user' | 'bot' | 'team';

export interface DeskPartAttachment {
  name: string;
  url: string;
  contentType: string;
  filesize: number;
  width?: number;
  height?: number;
}

export interface DeskPartEmailMetadata {
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  subject?: string;
  cc?: string[];
  bcc?: string[];
  fromAddress?: string;
  toAddresses?: string[];
}

/** For ticket_attribute_updated / attribute-change event parts. */
export interface DeskPartAttributeChange {
  attributeId: string;
  attributeLabel: string;
  previousValue?: unknown;
  value?: unknown;
}

export const deskConversationParts = pgTable(
  'desk_conversation_parts',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    conversationId: varchar('conversation_id', { length: 30 }).notNull(),
    partType: varchar('part_type', { length: 40 }).$type<DeskPartType>().notNull(),

    /** Rich-text body (HTML); null for pure event parts. */
    body: text('body'),
    /** Block Kit content for bot/interactive messages. */
    blocks: jsonb('blocks').$type<MessageBlock[]>(),
    /** Customer interactions with blocks, keyed by actionId. */
    blockResponses: jsonb('block_responses').$type<Record<string, BlockResponse>>(),

    authorType: varchar('author_type', { length: 10 }).$type<DeskPartAuthorType>().notNull(),
    authorId: varchar('author_id', { length: 255 }),
    fromAiAgent: boolean('from_ai_agent').notNull().default(false),
    isAiAnswer: boolean('is_ai_answer').notNull().default(false),

    /** Set only on parts that changed assignment. */
    assignedToType: varchar('assigned_to_type', { length: 10 }).$type<'admin' | 'team'>(),
    assignedToId: varchar('assigned_to_id', { length: 255 }),

    attachments: jsonb('attachments').$type<DeskPartAttachment[]>(),
    /** RFC 5322 Message-ID, extracted for thread-matching lookups. */
    emailMessageId: varchar('email_message_id', { length: 998 }),
    emailMetadata: jsonb('email_metadata').$type<DeskPartEmailMetadata>(),
    attributeChange: jsonb('attribute_change').$type<DeskPartAttributeChange>(),

    /** Conversation state at the time this part was created. */
    stateSnapshot: varchar('state_snapshot', { length: 10 }).$type<DeskConversationState>().notNull(),

    /** Free-form extras (e.g. workflow execution id, snooze target, rating value). */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  },
  (table) => [
    index('desk_parts_conversation_created_idx').on(table.conversationId, table.createdAt),
    index('desk_parts_type_idx').on(table.partType),
    index('desk_parts_author_idx').on(table.authorType, table.authorId),
    index('desk_parts_email_message_id_idx').on(table.emailMessageId),
  ],
);

export type DeskConversationPart = typeof deskConversationParts.$inferSelect;
export type NewDeskConversationPart = typeof deskConversationParts.$inferInsert;
