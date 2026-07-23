import {
  pgTable,
  varchar,
  timestamp,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { helpdeskWorkflows } from './helpdesk-workflows';

export const helpdeskWorkflowExecutions = pgTable('helpdesk_workflow_executions', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // Workflow Reference (proper FK to helpdesk_workflows)
  helpdeskWorkflowId: varchar('helpdesk_workflow_id', { length: 30 }).notNull().references(() => helpdeskWorkflows.id),
  workflowVersion: integer('workflow_version').notNull().default(1),
  workflowName: varchar('workflow_name', { length: 255 }), // Snapshot of name at execution time

  // Execution Status
  status: varchar('status', { length: 20 }).notNull().default('queued'), // queued | running | completed | failed | cancelled | timeout | waiting_for_input

  // Trigger Information
  triggeredBy: varchar('triggered_by', { length: 255 }), // User ID or system
  triggerType: varchar('trigger_type', { length: 30 }), // manual | schedule | webhook | entity_event | api
  triggerId: varchar('trigger_id', { length: 30 }), // Reference to specific trigger config
  triggerData: jsonb('trigger_data').$type<Record<string, unknown>>(), // Input data from trigger

  // Helpdesk-specific (first-class columns instead of buried in executionContext)
  conversationId: varchar('conversation_id', { length: 30 }),
  channel: varchar('channel', { length: 30 }), // web | discord | slack | email | api | mobile

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
  }>(),

  // Retry tracking
  retryCount: integer('retry_count').default(0),
  parentExecutionId: varchar('parent_execution_id', { length: 30 }), // If this is a retry
}, (table) => [
  index('hd_wf_exec_workflow_idx').on(table.helpdeskWorkflowId),
  index('hd_wf_exec_status_idx').on(table.status),
  index('hd_wf_exec_triggered_by_idx').on(table.triggeredBy),
  index('hd_wf_exec_trigger_type_idx').on(table.triggerType),
  index('hd_wf_exec_conversation_idx').on(table.conversationId),
  index('hd_wf_exec_started_at_idx').on(table.startedAt),
]);

export type HelpdeskWorkflowExecution = typeof helpdeskWorkflowExecutions.$inferSelect;
export type NewHelpdeskWorkflowExecution = typeof helpdeskWorkflowExecutions.$inferInsert;
