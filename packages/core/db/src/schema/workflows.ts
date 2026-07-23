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

// Workflow Status Types
export type WorkflowStatus = 'draft' | 'active' | 'paused' | 'archived';

// Trigger Types
export type TriggerCategory = 'schedule' | 'entity_event' | 'integration_event' | 'webhook' | 'manual' | 'api' | 'workflow_complete';

// Action Categories
export type ActionCategory = 'communication' | 'data' | 'integration' | 'logic' | 'utility' | 'ai' | 'custom';

// Workflow Step Configuration
export interface WorkflowStep {
  id: string;
  type: string;
  name: string;
  description?: string;
  order?: number;
  config: Record<string, unknown>;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  condition?: {
    field: string;
    operator: string;
    value: unknown;
  };
  onError?: {
    action: 'stop' | 'continue' | 'retry' | 'goto';
    retryCount?: number;
    gotoStep?: string;
  };
  position?: { x: number; y: number };
  timeout?: number;
  retryPolicy?: {
    maxAttempts: number;
    delayMs: number;
    backoffMultiplier?: number;
  };
  continueOnError?: boolean;
  parentBranchId?: string;
}

// Trigger Configuration
export interface TriggerConfig {
  id: string;
  type: TriggerCategory;
  name: string;
  isEnabled: boolean;
  config: ScheduleTriggerConfig | EntityEventTriggerConfig | IntegrationEventTriggerConfig | WebhookTriggerConfig | ManualTriggerConfig | WorkflowCompleteTriggerConfig;
}

export interface ScheduleTriggerConfig {
  type: 'schedule';
  cronExpression: string;
  timezone: string;
  startDate?: string;
  endDate?: string;
}

export interface EntityEventTriggerConfig {
  type: 'entity_event';
  entityType: string;
  eventType: 'created' | 'updated' | 'deleted' | 'status_changed' | 'assigned' | 'tagged' | 'priority_changed' | 'sla_breached';
  filters?: Array<{
    field: string;
    operator: string;
    value: unknown;
  }>;
  /** Channels this workflow applies to (e.g. ['chat', 'discord']). Empty/undefined = all channels. */
  channels?: string[];
  /** Audience group for exclusive matching. Workflows with the same audience compete by sortOrder — first match wins. */
  audience?: string;
}

/**
 * Inbound trigger from a connected third-party integration (Slack, Google
 * Sheets, …). Dispatched by integration-webhook-worker (webhook providers) or a
 * Trigger.dev poll (poll providers), matched in `matchAndDispatchIntegrationTriggers`.
 */
export interface IntegrationEventTriggerConfig {
  type: 'integration_event';
  /** Provider id from the integration catalog, e.g. `slack`, `google_sheets`. */
  provider: string;
  /** Namespaced event id from the catalog, e.g. `slack.message`. */
  event: string;
  /** Pin the trigger to a specific connection; omit to match any connected
   *  integration of this provider in the workspace. */
  integrationId?: string;
  filters?: Array<{
    field: string;
    operator: string;
    value: unknown;
  }>;
}

export interface WebhookTriggerConfig {
  type: 'webhook';
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  validateSignature?: boolean;
  signatureHeader?: string;
}

export interface ManualTriggerConfig {
  type: 'manual';
  inputSchema?: Record<string, unknown>;
}

export interface WorkflowCompleteTriggerConfig {
  type: 'workflow_complete';
  /** The workflow ID that must complete to trigger this workflow */
  sourceWorkflowId: string;
  /** When to trigger: on success, failure, or both */
  triggerOn: 'success' | 'failure' | 'both';
  /** Whether to pass the completed workflow's output as triggerData */
  passOutput?: boolean;
}

// Workflow Settings
export interface WorkflowSettings {
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  notifyOnComplete?: boolean;
  notifyOnError?: boolean;
  notifyEmails?: string[];
  timezone?: string;
  // Per-workflow execution limit (credits/cost per run)
  maxCreditsPerRun?: number;
}

export const workflows = pgTable('workflows', {
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
  triggers: jsonb('triggers').$type<TriggerConfig[]>(),
  steps: jsonb('steps').$type<WorkflowStep[]>(),
  settings: jsonb('settings').$type<WorkflowSettings>(),

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

  // Template reference (if created from template)
  templateId: varchar('template_id', { length: 30 }),
}, (table) => [
  index('workflows_status_idx').on(table.status),
  index('workflows_created_by_idx').on(table.createdBy),
  index('workflows_folder_idx').on(table.folderId),
]);

export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;
