import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  integer,
  jsonb,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { chatSections } from './chat-sections';

// Channel types
export type ChatChannelType = 'public' | 'private' | 'dm' | 'entity';

export const chatChannels = pgTable('chat_channels', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Channel info
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 255 }).notNull(),
  description: text('description'),
  topic: text('topic'),
  type: varchar('type', { length: 20 }).notNull().default('public'),
  icon: varchar('icon', { length: 50 }),

  // Creator
  createdBy: varchar('created_by', { length: 255 }),

  // Flags
  isArchived: boolean('is_archived').notNull().default(false),
  isDefault: boolean('is_default').notNull().default(false),

  // Call permissions
  voiceCallsEnabled: boolean('voice_calls_enabled').notNull().default(true),
  videoCallsEnabled: boolean('video_calls_enabled').notNull().default(true),

  // Feature toggles — let admins lock down channel behaviour
  threadsEnabled: boolean('threads_enabled').notNull().default(true),
  attachmentsEnabled: boolean('attachments_enabled').notNull().default(true),
  reactionsEnabled: boolean('reactions_enabled').notNull().default(true),
  /** Slow-mode minimum seconds between messages per user (0 = off). */
  slowModeSeconds: integer('slow_mode_seconds').notNull().default(0),

  // Denormalized counts & last message
  lastMessageAt: timestamp('last_message_at'),
  lastMessagePreview: text('last_message_preview'),
  messageCount: integer('message_count').notNull().default(0),
  memberCount: integer('member_count').notNull().default(0),

  // Section grouping
  sectionId: varchar('section_id', { length: 30 }).references(() => chatSections.id),

  // Entity linkage (for type='entity' channels attached to a business object)
  entityType: varchar('entity_type', { length: 50 }),
  entityId: varchar('entity_id', { length: 30 }),
  entityDisplayName: varchar('entity_display_name', { length: 255 }),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  uniqueIndex('chat_channels_slug_idx').on(table.slug),
  index('chat_channels_type_idx').on(table.type),
  index('chat_channels_is_archived_idx').on(table.isArchived),
  index('chat_channels_last_message_at_idx').on(table.lastMessageAt),
  index('chat_channels_created_by_idx').on(table.createdBy),
  index('chat_channels_entity_idx').on(table.entityType, table.entityId),
  uniqueIndex('chat_channels_entity_unique_idx')
    .on(table.entityType, table.entityId)
    .where(sql`${table.entityType} IS NOT NULL AND ${table.entityId} IS NOT NULL`),
]);

export type ChatChannel = typeof chatChannels.$inferSelect;
export type NewChatChannel = typeof chatChannels.$inferInsert;
