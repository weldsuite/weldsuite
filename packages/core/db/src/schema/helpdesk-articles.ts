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
import { helpdeskArticleFolders } from './helpdesk-article-folders';

// Article types
export type ArticleStatus = 'draft' | 'review' | 'published' | 'archived' | 'outdated';
export type ArticleVisibility = 'public' | 'internal' | 'logged_in' | 'specific_users';
export type ArticleDifficulty = 'beginner' | 'intermediate' | 'advanced';

export interface ArticleAttachment {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
}

export const helpdeskArticles = pgTable('helpdesk_articles', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Basic Information
  title: varchar('title', { length: 500 }).notNull(),
  slug: varchar('slug', { length: 500 }).notNull(),
  content: text('content').notNull(),
  excerpt: text('excerpt'),

  // Categorization
  category: varchar('category', { length: 255 }), // Backend field name for category/folder path
  categoryId: varchar('category_id', { length: 30 }).references(() => helpdeskArticleFolders.id),
  categoryName: varchar('category_name', { length: 255 }),
  subcategoryId: varchar('subcategory_id', { length: 30 }),
  sectionId: varchar('section_id', { length: 30 }),

  // SEO
  metaTitle: varchar('meta_title', { length: 255 }),
  metaDescription: text('meta_description'),
  keywords: jsonb('keywords').$type<string[]>(),

  // Author
  authorId: varchar('author_id', { length: 255 }).notNull(),
  authorName: varchar('author_name', { length: 255 }),
  reviewerId: varchar('reviewer_id', { length: 255 }),

  // Status
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  visibility: varchar('visibility', { length: 20 }).notNull().default('public'),

  // Publishing
  publishedAt: timestamp('published_at'),
  unpublishedAt: timestamp('unpublished_at'),
  scheduledPublishAt: timestamp('scheduled_publish_at'),

  // Versioning
  version: integer('version').default(1),
  isDraft: boolean('is_draft').default(true),
  previousVersionId: varchar('previous_version_id', { length: 30 }),

  // Content
  tableOfContents: text('table_of_contents'),
  readTime: integer('read_time'), // minutes
  difficulty: varchar('difficulty', { length: 20 }),

  // Media
  featuredImage: varchar('featured_image', { length: 500 }),
  attachments: jsonb('attachments').$type<ArticleAttachment[]>(),
  videos: jsonb('videos').$type<string[]>(),

  // Engagement
  viewCount: integer('view_count').default(0),
  likeCount: integer('like_count').default(0),
  dislikeCount: integer('dislike_count').default(0),
  helpfulCount: integer('helpful_count').default(0),
  notHelpfulCount: integer('not_helpful_count').default(0),

  // Related
  relatedArticles: jsonb('related_articles').$type<string[]>(),
  relatedProducts: jsonb('related_products').$type<string[]>(),
  relatedTickets: jsonb('related_tickets').$type<string[]>(),

  // Tags
  tags: jsonb('tags').$type<string[]>(),
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>(),

  // Flags
  isPinned: boolean('is_pinned').default(false),
  allowComments: boolean('allow_comments').default(true),
  requiresLogin: boolean('requires_login').default(false),
}, (table) => [
  index('helpdesk_articles_category_id_idx').on(table.categoryId),
  index('helpdesk_articles_author_idx').on(table.authorId),
  index('helpdesk_articles_status_idx').on(table.status),
  index('helpdesk_articles_visibility_idx').on(table.visibility),
  index('helpdesk_articles_slug_idx').on(table.slug),
  index('helpdesk_articles_published_at_idx').on(table.publishedAt),
  index('helpdesk_articles_is_pinned_idx').on(table.isPinned),
]);

export type HelpdeskArticle = typeof helpdeskArticles.$inferSelect;
export type NewHelpdeskArticle = typeof helpdeskArticles.$inferInsert;
