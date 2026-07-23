// ──────────────────────────────────────────────
// Helpdesk Workflow Type System
// Owned by helpdesk — independent of WeldConnect workflow types.
// ──────────────────────────────────────────────

// Workflow Status Types
export type HelpdeskWorkflowStatus = 'draft' | 'active' | 'paused' | 'archived';

// Trigger Types
export type HelpdeskTriggerCategory = 'schedule' | 'entity_event' | 'webhook' | 'manual' | 'api' | 'workflow_complete';

// Helpdesk entity types for workflow triggers
export type HelpdeskEntityType =
  | 'helpdesk_conversation'
  | 'helpdesk_ticket'
  | 'helpdesk_conversation_message';

// Finer event types (beyond base CRUD) for helpdesk entities
export type HelpdeskEventType =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'status_changed'
  | 'assigned'
  | 'tagged'
  | 'priority_changed'
  | 'sla_breached';

// Action Categories
export type HelpdeskActionCategory = 'communication' | 'data' | 'integration' | 'logic' | 'utility' | 'ai' | 'custom';

// Workflow Step Configuration
export interface HelpdeskWorkflowStep {
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
export interface HelpdeskTriggerConfig {
  id: string;
  type: HelpdeskTriggerCategory;
  name: string;
  isEnabled: boolean;
  config: HelpdeskScheduleTriggerConfig | HelpdeskEntityEventTriggerConfig | HelpdeskWebhookTriggerConfig | HelpdeskManualTriggerConfig | HelpdeskWorkflowCompleteTriggerConfig;
}

export interface HelpdeskScheduleTriggerConfig {
  type: 'schedule';
  cronExpression: string;
  timezone: string;
  startDate?: string;
  endDate?: string;
}

export interface HelpdeskEntityEventTriggerConfig {
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

export interface HelpdeskWebhookTriggerConfig {
  type: 'webhook';
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  validateSignature?: boolean;
  signatureHeader?: string;
}

export interface HelpdeskManualTriggerConfig {
  type: 'manual';
  inputSchema?: Record<string, unknown>;
}

export interface HelpdeskWorkflowCompleteTriggerConfig {
  type: 'workflow_complete';
  /** The workflow ID that must complete to trigger this workflow */
  sourceWorkflowId: string;
  /** When to trigger: on success, failure, or both */
  triggerOn: 'success' | 'failure' | 'both';
  /** Whether to pass the completed workflow's output as triggerData */
  passOutput?: boolean;
}

// Workflow Settings
export interface HelpdeskWorkflowSettings {
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

// Execution Status Types
export type HelpdeskExecutionStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout' | 'waiting_for_input';

// Trigger Types for Execution
export type HelpdeskExecutionTriggerType = 'manual' | 'schedule' | 'webhook' | 'entity_event' | 'api';

// Step Execution Status
export type HelpdeskStepExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled' | 'waiting_for_input';

// Error Severity Levels
export type HelpdeskErrorSeverity = 'debug' | 'info' | 'warning' | 'error' | 'critical';

// Variable Scope Types
export type HelpdeskVariableScope = 'global' | 'workflow' | 'execution';

// Variable Data Types
export type HelpdeskVariableType = 'string' | 'number' | 'boolean' | 'json' | 'secret';
