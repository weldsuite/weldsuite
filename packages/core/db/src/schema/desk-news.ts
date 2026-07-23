import {
  pgTable,
  varchar,
  timestamp,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';
import type { DeskViewFilter } from './desk-views';

/**
 * WeldDesk v2 — news items.
 *
 * Single table replacing the old announcements/news/changelog trio. Feeds
 * the (post-v1) News space in the Messenger; audience rules target items
 * per customer segment.
 */
export type DeskNewsType = 'announcement' | 'changelog' | 'news';

export const deskNews = pgTable(
  'desk_news',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    title: varchar('title', { length: 500 }).notNull(),
    body: text('body').notNull(),
    newsType: varchar('news_type', { length: 15 }).$type<DeskNewsType>().notNull().default('news'),
    coverImageUrl: varchar('cover_image_url', { length: 500 }),
    audienceRules: jsonb('audience_rules').$type<DeskViewFilter>(),
    /** Null = draft. */
    publishedAt: timestamp('published_at'),
    createdBy: varchar('created_by', { length: 255 }),
  },
  (table) => [index('desk_news_published_idx').on(table.publishedAt)],
);

export type DeskNewsItem = typeof deskNews.$inferSelect;
export type NewDeskNewsItem = typeof deskNews.$inferInsert;
