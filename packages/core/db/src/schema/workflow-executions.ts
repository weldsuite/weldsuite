import {
  pgTable,
  varchar,
  text,
  timestamp,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
// Execution Status Types
export type ExecutionStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout' | 'waiting_for_input';

// Trigger Types for Execution
export type ExecutionTriggerType =
  | 'manual'
  | 'schedule'
  | 'webhook'
  | 'entity_event'
  | 'integration_event'
  | 'workflow_complete'
  | 'api';

export const workflowExecutions = pgTable('workflow_executions', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // Workflow Reference
  workflowId: varchar('workflow_id', { length: 30 }).notNull(),
  workflowVersion: integer('workflow_version').notNull().default(1),
  workflowName: varchar('workflow_name', { length: 255 }), // Snapshot of name at execution time

  // Execution Status
  status: varchar('status', { length: 20 }).notNull().default('queued'), // queued | running | completed | failed | cancelled | timeout

  // Trigger Information
  triggeredBy: varchar('triggered_by', { length: 255 }), // User ID or system
  triggerType: varchar('trigger_type', { length: 30 }), // manual | schedule | webhook | entity_event | api
  triggerId: varchar('trigger_id', { length: 30 }), // Reference to specific trigger config
  triggerData: jsonb('trigger_data').$type<Record<string, unknown>>(), // Input data from trigger

  // Timing
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  duration: integer('duration'), // milliseconds

  // Step Tracking
  currentStepId: varchar('current_step_id', { length: 50 }),
  currentStepIndex: integer('current_step_index').default(0),
  totalSteps: integer('total_steps').default(0),

  // Results
  output: jsonb('output').$type<Record<string, unknown>>(), // Final output data
  error: jsonb('error').$type<{
    message: string;
    code?: string;
    stepId?: string;
    stepName?: string;
    stack?: string;
  }>(),

  // Execution Context
  executionContext: jsonb('execution_context').$type<{
    variables?: Record<string, unknown>;
    stepOutputs?: Record<string, unknown>;
    stepResults?: Record<string, unknown>;
    waitingForInput?: {
      conversationId: string;
      messageId: string;
      stepId: string;
      stepType: 'send_choices' | 'collect_input';
    };
    waitpointTokenId?: string;
    waitpointTokenUrl?: string;
    /** Step ID currently waiting for customer response */
    waitingStepId?: string;
    /** Step ID of active AI handler */
    aiStepId?: string;
    /** Conversation ID this execution belongs to */
    conversationId?: string;
  }>(),

  // Trigger.dev Integration (legacy)
  triggerDevRunId: varchar('trigger_dev_run_id', { length: 255 }),

  // Cloudflare Workflow Integration
  cfWorkflowInstanceId: varchar('cf_workflow_instance_id', { length: 255 }),

  // Retry tracking
  retryCount: integer('retry_count').default(0),
  parentExecutionId: varchar('parent_execution_id', { length: 30 }), // If this is a retry
}, (table) => [
  index('workflow_executions_workflow_idx').on(table.workflowId),
  index('workflow_executions_status_idx').on(table.status),
  index('workflow_executions_triggered_by_idx').on(table.triggeredBy),
  index('workflow_executions_trigger_type_idx').on(table.triggerType),
  index('workflow_executions_trigger_dev_run_idx').on(table.triggerDevRunId),
  index('workflow_executions_started_at_idx').on(table.startedAt),
]);

export type WorkflowExecution = typeof workflowExecutions.$inferSelect;
export type NewWorkflowExecution = typeof workflowExecutions.$inferInsert;
