import {
  pgTable,
  varchar,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { supportChannels } from './support-channels';

export type SupportMemberRole = 'owner' | 'member';

export const supportChannelMembers = pgTable('support_channel_members', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  // References
  channelId: varchar('channel_id', { length: 30 }).notNull().references(() => supportChannels.id),
  userId: varchar('user_id', { length: 255 }).notNull(),

  // Role
  role: varchar('role', { length: 20 }).notNull().default('member'),

  // Timestamps
  joinedAt: timestamp('joined_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('support_channel_members_unique_idx').on(table.channelId, table.userId),
  index('support_channel_members_channel_idx').on(table.channelId),
  index('support_channel_members_user_idx').on(table.userId),
]);

export type SupportChannelMember = typeof supportChannelMembers.$inferSelect;
export type NewSupportChannelMember = typeof supportChannelMembers.$inferInsert;
