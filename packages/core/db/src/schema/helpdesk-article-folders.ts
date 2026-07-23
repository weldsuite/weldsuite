import {
  pgTable,
  varchar,
  timestamp,
  integer,
  text,
  index,
} from 'drizzle-orm/pg-core';

export const helpdeskArticleFolders = pgTable('helpdesk_article_folders', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Basic info
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 255 }),
  description: text('description'),

  // Hierarchy
  parentId: varchar('parent_id', { length: 30 }),
  path: varchar('path', { length: 1000 }), // Full path like "parent/child/grandchild"
  level: integer('level').notNull().default(0),

  // Ordering
  sortOrder: integer('sort_order').notNull().default(0),

  // Display
  icon: varchar('icon', { length: 100 }),
  color: varchar('color', { length: 20 }),

  // Stats
  articleCount: integer('article_count').notNull().default(0),
}, (table) => [
  index('helpdesk_article_folders_parent_idx').on(table.parentId),
  index('helpdesk_article_folders_slug_idx').on(table.slug),
  index('helpdesk_article_folders_sort_order_idx').on(table.sortOrder),
]);

export type HelpdeskArticleFolder = typeof helpdeskArticleFolders.$inferSelect;
export type NewHelpdeskArticleFolder = typeof helpdeskArticleFolders.$inferInsert;
