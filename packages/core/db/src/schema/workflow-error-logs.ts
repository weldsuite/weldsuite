import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { workflowExecutions } from './workflow-executions';

// Error Severity Levels
export type ErrorSeverity = 'debug' | 'info' | 'warning' | 'error' | 'critical';

export const workflowErrorLogs = pgTable('workflow_error_logs', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  // References
  workflowId: varchar('workflow_id', { length: 30 }),
  executionId: varchar('execution_id', { length: 30 }).references(() => workflowExecutions.id),

  // Error Details
  errorCode: varchar('error_code', { length: 50 }),
  errorMessage: text('error_message').notNull(),
  errorType: varchar('error_type', { length: 100 }), // ValidationError | NetworkError | TimeoutError | etc
  severity: varchar('severity', { length: 20 }).notNull().default('error'), // debug | info | warning | error | critical
  stackTrace: text('stack_trace'),

  // Step Context
  stepId: varchar('step_id', { length: 50 }),
  stepName: varchar('step_name', { length: 255 }),
  stepType: varchar('step_type', { length: 100 }),

  // Request/Response Context
  input: jsonb('input').$type<Record<string, unknown>>(),
  context: jsonb('context').$type<{
    userId?: string;
    triggerType?: string;
    triggerData?: Record<string, unknown>;
    variables?: Record<string, unknown>;
  }>(),

  // Acknowledgement
  isAcknowledged: boolean('is_acknowledged').notNull().default(false),
  acknowledgedBy: varchar('acknowledged_by', { length: 255 }),
  acknowledgedAt: timestamp('acknowledged_at'),
  acknowledgedNote: text('acknowledged_note'),

  // Timestamp
  occurredAt: timestamp('occurred_at').notNull().defaultNow(),
}, (table) => [
  index('workflow_error_logs_workflow_idx').on(table.workflowId),
  index('workflow_error_logs_execution_idx').on(table.executionId),
  index('workflow_error_logs_severity_idx').on(table.severity),
  index('workflow_error_logs_is_acknowledged_idx').on(table.isAcknowledged),
  index('workflow_error_logs_occurred_at_idx').on(table.occurredAt),
]);

export type WorkflowErrorLog = typeof workflowErrorLogs.$inferSelect;
export type NewWorkflowErrorLog = typeof workflowErrorLogs.$inferInsert;
