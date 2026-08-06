import { z } from 'zod';

// ============================================================================
// Shared WeldConnect contracts (SPA + app-api + workflow-worker)
// ============================================================================

export const workflowStatusSchema = z.enum(['draft', 'active', 'paused', 'archived']);

export const triggerCategorySchema = z.enum([
  'schedule',
  'entity_event',
  'integration_event',
  'webhook',
  'manual',
  'api',
  'workflow_complete',
]);

export const filterSchema = z.object({
  field: z.string(),
  operator: z.string(),
  value: z.unknown(),
});

export const scheduleTriggerConfigSchema = z.object({
  type: z.literal('schedule'),
  cronExpression: z.string().min(1),
  timezone: z.string().default('UTC'),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const entityEventTriggerConfigSchema = z.object({
  type: z.literal('entity_event'),
  entityType: z.string().min(1),
  eventType: z.enum([
    'created',
    'updated',
    'deleted',
    'status_changed',
    'assigned',
    'tagged',
    'priority_changed',
    'sla_breached',
  ]),
  filters: z.array(filterSchema).optional(),
  channels: z.array(z.string()).optional(),
  audience: z.string().optional(),
});

export const integrationEventTriggerConfigSchema = z.object({
  type: z.literal('integration_event'),
  provider: z.string().min(1),
  event: z.string().min(1),
  integrationId: z.string().optional(),
  filters: z.array(filterSchema).optional(),
});

export const webhookTriggerConfigSchema = z.object({
  type: z.literal('webhook'),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).default('POST'),
  headers: z.record(z.string()).optional(),
  validateSignature: z.boolean().optional(),
  signatureHeader: z.string().optional(),
});

export const manualTriggerConfigSchema = z.object({
  type: z.literal('manual'),
  inputSchema: z.record(z.unknown()).optional(),
});

export const workflowCompleteTriggerConfigSchema = z.object({
  type: z.literal('workflow_complete'),
  sourceWorkflowId: z.string().min(1),
  triggerOn: z.enum(['success', 'failure', 'both']).default('success'),
  passOutput: z.boolean().optional(),
});

export const triggerConfigSchema = z.object({
  id: z.string().min(1),
  type: triggerCategorySchema,
  name: z.string().min(1),
  isEnabled: z.boolean().default(true),
  config: z.union([
    scheduleTriggerConfigSchema,
    entityEventTriggerConfigSchema,
    integrationEventTriggerConfigSchema,
    webhookTriggerConfigSchema,
    manualTriggerConfigSchema,
    workflowCompleteTriggerConfigSchema,
    z.record(z.unknown()),
  ]),
});

export const workflowStepSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  order: z.number().optional(),
  config: z.record(z.unknown()).default({}),
  inputs: z.record(z.unknown()).default({}),
  outputs: z.record(z.unknown()).optional(),
  condition: z
    .object({
      field: z.string(),
      operator: z.string(),
      value: z.unknown(),
    })
    .optional(),
  onError: z
    .object({
      action: z.enum(['stop', 'continue', 'retry', 'goto']),
      retryCount: z.number().optional(),
      gotoStep: z.string().optional(),
    })
    .optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  timeout: z.number().optional(),
  retryPolicy: z
    .object({
      maxAttempts: z.number(),
      delayMs: z.number(),
      backoffMultiplier: z.number().optional(),
    })
    .optional(),
  continueOnError: z.boolean().optional(),
  parentBranchId: z.string().optional(),
});

