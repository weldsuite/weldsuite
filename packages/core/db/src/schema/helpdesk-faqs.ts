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

export const helpdeskFaqs = pgTable('helpdesk_faqs', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Content
  question: text('question').notNull(),
  answer: text('answer').notNull(),

  // Categorization
  category: varchar('category', { length: 100 }),

  // Ordering
  order: integer('order').default(0),

  // Visibility
  isPublished: boolean('is_published').notNull().default(false),
  publishedAt: timestamp('published_at'),

  // Engagement
  viewCount: integer('view_count').default(0),
  helpfulCount: integer('helpful_count').default(0),
  notHelpfulCount: integer('not_helpful_count').default(0),

  // Related
  relatedFAQs: jsonb('related_faqs').$type<string[]>(),
  relatedArticles: jsonb('related_articles').$type<string[]>(),

  // Tags
  tags: jsonb('tags').$type<string[]>(),
}, (table) => [
  index('helpdesk_faqs_category_idx').on(table.category),
  index('helpdesk_faqs_is_published_idx').on(table.isPublished),
  index('helpdesk_faqs_order_idx').on(table.order),
]);

export type HelpdeskFaq = typeof helpdeskFaqs.$inferSelect;
export type NewHelpdeskFaq = typeof helpdeskFaqs.$inferInsert;
