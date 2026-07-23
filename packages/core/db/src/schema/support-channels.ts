import {
  pgTable,
  varchar,
  timestamp,
  integer,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

export const supportChannels = pgTable('support_channels', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Status
  status: varchar('status', { length: 20 }).notNull().default('active'),

  // Denormalized counts & last message
  lastMessageAt: timestamp('last_message_at'),
  lastMessagePreview: text('last_message_preview'),
  messageCount: integer('message_count').notNull().default(0),
  memberCount: integer('member_count').notNull().default(0),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('support_channels_status_idx').on(table.status),
  index('support_channels_last_message_at_idx').on(table.lastMessageAt),
]);

export type SupportChannel = typeof supportChannels.$inferSelect;
export type NewSupportChannel = typeof supportChannels.$inferInsert;
