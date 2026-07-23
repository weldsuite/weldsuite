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

// Review types
export type ReviewType = 'product' | 'service' | 'support' | 'app';
export type ReviewStatus = 'pending' | 'approved' | 'rejected';

export interface ReviewResponse {
  content: string;
  responderId: string;
  responderName: string;
  respondedAt: string;
}

export interface ReviewMetadata {
  orderId?: string;
  productId?: string;
  ticketId?: string;
  [key: string]: unknown;
}

export const helpdeskReviews = pgTable('helpdesk_reviews', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Type & Status
  type: varchar('type', { length: 20 }).notNull().default('service'),
  status: varchar('status', { length: 20 }).notNull().default('pending'),

  // Rating & Content
  rating: integer('rating').notNull(), // 1-5
  title: varchar('title', { length: 500 }).notNull(),
  content: text('content').notNull(),

  // Reviewer
  reviewerId: varchar('reviewer_id', { length: 255 }).notNull(),
  reviewerName: varchar('reviewer_name', { length: 255 }).notNull(),
  reviewerEmail: varchar('reviewer_email', { length: 255 }).notNull(),
  reviewerAvatar: varchar('reviewer_avatar', { length: 500 }),

  // Related
  conversationId: varchar('conversation_id', { length: 30 }),

  // Verification & Flags
  isVerified: boolean('is_verified').notNull().default(false),
  isPinned: boolean('is_pinned').notNull().default(false),
  isFeatured: boolean('is_featured').notNull().default(false),

  // Engagement
  helpfulCount: integer('helpful_count').notNull().default(0),
  helpfulVoters: jsonb('helpful_voters').$type<string[]>(),

  // Response
  response: jsonb('response').$type<ReviewResponse>(),

  // Metadata
  metadata: jsonb('metadata').$type<ReviewMetadata>(),
}, (table) => [
  index('helpdesk_reviews_type_idx').on(table.type),
  index('helpdesk_reviews_status_idx').on(table.status),
  index('helpdesk_reviews_rating_idx').on(table.rating),
  index('helpdesk_reviews_reviewer_idx').on(table.reviewerId),
  index('helpdesk_reviews_is_featured_idx').on(table.isFeatured),
]);

export type HelpdeskReview = typeof helpdeskReviews.$inferSelect;
export type NewHelpdeskReview = typeof helpdeskReviews.$inferInsert;
