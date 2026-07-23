import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
// Trigger Category Types
export type TriggerCategory = 'schedule' | 'entity_event' | 'webhook' | 'manual' | 'api';

export const workflowTriggers = pgTable('workflow_triggers', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Workflow Reference
  workflowId: varchar('workflow_id', { length: 30 }).notNull(),

  // Trigger Info
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  category: varchar('category', { length: 30 }).notNull(), // schedule | entity_event | webhook | manual | api

  // Configuration (polymorphic based on category)
  config: jsonb('config').$type<Record<string, unknown>>().notNull(),

  // Status
  isEnabled: boolean('is_enabled').notNull().default(true),

  // Scheduling (for schedule triggers)
  nextRunAt: timestamp('next_run_at'),
  lastRunAt: timestamp('last_run_at'),

  // Statistics
  totalRuns: integer('total_runs').default(0),
  successfulRuns: integer('successful_runs').default(0),
  failedRuns: integer('failed_runs').default(0),

  // External References
  triggerDevScheduleId: varchar('trigger_dev_schedule_id', { length: 255 }),
}, (table) => [
  index('workflow_triggers_workflow_idx').on(table.workflowId),
  index('workflow_triggers_category_idx').on(table.category),
  index('workflow_triggers_is_enabled_idx').on(table.isEnabled),
  index('workflow_triggers_next_run_idx').on(table.nextRunAt),
]);

export type WorkflowTrigger = typeof workflowTriggers.$inferSelect;
export type NewWorkflowTrigger = typeof workflowTriggers.$inferInsert;
