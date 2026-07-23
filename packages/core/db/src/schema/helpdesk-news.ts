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

// News types
export type NewsStatus = 'draft' | 'published' | 'archived';

export const helpdeskNews = pgTable('helpdesk_news', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Content
  title: varchar('title', { length: 500 }).notNull(),
  content: text('content').notNull(),
  excerpt: text('excerpt'),

  // Categorization
  category: varchar('category', { length: 100 }),
  tags: jsonb('tags').$type<string[]>(),

  // Status
  status: varchar('status', { length: 20 }).notNull().default('draft'),

  // Media
  featuredImage: varchar('featured_image', { length: 500 }),

  // Author
  authorId: varchar('author_id', { length: 255 }).notNull(),
  authorName: varchar('author_name', { length: 255 }),

  // Publishing
  publishedAt: timestamp('published_at'),

  // Engagement
  viewCount: integer('view_count').default(0),
  likeCount: integer('like_count').default(0),
  commentCount: integer('comment_count').default(0),

  // Flags
  isPinned: boolean('is_pinned').default(false),
}, (table) => [
  index('helpdesk_news_status_idx').on(table.status),
  index('helpdesk_news_category_idx').on(table.category),
  index('helpdesk_news_published_at_idx').on(table.publishedAt),
  index('helpdesk_news_is_pinned_idx').on(table.isPinned),
]);

export type HelpdeskNewsItem = typeof helpdeskNews.$inferSelect;
export type NewHelpdeskNewsItem = typeof helpdeskNews.$inferInsert;
