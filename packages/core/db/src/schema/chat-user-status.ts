import {
  pgTable,
  varchar,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// User presence status
export type ChatUserPresenceStatus = 'online' | 'busy' | 'away' | 'dnd' | 'offline';

export const chatUserStatus = pgTable('chat_user_status', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // User reference
  userId: varchar('user_id', { length: 255 }).notNull(),

  // Status
  status: varchar('status', { length: 20 }).notNull().default('online'),
  statusText: varchar('status_text', { length: 255 }),
  statusEmoji: varchar('status_emoji', { length: 50 }),
  statusExpiresAt: timestamp('status_expires_at'),
}, (table) => [
  uniqueIndex('chat_user_status_user_idx').on(table.userId),
]);

export type ChatUserStatus = typeof chatUserStatus.$inferSelect;
export type NewChatUserStatus = typeof chatUserStatus.$inferInsert;
