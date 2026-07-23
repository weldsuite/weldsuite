import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { helpdeskWorkflowExecutions } from './helpdesk-workflow-executions';
import { helpdeskWorkflows } from './helpdesk-workflows';

export const helpdeskWorkflowErrorLogs = pgTable('helpdesk_workflow_error_logs', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  // References (proper FKs to helpdesk tables)
  helpdeskWorkflowId: varchar('helpdesk_workflow_id', { length: 30 }).references(() => helpdeskWorkflows.id),
  executionId: varchar('execution_id', { length: 30 }).references(() => helpdeskWorkflowExecutions.id),

  // Helpdesk-specific
  conversationId: varchar('conversation_id', { length: 30 }),

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
  index('hd_wf_error_logs_workflow_idx').on(table.helpdeskWorkflowId),
  index('hd_wf_error_logs_execution_idx').on(table.executionId),
  index('hd_wf_error_logs_conversation_idx').on(table.conversationId),
  index('hd_wf_error_logs_severity_idx').on(table.severity),
  index('hd_wf_error_logs_is_ack_idx').on(table.isAcknowledged),
  index('hd_wf_error_logs_occurred_at_idx').on(table.occurredAt),
]);

export type HelpdeskWorkflowErrorLog = typeof helpdeskWorkflowErrorLogs.$inferSelect;
export type NewHelpdeskWorkflowErrorLog = typeof helpdeskWorkflowErrorLogs.$inferInsert;