export const workflowSettingsSchema = z.object({
  timeout: z.number().optional(),
  maxRetries: z.number().optional(),
  retryDelay: z.number().optional(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  notifyOnComplete: z.boolean().optional(),
  notifyOnError: z.boolean().optional(),
  notifyEmails: z.array(z.string()).optional(),
  timezone: z.string().optional(),
  maxCreditsPerRun: z.number().optional(),
});

// ============================================================================
// Workflow Schemas
// ============================================================================

export const createWorkflowSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().nullable().optional(),
  status: z.enum(['draft', 'active', 'paused']).default('draft'),
  // Loose at the wire for editor drafts; activate-time validation uses the tight schemas.
  triggers: z.array(z.union([triggerConfigSchema, z.record(z.unknown())])).optional(),
  steps: z.array(z.union([workflowStepSchema, z.record(z.unknown())])).optional(),
  settings: z.union([workflowSettingsSchema, z.record(z.unknown())]).optional(),
  tags: z.array(z.string()).optional(),
  folderId: z.string().nullish(),
});

export const updateWorkflowSchema = createWorkflowSchema.partial();

export const listWorkflowsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
  search: z.string().optional(),
  status: workflowStatusSchema.optional(),
  triggerType: z.string().optional(),
  folderId: z.string().optional(),
  tags: z.string().optional(),
  excludeTags: z.string().optional(),
});

export const updateWorkflowStatusSchema = z.object({
  status: workflowStatusSchema,
});

export const triggerWorkflowSchema = z.object({
  testData: z.record(z.unknown()).optional(),
  data: z.record(z.unknown()).optional(),
});

// ============================================================================
// Execution Schemas
// ============================================================================

export const listExecutionsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
  workflowId: z.string().optional(),
  status: z
    .enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'timeout', 'waiting_for_input'])
    .optional(),
  triggerType: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const resumeExecutionSchema = z.object({
  stepId: z.string(),
  response: z.record(z.unknown()),
});

// ============================================================================
// Template Schemas
// ============================================================================

export const createTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  category: z.string().optional(),
  difficulty: z.enum(['beginner', 'intermediate', 'advanced']).default('beginner'),
  triggers: z.array(z.union([triggerConfigSchema, z.record(z.unknown())])).optional(),
  steps: z.array(z.union([workflowStepSchema, z.record(z.unknown())])).optional(),
  settings: z.union([workflowSettingsSchema, z.record(z.unknown())]).optional(),
  tags: z.array(z.string()).optional(),
  icon: z.string().optional(),
  isPremium: z.boolean().optional(),
});

export const updateTemplateSchema = createTemplateSchema.partial();

export const listTemplatesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
  search: z.string().optional(),
  category: z.string().optional(),
  difficulty: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
});

// ============================================================================
// Schedule Schemas
// ============================================================================

export const createScheduleSchema = z.object({
  workflowId: z.string(),
  triggerId: z.string().nullish(),
  name: z.string().min(1).max(255),
  cronExpression: z.string(),
  timezone: z.string().default('UTC'),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  isEnabled: z.boolean().default(true),
});

export const updateScheduleSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  cronExpression: z.string().optional(),
  timezone: z.string().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  isEnabled: z.boolean().optional(),
});

export const listSchedulesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
  workflowId: z.string().optional(),
  isEnabled: z.coerce.boolean().optional(),
});

// ============================================================================
// Variable Schemas
// ============================================================================

export const createVariableSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  type: z.enum(['string', 'number', 'boolean', 'json']).default('string'),
  value: z.string(),
  isSecret: z.boolean().default(false),
  isGlobal: z.boolean().default(false),
  scope: z.enum(['global', 'workflow', 'execution']).optional(),
  workflowId: z.string().nullish(),
});

export const updateVariableSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  type: z.enum(['string', 'number', 'boolean', 'json']).optional(),
  value: z.string().optional(),
});

export const listVariablesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
  search: z.string().optional(),
  workflowId: z.string().optional(),
  scope: z.enum(['global', 'workflow', 'all']).default('all'),
  isSecret: z.coerce.boolean().optional(),
});

// ============================================================================
// Webhook Schemas
// ============================================================================

export const createWebhookSchema = z.object({
  workflowId: z.string(),
  triggerId: z.string().nullish(),
  name: z.string().optional(),
  description: z.string().optional(),
  validateSignature: z.boolean().optional(),
  signatureHeader: z.string().optional(),
  allowedMethods: z.array(z.string()).optional(),
  ipWhitelist: z.array(z.string()).optional(),
});

