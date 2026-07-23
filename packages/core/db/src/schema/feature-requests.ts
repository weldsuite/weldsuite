import {
  pgTable,
  varchar,
  text,
  timestamp,
  pgEnum,
  index,
  integer,
  jsonb,
} from 'drizzle-orm/pg-core';

// Feature request type enum
export const featureTypeEnum = pgEnum('feature_type', ['feature', 'bug', 'improvement']);

// Feature request status enum
export const featureStatusEnum = pgEnum('feature_status', ['open', 'under_review', 'planned', 'in_progress', 'completed', 'declined']);

// Feature Requests table - stored in master database (global across all workspaces)
export const featureRequests = pgTable('feature_requests', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Content
  title: varchar('title', { length: 500 }).notNull(),
  description: text('description').notNull(),
  type: featureTypeEnum('type').notNull().default('feature'),

  // Submitter info
  submitterId: varchar('submitter_id', { length: 255 }).notNull(),
  submitterName: varchar('submitter_name', { length: 255 }).notNull(),
  submitterEmail: varchar('submitter_email', { length: 255 }).notNull(),

  // Status
  status: featureStatusEnum('status').notNull().default('open'),
  adminNotes: text('admin_notes'), // Internal notes

  // Voting
  voteCount: integer('vote_count').notNull().default(0),
  voters: jsonb('voters').$type<string[]>().default([]), // Array of user IDs

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [
  index('feature_requests_status_idx').on(table.status),
  index('feature_requests_type_idx').on(table.type),
  index('feature_requests_vote_count_idx').on(table.voteCount),
  index('feature_requests_created_at_idx').on(table.createdAt),
  index('feature_requests_submitter_idx').on(table.submitterId),
]);

export type FeatureRequest = typeof featureRequests.$inferSelect;
export type NewFeatureRequest = typeof featureRequests.$inferInsert;
export type FeatureType = 'feature' | 'bug' | 'improvement';
export type FeatureStatus = 'open' | 'under_review' | 'planned' | 'in_progress' | 'completed' | 'declined';
