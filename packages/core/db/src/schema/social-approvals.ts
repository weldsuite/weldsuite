import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  pgEnum,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { socialPosts } from './social-posts';

// Approval action enum
export const socialApprovalActionEnum = pgEnum('social_approval_action', [
  'submitted',
  'approved',
  'rejected',
  'revision_requested',
  'withdrawn',
  'auto_approved',
  'escalated',
  'reassigned',
]);

// Approval status enum
export const socialApprovalStatusEnum = pgEnum('social_approval_status', [
  'pending',
  'approved',
  'rejected',
  'revision_requested',
  'withdrawn',
  'expired',
]);

// Revision request details interface
export interface SocialRevisionDetails {
  areas: ('content' | 'media' | 'timing' | 'hashtags' | 'targeting')[];
  comments: string;
  suggestedChanges?: string;
}

// Approval rule triggered interface
export interface SocialApprovalRuleTriggered {
  ruleId: string;
  ruleName: string;
  reason: string;
}

export const socialApprovals = pgTable('social_approvals', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Reference to post
  postId: varchar('post_id', { length: 30 }).notNull().references(() => socialPosts.id),

  // Version tracking (for multiple revision cycles)
  version: integer('version').notNull().default(1),

  // Current status
  status: socialApprovalStatusEnum('status').notNull().default('pending'),

  // Submission
  submittedByUserId: varchar('submitted_by_user_id', { length: 255 }).notNull(),
  submittedAt: timestamp('submitted_at').notNull(),
  submissionNotes: text('submission_notes'),

  // Assignment
  assignedToUserId: varchar('assigned_to_user_id', { length: 255 }),
  assignedAt: timestamp('assigned_at'),
  assignedByUserId: varchar('assigned_by_user_id', { length: 255 }),

  // Decision
  decidedByUserId: varchar('decided_by_user_id', { length: 255 }),
  decidedAt: timestamp('decided_at'),
  decisionNotes: text('decision_notes'),

  // Rejection/Revision details
  rejectionReason: text('rejection_reason'),
  revisionDetails: jsonb('revision_details').$type<SocialRevisionDetails>(),

  // Priority/Urgency
  priority: varchar('priority', { length: 20 }).default('normal'),
  dueBy: timestamp('due_by'),

  // Escalation
  isEscalated: boolean('is_escalated').default(false),
  escalatedAt: timestamp('escalated_at'),
  escalatedToUserId: varchar('escalated_to_user_id', { length: 255 }),
  escalationReason: text('escalation_reason'),

  // Auto-approval
  wasAutoApproved: boolean('was_auto_approved').default(false),
  autoApprovalReason: text('auto_approval_reason'),

  // Rules that triggered this approval
  triggeredRules: jsonb('triggered_rules').$type<SocialApprovalRuleTriggered[]>(),

  // Expiration
  expiresAt: timestamp('expires_at'),

  // Reminder tracking
  remindersSent: integer('reminders_sent').default(0),
  lastReminderAt: timestamp('last_reminder_at'),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('social_approvals_post_idx').on(table.postId),
  index('social_approvals_status_idx').on(table.status),
  index('social_approvals_submitted_by_idx').on(table.submittedByUserId),
  index('social_approvals_assigned_to_idx').on(table.assignedToUserId),
  index('social_approvals_decided_at_idx').on(table.decidedAt),
  index('social_approvals_due_by_idx').on(table.dueBy),
]);

export type SocialApproval = typeof socialApprovals.$inferSelect;
export type NewSocialApproval = typeof socialApprovals.$inferInsert;

// Approval history/audit log table
export const socialApprovalHistory = pgTable('social_approval_history', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  // References
  approvalId: varchar('approval_id', { length: 30 }).notNull().references(() => socialApprovals.id),
  postId: varchar('post_id', { length: 30 }).notNull().references(() => socialPosts.id),

  // Action
  action: socialApprovalActionEnum('action').notNull(),

  // Actor
  actorUserId: varchar('actor_user_id', { length: 255 }).notNull(),
  actorName: varchar('actor_name', { length: 255 }),

  // Details
  notes: text('notes'),
  previousStatus: varchar('previous_status', { length: 30 }),
  newStatus: varchar('new_status', { length: 30 }),

  // Snapshot of post at this point
  postSnapshot: jsonb('post_snapshot').$type<{
    content?: string;
    mediaIds?: string[];
    scheduledAt?: string;
  }>(),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('social_approval_history_approval_idx').on(table.approvalId),
  index('social_approval_history_post_idx').on(table.postId),
  index('social_approval_history_actor_idx').on(table.actorUserId),
  index('social_approval_history_created_at_idx').on(table.createdAt),
]);

export type SocialApprovalHistory = typeof socialApprovalHistory.$inferSelect;
export type NewSocialApprovalHistory = typeof socialApprovalHistory.$inferInsert;
