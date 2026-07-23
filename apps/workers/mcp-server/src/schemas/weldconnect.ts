// AUTO-COPIED from @weldsuite/core-api-client/schemas/weldconnect
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/{core-api,app-api}-client. Keep in sync with source.

import { z } from 'zod';

// ============================================================================
// Workflow Schemas
// ============================================================================

export const createWorkflowSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().nullable().optional(),
  status: z.enum(['draft', 'active', 'paused']).default('draft'),
  triggers: z.array(z.record(z.unknown())).optional(),
  steps: z.array(z.record(z.unknown())).optional(),
  settings: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
  folderId: z.string().nullish(),
});

export const updateWorkflowSchema = createWorkflowSchema.partial();

export const listWorkflowsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
  search: z.string().optional(),
  status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
  triggerType: z.string().optional(),
  folderId: z.string().optional(),
  tags: z.string().optional(),
  excludeTags: z.string().optional(),
});

export const updateWorkflowStatusSchema = z.object({
  status: z.enum(['draft', 'active', 'paused', 'archived']),
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
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'timeout']).optional(),
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
  triggers: z.array(z.record(z.unknown())).optional(),
  steps: z.array(z.record(z.unknown())).optional(),
  settings: z.record(z.unknown()).optional(),
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
// Trigger Schemas
// ============================================================================

export const createTriggerSchema = z.object({
  workflowId: z.string(),
  name: z.string().optional(),
  category: z.string(),
  config: z.record(z.unknown()).optional(),
  isEnabled: z.boolean().default(true),
  entityType: z.string().optional(),
  eventType: z.string().optional(),
  filters: z.record(z.unknown()).optional(),
  cronExpression: z.string().optional(),
  timezone: z.string().optional(),
});

export const updateTriggerSchema = z.object({
  name: z.string().optional(),
  category: z.string().optional(),
  config: z.record(z.unknown()).optional(),
  isEnabled: z.boolean().optional(),
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

// ============================================================================
// Response Types
// ============================================================================

export interface Workflow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  triggers: unknown[];
  steps: unknown[];
  settings: Record<string, unknown> | null;
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
  triggers: unknown[];
  steps: unknown[];
  settings: Record<string, unknown> | null;
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
