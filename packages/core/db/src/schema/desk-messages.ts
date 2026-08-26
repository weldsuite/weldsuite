import {
  pgTable,
  varchar,
  timestamp,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

/**
 * WeldDesk messages — append-only timeline.
 *
 * kind:
 *   message — public chat (visitor, agent, or bot)
 *   note    — internal, never shown to the visitor
 *   event   — state change (closed, reopened, assigned, …)
 *
 * Rows are ONLY written through appendDeskMessage in @weldsuite/db/lib,
 * which also updates desk_conversations.state / waitingSince / lastMessage*.
 */

export type DeskMessageKind = 'message' | 'note' | 'event';

export type DeskAuthorType = 'visitor' | 'agent' | 'bot' | 'system';

export type DeskEventType = 'closed' | 'reopened' | 'assigned' | 'unassigned';

export interface DeskMessageAttachment {
  name: string;
  url: string;
  contentType: string;
  filesize: number;
  width?: number;
  height?: number;
}

export interface DeskMessageMetadata {
  eventType?: DeskEventType;
  assigneeId?: string | null;
  [key: string]: unknown;
}

export const deskMessages = pgTable(
  'desk_messages',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),

    conversationId: varchar('conversation_id', { length: 30 }).notNull(),
    kind: varchar('kind', { length: 10 }).$type<DeskMessageKind>().notNull(),

    body: text('body'),

    authorType: varchar('author_type', { length: 10 }).$type<DeskAuthorType>().notNull(),
    authorId: varchar('author_id', { length: 255 }),

    attachments: jsonb('attachments').$type<DeskMessageAttachment[]>(),
    metadata: jsonb('metadata').$type<DeskMessageMetadata>(),
  },
  (table) => [
    index('desk_messages_conversation_created_idx').on(table.conversationId, table.createdAt),
    index('desk_messages_kind_idx').on(table.kind),
    index('desk_messages_author_idx').on(table.authorType, table.authorId),
  ],
);

export type DeskMessage = typeof deskMessages.$inferSelect;
export type NewDeskMessage = typeof deskMessages.$inferInsert;
