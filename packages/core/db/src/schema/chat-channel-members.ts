import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { chatChannels } from './chat-channels';
import { roles } from './roles';

// Member roles
export type ChatMemberRole = 'owner' | 'admin' | 'member';
export type ChatNotificationPreference = 'all' | 'mentions' | 'none';
export type ChatMemberType = 'user' | 'agent';

export const chatChannelMembers = pgTable('chat_channel_members', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  // References
  channelId: varchar('channel_id', { length: 30 }).notNull().references(() => chatChannels.id),
  // userId holds a workspace user id when memberType='user' or an agent id (agt_*) when memberType='agent'
  userId: varchar('user_id', { length: 255 }).notNull(),
  memberType: varchar('member_type', { length: 20 }).notNull().default('user'),

  // Role
  role: varchar('role', { length: 20 }).notNull().default('member'),

  // If non-null, this membership was auto-created from a workspace role link
  // (chatChannelRoleLinks). Used to scope auto-removal: when a user's role
  // changes, only rows where addedByRoleId matches the OLD role are deleted —
  // manual joins (NULL) are never auto-removed.
  // On role hard-delete this is set to NULL, promoting the row to a manual
  // (sticky) membership.
  addedByRoleId: varchar('added_by_role_id', { length: 30 })
    .references(() => roles.id, { onDelete: 'set null' }),

  // Unread tracking
  lastReadAt: timestamp('last_read_at'),
  lastReadMessageId: varchar('last_read_message_id', { length: 30 }),

  // Preferences
  isMuted: boolean('is_muted').notNull().default(false),
  notificationPreference: varchar('notification_preference', { length: 20 }).notNull().default('all'),

  // Mention tracking
  unreadMentionCount: integer('unread_mention_count').notNull().default(0),

  // Timestamps
  joinedAt: timestamp('joined_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('chat_channel_members_unique_idx').on(table.channelId, table.userId),
  index('chat_channel_members_channel_idx').on(table.channelId),
  index('chat_channel_members_user_idx').on(table.userId),
]);

export type ChatChannelMember = typeof chatChannelMembers.$inferSelect;
export type NewChatChannelMember = typeof chatChannelMembers.$inferInsert;
