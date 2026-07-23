import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';
import { meetings } from './meetings';
import type { ChatAttachment } from './chat-messages';

export const meetingMessages = pgTable('meeting_messages', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Meeting reference
  meetingId: varchar('meeting_id', { length: 30 }).notNull().references(() => meetings.id),

  // Author
  authorId: varchar('author_id', { length: 255 }).notNull(),
  authorName: varchar('author_name', { length: 255 }).notNull(),
  authorAvatar: varchar('author_avatar', { length: 500 }),

  // Content
  content: text('content').notNull(),
  type: varchar('type', { length: 20 }).notNull().default('message'),

  // Attachments
  attachments: jsonb('attachments').$type<ChatAttachment[]>(),
  hasAttachments: boolean('has_attachments').notNull().default(false),

  // Pinning
  pinnedAt: timestamp('pinned_at'),
  pinnedBy: varchar('pinned_by', { length: 255 }),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('meeting_messages_meeting_created_idx').on(table.meetingId, table.createdAt),
  index('meeting_messages_author_idx').on(table.authorId),
]);

export type MeetingMessage = typeof meetingMessages.$inferSelect;
export type NewMeetingMessage = typeof meetingMessages.$inferInsert;
