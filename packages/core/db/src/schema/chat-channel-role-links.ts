import {
  pgTable,
  varchar,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { chatChannels } from './chat-channels';
import { roles } from './roles';

// Links a workspace role to a chat channel. Members holding the role are
// auto-added to the channel; when the role is unlinked, role-driven
// memberships are removed (manual joins, identified by addedByRoleId IS NULL
// on chatChannelMembers, are preserved).
export const chatChannelRoleLinks = pgTable('chat_channel_role_links', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  channelId: varchar('channel_id', { length: 30 })
    .notNull()
    .references(() => chatChannels.id, { onDelete: 'cascade' }),
  roleId: varchar('role_id', { length: 30 })
    .notNull()
    .references(() => roles.id, { onDelete: 'cascade' }),

  createdBy: varchar('created_by', { length: 255 }),
}, (table) => [
  uniqueIndex('chat_channel_role_links_unique_idx').on(table.channelId, table.roleId),
  index('chat_channel_role_links_channel_idx').on(table.channelId),
  index('chat_channel_role_links_role_idx').on(table.roleId),
]);

export type ChatChannelRoleLink = typeof chatChannelRoleLinks.$inferSelect;
export type NewChatChannelRoleLink = typeof chatChannelRoleLinks.$inferInsert;