export const updateWebhookSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  validateSignature: z.boolean().optional(),
  signatureHeader: z.string().optional(),
  allowedMethods: z.array(z.string()).optional(),
  ipWhitelist: z.array(z.string()).optional(),
  isEnabled: z.boolean().optional(),
});

// ============================================================================
// Integration Schemas
// ============================================================================

export const createIntegrationSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.string(),
  category: z.string().optional(),
  icon: z.string().optional(),
  website: z.string().optional(),
  config: z.record(z.unknown()).optional(),
  credentials: z.record(z.unknown()).optional(),
  authType: z.string().optional(),
});

export const updateIntegrationSchema = createIntegrationSchema.partial();

// ============================================================================
// Inferred Types
// ============================================================================

export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;
export type UpdateWorkflowInput = z.infer<typeof updateWorkflowSchema>;
export type ListWorkflowsQuery = z.infer<typeof listWorkflowsQuery>;
export type TriggerWorkflowInput = z.infer<typeof triggerWorkflowSchema>;
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type TriggerConfig = z.infer<typeof triggerConfigSchema>;
export type WorkflowSettings = z.infer<typeof workflowSettingsSchema>;

export type ListExecutionsQuery = z.infer<typeof listExecutionsQuery>;
export type ResumeExecutionInput = z.infer<typeof resumeExecutionSchema>;

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
export type ListTemplatesQuery = z.infer<typeof listTemplatesQuery>;

export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;
export type UpdateScheduleInput = z.infer<typeof updateScheduleSchema>;
export type ListSchedulesQuery = z.infer<typeof listSchedulesQuery>;

export type CreateVariableInput = z.infer<typeof createVariableSchema>;
export type UpdateVariableInput = z.infer<typeof updateVariableSchema>;
export type ListVariablesQuery = z.infer<typeof listVariablesQuery>;

export interface Workflow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  triggers: TriggerConfig[];
  steps: WorkflowStep[];
  settings: WorkflowSettings | null;
  tags: string[] | null;
  folderId: string | null;
  createdBy: string | null;
  version: number;
  executionCount: number;
  successCount: number;
  failureCount: number;
  averageExecutionTime: number | null;
  lastExecutedAt: string | null;
  templateId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowExecution {
  id: string;
  workflowId: string;
  workflowVersion: number;
  workflowName: string | null;
  status: string;
  triggeredBy: string | null;
  triggerType: string | null;
  triggerData: Record<string, unknown> | null;
  totalSteps: number;
  currentStepIndex: number;
  startedAt: string | null;
  completedAt: string | null;
  duration: number | null;
  output: Record<string, unknown> | null;
  error: { message: string; stepId?: string; stepName?: string } | null;
  cfWorkflowInstanceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionStep {
  id: string;
  executionId: string;
  stepId: string;
  stepName: string;
  stepType: string;
  stepIndex: number;
  status: string;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: { message: string } | null;
  startedAt: string | null;
  completedAt: string | null;
  duration: number | null;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  difficulty: string;
  triggers: TriggerConfig[];
  steps: WorkflowStep[];
  settings: WorkflowSettings | null;
  tags: string[] | null;
  icon: string | null;
  isPremium: boolean;
  useCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowSchedule {
  id: string;
  workflowId: string;
  triggerId: string | null;
  name: string | null;
  cronExpression: string;
  timezone: string;
  startDate: string | null;
  endDate: string | null;
  isEnabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  totalRuns: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowVariable {
  id: string;
  name: string;
  description: string | null;
  type: string;
  value: string;
  isSecret: boolean;
  isGlobal: boolean;
  workflowId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardStats {
  workflows: { total: number; active: number; draft: number; paused: number; archived: number };
  executions: { total: number; running: number; completed: number; failed: number; queued: number };
  triggers: { schedules: number; webhooks: number };
}
