import {
  pgTable,
  varchar,
  timestamp,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * WeldDesk conversation — current state only.
 *
 * The timeline lives in desk_messages. Channel is `messenger` in v1; the
 * enum already allows later channels (email, whatsapp, api) without a
 * schema change. waitingSince is the "ball is in our court" marker that
 * bots and SLAs will hang off later.
 */

export type DeskConversationState = 'open' | 'closed';

export type DeskChannel = 'messenger' | 'email' | 'phone' | 'whatsapp' | 'sms' | 'api';

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

    waitingSince: timestamp('waiting_since'),
    lastMessageAt: timestamp('last_message_at'),
    lastMessagePreview: varchar('last_message_preview', { length: 200 }),
  },
  (table) => [
    uniqueIndex('desk_conversations_number_uidx').on(table.conversationNumber),
    index('desk_conversations_state_waiting_idx').on(table.state, table.waitingSince),
    index('desk_conversations_state_last_msg_idx').on(table.state, table.lastMessageAt),
    index('desk_conversations_assignee_idx').on(table.assigneeId, table.state),
    index('desk_conversations_visitor_idx').on(table.visitorId),
    index('desk_conversations_channel_idx').on(table.channel),
  ],
);

export type DeskConversation = typeof deskConversations.$inferSelect;
export type NewDeskConversation = typeof deskConversations.$inferInsert;
