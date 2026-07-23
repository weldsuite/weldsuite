import {
  pgTable,
  varchar,
  timestamp,
  integer,
} from 'drizzle-orm/pg-core';

/**
 * Workspace Usage Tracking
 *
 * Tracks monthly usage metrics per workspace for plan limit enforcement.
 * Usage counters reset at the start of each month.
 */
export const workspaceUsage = pgTable('workspace_usage', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Task execution tracking (workflow executions)
  taskExecutionsThisMonth: integer('task_executions_this_month').notNull().default(0),
  taskExecutionsLastReset: timestamp('task_executions_last_reset', { withTimezone: true }).notNull().defaultNow(),

  // Email tracking
  emailsSentThisMonth: integer('emails_sent_this_month').notNull().default(0),
  emailsLastReset: timestamp('emails_last_reset', { withTimezone: true }).notNull().defaultNow(),

  // AI credits tracking
  aiCreditsUsedThisMonth: integer('ai_credits_used_this_month').notNull().default(0),
  aiCreditsLastReset: timestamp('ai_credits_last_reset', { withTimezone: true }).notNull().defaultNow(),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type WorkspaceUsage = typeof workspaceUsage.$inferSelect;
export type NewWorkspaceUsage = typeof workspaceUsage.$inferInsert;
