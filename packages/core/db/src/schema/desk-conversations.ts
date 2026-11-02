import { sql } from 'drizzle-orm';
import {
  pgTable,
  varchar,
  timestamp,
  integer,
  text,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { DeskSlaMetric } from './desk-sla-clocks';

/**
 * WeldDesk conversation — current state only.
 *
 * The timeline lives in desk_messages. Channel is `messenger` in v1; the
 * enum already allows later channels (email, whatsapp, api) without a
 * schema change. waitingSince is the "ball is in our court" marker that
 * bots and SLAs will hang off later.
 *
 * rating / ratingComment / ratedAt: the visitor's CSAT answer (1–5) after
 * the team closed the conversation. One per conversation; the answer is
 * also on the timeline as a `rated` event.
 *
 * The conversation is the ticket: ticketTypeId (helpdesk_ticket_types),
 * priority, tags and departmentId (the team, helpdesk_departments) are the
 * ticket fields, and the type's custom fields live in custom_field_values
 * under entity type `desk_conversation`. They are written only by
 * updateDeskConversationAttributes, which puts the change on the timeline.
 *
 * externalId: the caller's own key for what an API, MCP, agent or workflow
 * conversation is about (an alert id, an order number). Unique, so a repeat
 * lands on the same conversation (reopening it if it was closed) instead of
 * starting another (`ingestDeskApi`).
 *
 * sla*: a summary of the conversation's SLA clocks (desk_sla_clocks) for the
 * inbox list, written only by refreshDeskSla. slaDueAt / slaMetric are the
 * running clock that comes due first; slaStatus is what the badge shows.
 */

export type DeskConversationState = 'open' | 'closed';

export type DeskChannel = 'messenger' | 'email' | 'phone' | 'whatsapp' | 'sms' | 'api' | 'portal';

/** null = no priority set. */
export type DeskPriority = 'low' | 'medium' | 'high' | 'urgent';

/**
 * active: a clock is running · warning: one is close to its due time ·
 * breached: a running clock is overdue, or a finished one missed its target ·
 * paused: waiting on the customer · achieved: every clock finished in time.
 * null: no SLA policy applies.
 */
export type DeskSlaStatus = 'active' | 'warning' | 'breached' | 'paused' | 'achieved';

export const deskConversations = pgTable(
  'desk_conversations',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    conversationNumber: integer('conversation_number').notNull(),
    title: varchar('title', { length: 500 }),

    state: varchar('state', { length: 10 }).$type<DeskConversationState>().notNull().default('open'),
    channel: varchar('channel', { length: 20 }).$type<DeskChannel>().notNull().default('messenger'),

    visitorId: varchar('visitor_id', { length: 64 }),
    name: varchar('name', { length: 255 }),
    email: varchar('email', { length: 255 }),
    contactId: varchar('contact_id', { length: 30 }),

    assigneeId: varchar('assignee_id', { length: 255 }),

    ticketTypeId: varchar('ticket_type_id', { length: 30 }),
    priority: varchar('priority', { length: 10 }).$type<DeskPriority>(),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    departmentId: varchar('department_id', { length: 30 }),

    waitingSince: timestamp('waiting_since'),
    lastMessageAt: timestamp('last_message_at'),
    lastMessagePreview: varchar('last_message_preview', { length: 200 }),

    rating: integer('rating'),
    ratingComment: text('rating_comment'),
    ratedAt: timestamp('rated_at'),

    externalId: varchar('external_id', { length: 255 }),

    slaPolicyId: varchar('sla_policy_id', { length: 30 }),
    slaStatus: varchar('sla_status', { length: 10 }).$type<DeskSlaStatus>(),
    slaDueAt: timestamp('sla_due_at'),
    slaMetric: varchar('sla_metric', { length: 20 }).$type<DeskSlaMetric>(),
  },
  (table) => [
    uniqueIndex('desk_conversations_number_uidx').on(table.conversationNumber),
    uniqueIndex('desk_conversations_external_id_uidx')
      .on(table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
    index('desk_conversations_state_waiting_idx').on(table.state, table.waitingSince),
    index('desk_conversations_state_last_msg_idx').on(table.state, table.lastMessageAt),
    index('desk_conversations_assignee_idx').on(table.assigneeId, table.state),
    index('desk_conversations_visitor_idx').on(table.visitorId),
    index('desk_conversations_channel_idx').on(table.channel),
    index('desk_conversations_ticket_type_idx').on(table.ticketTypeId, table.state),
    index('desk_conversations_priority_idx').on(table.priority, table.state),
    index('desk_conversations_department_idx').on(table.departmentId, table.state),
    index('desk_conversations_tags_gin').using('gin', table.tags),
    index('desk_conversations_state_sla_due_idx').on(table.state, table.slaDueAt),
  ],
);

export type DeskConversation = typeof deskConversations.$inferSelect;
export type NewDeskConversation = typeof deskConversations.$inferInsert;
