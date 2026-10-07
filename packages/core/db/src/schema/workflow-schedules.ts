import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  index,
} from 'drizzle-orm/pg-core';
export const workflowSchedules = pgTable('workflow_schedules', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Workflow Reference
  workflowId: varchar('workflow_id', { length: 30 }).notNull(),
  triggerId: varchar('trigger_id', { length: 30 }), // Reference to workflow_triggers

  // Schedule Info
  name: varchar('name', { length: 255 }),
  description: text('description'),

  // Schedule Configuration
  // 'recurring' (cron) | 'one_time' (fires once at executeAt, then disables itself).
  scheduleType: varchar('schedule_type', { length: 20 }).notNull().default('recurring'),
  // Required for 'recurring'; null for 'one_time'.
  cronExpression: varchar('cron_expression', { length: 100 }),
  timezone: varchar('timezone', { length: 100 }).notNull().default('UTC'),
  interval: varchar('interval', { length: 50 }), // Human-readable: 'every 5 minutes', 'daily at 9am'
  // 'one_time' only: the wall-clock moment to fire, in `timezone`. Stored as a
  // plain timestamp (no tz conversion) — the sweep interprets it in `timezone`,
  // same as it does cron fields.
  executeAt: timestamp('execute_at'),

  // Date Range (recurring only)
  startDate: timestamp('start_date'),
  endDate: timestamp('end_date'),

  // Status
  isEnabled: boolean('is_enabled').notNull().default(true),

  // Tracking
  nextRunAt: timestamp('next_run_at'),
  lastRunAt: timestamp('last_run_at'),
  lastRunStatus: varchar('last_run_status', { length: 20 }), // completed | failed

  // Statistics
  totalRuns: integer('total_runs').default(0),
  successfulRuns: integer('successful_runs').default(0),
  failedRuns: integer('failed_runs').default(0),

  // Trigger.dev Integration
  triggerDevScheduleId: varchar('trigger_dev_schedule_id', { length: 255 }),
}, (table) => [
  index('workflow_schedules_workflow_idx').on(table.workflowId),
  index('workflow_schedules_is_enabled_idx').on(table.isEnabled),
  index('workflow_schedules_next_run_idx').on(table.nextRunAt),
]);

export type WorkflowSchedule = typeof workflowSchedules.$inferSelect;
export type NewWorkflowSchedule = typeof workflowSchedules.$inferInsert;
