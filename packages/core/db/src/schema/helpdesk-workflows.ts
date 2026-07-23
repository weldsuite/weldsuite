import {
  pgTable,
  varchar,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  numeric,
} from 'drizzle-orm/pg-core';
import type { HelpdeskTriggerConfig, HelpdeskWorkflowStep, HelpdeskWorkflowSettings } from './helpdesk-workflow-types';

export const helpdeskWorkflows = pgTable('helpdesk_workflows', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Basic Info
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  status: varchar('status', { length: 20 }).notNull().default('draft'), // draft | active | paused | archived
  version: integer('version').notNull().default(1),

  // Workflow Configuration (stored as JSONB)
  triggers: jsonb('triggers').$type<HelpdeskTriggerConfig[]>(),
  steps: jsonb('steps').$type<HelpdeskWorkflowStep[]>(),
  settings: jsonb('settings').$type<HelpdeskWorkflowSettings>(),

  // Ownership
  createdBy: varchar('created_by', { length: 255 }),
  folderId: varchar('folder_id', { length: 255 }),
  tags: jsonb('tags').$type<string[]>(),

  // Statistics
  executionCount: integer('execution_count').default(0),
  successCount: integer('success_count').default(0),
  failureCount: integer('failure_count').default(0),
  averageExecutionTime: numeric('average_execution_time', { precision: 10, scale: 2 }),
  lastExecutedAt: timestamp('last_executed_at'),

  // Execution order within the same trigger group (lower = runs first)
  sortOrder: integer('sort_order').notNull().default(0),

  // Template reference (if created from template)
  templateId: varchar('template_id', { length: 30 }),
}, (table) => [
  index('helpdesk_workflows_status_idx').on(table.status),
  index('helpdesk_workflows_created_by_idx').on(table.createdBy),
  index('helpdesk_workflows_folder_idx').on(table.folderId),
]);

export type HelpdeskWorkflow = typeof helpdeskWorkflows.$inferSelect;
export type NewHelpdeskWorkflow = typeof helpdeskWorkflows.$inferInsert;
