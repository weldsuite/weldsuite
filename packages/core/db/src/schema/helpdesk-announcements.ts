import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  integer,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

// Announcement types
export type AnnouncementType = 'info' | 'warning' | 'success' | 'error';
export type AnnouncementStatus = 'draft' | 'published' | 'archived';
export type AnnouncementVisibility = 'public' | 'internal' | 'specific_groups';

export const helpdeskAnnouncements = pgTable('helpdesk_announcements', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Content
  title: varchar('title', { length: 500 }).notNull(),
  content: text('content').notNull(),
  excerpt: text('excerpt'),

  // Type & Status
  type: varchar('type', { length: 20 }).notNull().default('info'),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  visibility: varchar('visibility', { length: 20 }).notNull().default('public'),

  // Targeting
  targetGroups: jsonb('target_groups').$type<string[]>(),

  // Media
  featuredImage: varchar('featured_image', { length: 500 }),

  // Author
  authorId: varchar('author_id', { length: 255 }).notNull(),
  authorName: varchar('author_name', { length: 255 }),

  // Publishing
  publishedAt: timestamp('published_at'),
  expiresAt: timestamp('expires_at'),

  // Flags
  isPinned: boolean('is_pinned').default(false),

  // Engagement
  viewCount: integer('view_count').default(0),
}, (table) => [
  index('helpdesk_announcements_status_idx').on(table.status),
  index('helpdesk_announcements_visibility_idx').on(table.visibility),
  index('helpdesk_announcements_type_idx').on(table.type),
  index('helpdesk_announcements_published_at_idx').on(table.publishedAt),
  index('helpdesk_announcements_is_pinned_idx').on(table.isPinned),
]);

export type HelpdeskAnnouncement = typeof helpdeskAnnouncements.$inferSelect;
export type NewHelpdeskAnnouncement = typeof helpdeskAnnouncements.$inferInsert;
