import {
  pgTable,
  varchar,
  timestamp,
  integer,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

// Feedback types
export type FeedbackType = 'bug' | 'feature_request' | 'improvement' | 'question' | 'other';
export type FeedbackStatus = 'new' | 'under_review' | 'planned' | 'in_progress' | 'completed' | 'rejected';
export type FeedbackPriority = 'low' | 'medium' | 'high';

export interface FeedbackAttachment {
  id: string;
  name: string;
  url: string;
  type: string;
  size: number;
}

export interface FeedbackComment {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: string;
}

export const helpdeskFeedback = pgTable('helpdesk_feedback', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Type & Status
  type: varchar('type', { length: 30 }).notNull().default('feature_request'),
  status: varchar('status', { length: 30 }).notNull().default('new'),
  priority: varchar('priority', { length: 20 }).notNull().default('medium'),

  // Content
  title: varchar('title', { length: 500 }).notNull(),
  description: text('description').notNull(),
  category: varchar('category', { length: 100 }),

  // Submitter
  submitterId: varchar('submitter_id', { length: 255 }).notNull(),
  submitterName: varchar('submitter_name', { length: 255 }).notNull(),
  submitterEmail: varchar('submitter_email', { length: 255 }).notNull(),

  // Voting
  votes: integer('votes').notNull().default(0),
  voters: jsonb('voters').$type<string[]>(),

  // Attachments & Comments
  attachments: jsonb('attachments').$type<FeedbackAttachment[]>(),
  comments: jsonb('comments').$type<FeedbackComment[]>(),

  // Assignment
  assigneeId: varchar('assignee_id', { length: 255 }),
  assigneeName: varchar('assignee_name', { length: 255 }),

  // Timeline
  estimatedCompletion: timestamp('estimated_completion'),
  completedAt: timestamp('completed_at'),
  rejectionReason: text('rejection_reason'),
}, (table) => [
  index('helpdesk_feedback_type_idx').on(table.type),
  index('helpdesk_feedback_status_idx').on(table.status),
  index('helpdesk_feedback_priority_idx').on(table.priority),
  index('helpdesk_feedback_submitter_idx').on(table.submitterId),
  index('helpdesk_feedback_assignee_idx').on(table.assigneeId),
  index('helpdesk_feedback_votes_idx').on(table.votes),
]);

export type HelpdeskFeedbackItem = typeof helpdeskFeedback.$inferSelect;
export type NewHelpdeskFeedbackItem = typeof helpdeskFeedback.$inferInsert;
