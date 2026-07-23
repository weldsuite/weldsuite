import {
  pgTable,
  varchar,
  text,
  timestamp,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { workflowExecutions } from './workflow-executions';

// Step Execution Status
export type StepExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled' | 'waiting_for_input';

export const workflowExecutionSteps = pgTable('workflow_execution_steps', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  // Execution Reference
  executionId: varchar('execution_id', { length: 30 }).notNull().references(() => workflowExecutions.id),

  // Step Information
  stepId: varchar('step_id', { length: 50 }).notNull(), // ID from workflow definition
  stepName: varchar('step_name', { length: 255 }),
  stepType: varchar('step_type', { length: 100 }), // Action type
  stepIndex: integer('step_index').notNull().default(0),

  // Status
  status: varchar('status', { length: 20 }).notNull().default('pending'), // pending | running | completed | failed | skipped | cancelled

  // Timing
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  duration: integer('duration'), // milliseconds

  // Data
  input: jsonb('input').$type<Record<string, unknown>>(),
  output: jsonb('output').$type<Record<string, unknown>>(),
  error: jsonb('error').$type<{
    message: string;
    code?: string;
    stack?: string;
  }>(),

  // Retry tracking
  retryCount: integer('retry_count').default(0),
  maxRetries: integer('max_retries').default(0),

  // Logs
  logs: jsonb('logs').$type<Array<{
    timestamp: string;
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    data?: Record<string, unknown>;
  }>>(),
}, (table) => [
  index('workflow_execution_steps_execution_idx').on(table.executionId),
  index('workflow_execution_steps_step_idx').on(table.stepId),
  index('workflow_execution_steps_status_idx').on(table.status),
]);

export type WorkflowExecutionStep = typeof workflowExecutionSteps.$inferSelect;
export type NewWorkflowExecutionStep = typeof workflowExecutionSteps.$inferInsert;
