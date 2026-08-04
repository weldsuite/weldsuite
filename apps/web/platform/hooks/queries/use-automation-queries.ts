
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type {
  Workflow,
  WorkflowExecution,
  WorkflowTemplate,
  WorkflowVariable,
  ExecutionStep,
} from '@weldsuite/core-api-client/schemas/weldconnect';
import type { ExecutionLogEntry } from '@/app/weldconnect/executions/[id]/execution-detail-client';

// Re-export types
export type {
  Workflow,
  WorkflowExecution,
  WorkflowTemplate,
  
  WorkflowVariable,
  
} from '@weldsuite/core-api-client/schemas/weldconnect';export type WorkflowWebhook = Record<string, unknown>;
export type WorkflowErrorLog = Record<string, unknown>;
export type ActionType = { id: string; name: string; description: string; category: string; icon?: string };
export type TriggerType = { id: string; name: string; description: string; category: string; icon?: string };
export type EntityEvent = {
  entityType: string;
  // Bare type strings (e.g. "created") — see the comment in
  // app/weldconnect/triggers/page.tsx for how these get a display name.
  events: string[];
  category?: string;
  label?: string;
};export type PaginationMeta = { page: number; pageSize: number; totalCount: number; totalPages: number; hasMore: boolean };
/** app-api list envelope pagination — opaque cursor, no page/totalPages. */
export type CursorPaginationMeta = { totalCount: number; hasMore: boolean; cursor: string | null };

/** Canonical WeldConnect API paths on app-api (`/api/weldconnect/*`). */
export const WELDCONNECT_API = {
  workflows: '/weldconnect/workflows',
  executions: '/weldconnect/workflow-executions',
  templates: '/weldconnect/workflow-templates',
  variables: '/weldconnect/workflow-variables',
  webhooks: '/weldconnect/workflow-webhooks',
  dashboard: '/weldconnect/workflow-dashboard',
  integrations: '/weldconnect/workflow-integrations',
} as const;

// =============================================================================
// Query Keys
// =============================================================================

const helpdeskAutomationKeys = {
  all: ['helpdesk-automation'] as const,
  workflows: (filters?: unknown) => [...helpdeskAutomationKeys.all, 'workflows', filters] as const,
  workflow: (id: string) => [...helpdeskAutomationKeys.all, 'workflow', id] as const,
  workflowStats: () => [...helpdeskAutomationKeys.all, 'workflow-stats'] as const,
};

export const automationKeys = {
  all: ['automation'] as const,
  dashboard: () => [...automationKeys.all, 'dashboard'] as const,
  dashboardChart: (months?: number) => [...automationKeys.all, 'dashboard-chart', months] as const,
  search: (query?: string) => [...automationKeys.all, 'search', query] as const,
  workflows: (filters?: unknown) => [...automationKeys.all, 'workflows', filters] as const,
  workflow: (id: string) => [...automationKeys.all, 'workflow', id] as const,
  workflowStats: () => [...automationKeys.all, 'workflow-stats'] as const,
  workflowMetrics: (id: string) => [...automationKeys.all, 'workflow-metrics', id] as const,
  workflowsForChaining: (excludeId?: string) => [...automationKeys.all, 'workflows-chaining', excludeId] as const,
  executions: (filters?: unknown) => [...automationKeys.all, 'executions', filters] as const,
  execution: (id: string) => [...automationKeys.all, 'execution', id] as const,
  executionSteps: (id: string) => [...automationKeys.all, 'execution-steps', id] as const,
  executionLogs: (id: string) => [...automationKeys.all, 'execution-logs', id] as const,
  executionTrends: (period?: string) => [...automationKeys.all, 'execution-trends', period] as const,
  recentExecutions: (limit?: number) => [...automationKeys.all, 'recent-executions', limit] as const,
  slowExecutions: (limit?: number) => [...automationKeys.all, 'slow-executions', limit] as const,
  templates: (filters?: unknown) => [...automationKeys.all, 'templates', filters] as const,
  template: (id: string) => [...automationKeys.all, 'template', id] as const,
  templateCategories: () => [...automationKeys.all, 'template-categories'] as const,
  schedules: (filters?: unknown) => [...automationKeys.all, 'schedules', filters] as const,
  schedule: (id: string) => [...automationKeys.all, 'schedule', id] as const,
  integrations: (filters?: unknown) => [...automationKeys.all, 'integrations', filters] as const,
  integration: (id: string) => [...automationKeys.all, 'integration', id] as const,
  variables: (filters?: unknown) => [...automationKeys.all, 'variables', filters] as const,
  variable: (id: string) => [...automationKeys.all, 'variable', id] as const,
  triggers: (filters?: unknown) => [...automationKeys.all, 'triggers', filters] as const,
  trigger: (id: string) => [...automationKeys.all, 'trigger', id] as const,
  webhooks: (filters?: unknown) => [...automationKeys.all, 'webhooks', filters] as const,
  webhook: (id: string) => [...automationKeys.all, 'webhook', id] as const,
  webhookEvents: (id: string) => [...automationKeys.all, 'webhook-events', id] as const,
  actionTypes: (params?: unknown) => [...automationKeys.all, 'action-types', params] as const,
  triggerTypes: (params?: unknown) => [...automationKeys.all, 'trigger-types', params] as const,
  entityEvents: () => [...automationKeys.all, 'entity-events'] as const,
  errorStats: (params?: unknown) => [...automationKeys.all, 'error-stats', params] as const,
  performanceMetrics: (workflowId?: string) => [...automationKeys.all, 'performance-metrics', workflowId] as const,
  resourceUsage: () => [...automationKeys.all, 'resource-usage'] as const,
};

// =============================================================================
// Helper to build query string
// =============================================================================

function buildQueryString(params: Record<string, unknown>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  }
  const qs = searchParams.toString();
  return qs ? `?${qs}` : '';
}// 4. Workflows (list)
export function useWorkflows(filters?: Record<string, unknown>) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.workflows(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(filters || {});
      return client.get<{ data: Workflow[]; pagination: PaginationMeta }>(`${WELDCONNECT_API.workflows}${query}`);
    },
  });
}
// 6. Workflow Stats
export function useWorkflowStats() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.workflowStats(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: {
        totalWorkflows: number;
        activeWorkflows: number;
        draftWorkflows: number;
        pausedWorkflows: number;
        totalExecutions: number;
        successfulExecutions: number;
        failedExecutions: number;
        pendingExecutions: number;
      } }>(`${WELDCONNECT_API.workflows}/stats`);
    },
  });
}

// Helpdesk Workflows (list) — app-api `/helpdesk-workflows` (cursor paginated).
export function useHelpdeskWorkflows(filters?: Record<string, unknown>) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskAutomationKeys.workflows(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(filters || {});
      return client.get<{ data: Workflow[]; pagination: CursorPaginationMeta }>(`/helpdesk-workflows${query}`);
    },
  });
}

// Helpdesk Workflow Stats — app-api `/helpdesk-workflows/stats`.
export function useHelpdeskWorkflowStats() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskAutomationKeys.workflowStats(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: {
        totalWorkflows: number;
        activeWorkflows: number;
        draftWorkflows: number;
        pausedWorkflows: number;
        totalExecutions: number;
        successfulExecutions: number;
        failedExecutions: number;
        pendingExecutions: number;
      } }>('/helpdesk-workflows/stats');
    },
  });
}// 9. Executions (list)
export function useExecutions(filters?: Record<string, unknown>) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.executions(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(filters || {});
      return client.get<{ data: WorkflowExecution[]; pagination: PaginationMeta }>(`${WELDCONNECT_API.executions}${query}`);
    },
  });
}

// 10. Execution (single)
export function useExecution(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.execution(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: WorkflowExecution }>(`${WELDCONNECT_API.executions}/${id}`);
    },
    enabled: !!id && enabled,
  });
}

// 11. Recent Executions
export function useRecentExecutions(limit = 10) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.recentExecutions(limit),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: WorkflowExecution[] }>(`${WELDCONNECT_API.executions}/recent?limit=${limit}`);
    },
  });
}

// 12. Execution Steps
export function useExecutionSteps(executionId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.executionSteps(executionId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: ExecutionStep[] }>(`${WELDCONNECT_API.executions}/${executionId}/steps`);
    },
    enabled: !!executionId && enabled,
  });
}

// 13. Execution Logs
export function useExecutionLogs(executionId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.executionLogs(executionId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: ExecutionLogEntry[] }>(`${WELDCONNECT_API.executions}/${executionId}/logs`);
    },
    enabled: !!executionId && enabled,
  });
}

// 14. Execution Trends
export function useExecutionTrends(period?: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.executionTrends(period),
    queryFn: async () => {
      const client = await getClient();
      const query = period ? `?period=${period}` : '';
      return client.get<{ data: {
        trends: Array<{ date: string; total: number; success: number; failure: number }>;
      } }>(`${WELDCONNECT_API.executions}/trends${query}`);
    },
  });
}

// 15. Slow Executions
export function useSlowExecutions(limit = 10) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.slowExecutions(limit),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: WorkflowExecution[] }>(`${WELDCONNECT_API.executions}/slow?limit=${limit}`);
    },
  });
}

// 16. Action Types
export function useActionTypes(params?: { category?: string; search?: string }) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.actionTypes(params),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(params || {});
      return client.get<{ success: boolean; data: ActionType[] }>(`${WELDCONNECT_API.dashboard}/action-types${query}`);
    },
  });
}

// 17. Trigger Types
export function useTriggerTypes(params?: { category?: string; search?: string }) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.triggerTypes(params),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(params || {});
      return client.get<{ success: boolean; data: TriggerType[] }>(`${WELDCONNECT_API.dashboard}/trigger-types${query}`);
    },
  });
}

// 18. Entity Events
export function useEntityEvents() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.entityEvents(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ success: boolean; data: EntityEvent[] }>(`${WELDCONNECT_API.dashboard}/entity-events`);
    },
  });
}

// 19. Performance Metrics
export function usePerformanceMetrics(workflowId?: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.performanceMetrics(workflowId),
    queryFn: async () => {
      const client = await getClient();
      const query = workflowId ? `?workflowId=${workflowId}` : '';
      return client.get<{ success: boolean; data: {
        totalExecutions: number;
        completedExecutions: number;
        averageDuration: number;
        minDuration: number;
        maxDuration: number;
      } }>(`${WELDCONNECT_API.dashboard}/performance${query}`);
    },
  });
}

// 20. Error Stats
export function useErrorStats(params?: { workflowId?: string; page?: number; limit?: number; isAcknowledged?: boolean }) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.errorStats(params),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(params || {});
      return client.get<{ success: boolean; data: {
        total: number;
        unacknowledged: number;
        byType: Record<string, number>;
        items: WorkflowErrorLog[];
        page: number;
        limit: number;
      } }>(`${WELDCONNECT_API.dashboard}/errors${query}`);
    },
  });
}// 23. Template (single)
export function useTemplate(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.template(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: WorkflowTemplate }>(`${WELDCONNECT_API.templates}/${id}`);
    },
    enabled: !!id && enabled,
  });
}// 29. Variables (list)
export function useVariables(filters?: Record<string, unknown>) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.variables(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(filters || {});
      return client.get<{ data: WorkflowVariable[]; pagination: PaginationMeta }>(`${WELDCONNECT_API.variables}${query}`);
    },
  });
}// 33. Webhooks (list)
export function useWebhooks(filters?: Record<string, unknown>) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.webhooks(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(filters || {});
      return client.get<{ success: boolean; data: WorkflowWebhook[]; pagination: PaginationMeta }>(`${WELDCONNECT_API.webhooks}${query}`);
    },
  });
}

// 34. Webhook (single)
export function useWebhook(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.webhook(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ success: boolean; data: WorkflowWebhook }>(`${WELDCONNECT_API.webhooks}/${id}`);
    },
    enabled: !!id && enabled,
  });
}

// 35. Webhook Events
export function useWebhookEvents(webhookId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.webhookEvents(webhookId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ success: boolean; data: Array<{
        id: string;
        timestamp: string;
        status: string;
        sourceIp?: string;
      }> }>(`${WELDCONNECT_API.webhooks}/${webhookId}/events`);
    },
    enabled: !!webhookId && enabled,
  });
}
// =============================================================================
// Mutation Hooks
// =============================================================================

// ---- Workflows ----

// `apiBasePath` lets the same hook back two different surfaces, both on app-api:
//   `/weldconnect/workflows` — WeldConnect automation (default)
//   `/helpdesk-workflows`    — WeldDesk helpdesk workflows
// The two differ only in the mount path and the query keys they invalidate.

// 1. Create Workflow
export function useCreateWorkflow(apiBasePath = WELDCONNECT_API.workflows) {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  const isHelpdesk = apiBasePath.startsWith('/helpdesk');
  return useMutation({
    mutationFn: async (data: {
      name: string;
      description?: string;
      status?: string;
      triggers?: unknown[];
      steps?: unknown[];
      settings?: Record<string, unknown>;
      tags?: string[];
      folderId?: string;
    }) => {
      const client = await getClient();
      return client.post<{ data: Workflow }>(apiBasePath, data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: isHelpdesk ? helpdeskAutomationKeys.workflows() : automationKeys.workflows() });
    },
  });
}

// 2. Update Workflow
export function useUpdateWorkflow(apiBasePath = WELDCONNECT_API.workflows) {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  const isHelpdesk = apiBasePath.startsWith('/helpdesk');
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: {
      name?: string;
      description?: string;
      status?: string;
      triggers?: unknown[];
      steps?: unknown[];
      settings?: Record<string, unknown>;
      tags?: string[];
      folderId?: string;
    } }) => {
      const client = await getClient();
      // PATCH (not PUT): `/api/workflows/:id` accepts both, `/api/helpdesk-workflows/:id`
      // only registers PATCH. Both bodies are passthrough partials.
      return client.patch<{ data: Workflow }>(`${apiBasePath}/${id}`, data);
    },
    onSuccess: (_data, variables) => {
      if (isHelpdesk) {
        qc.invalidateQueries({ queryKey: helpdeskAutomationKeys.workflows() });
        qc.invalidateQueries({ queryKey: helpdeskAutomationKeys.workflow(variables.id) });
      } else {
        qc.invalidateQueries({ queryKey: automationKeys.workflows() });
        qc.invalidateQueries({ queryKey: automationKeys.workflow(variables.id) });
      }
    },
  });
}

// 3. Delete Workflow
export function useDeleteWorkflow(apiBasePath = WELDCONNECT_API.workflows) {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  const isHelpdesk = apiBasePath.startsWith('/helpdesk');
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      // app-api delete → 204 No Content.
      return client.delete<void>(`${apiBasePath}/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: isHelpdesk ? helpdeskAutomationKeys.workflows() : automationKeys.workflows() });
    },
  });
}

// 4. Update Workflow Status
export function useUpdateWorkflowStatus(apiBasePath = WELDCONNECT_API.workflows) {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  const isHelpdesk = apiBasePath.startsWith('/helpdesk');
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const client = await getClient();
      return client.patch<{ data: { id: string; status: string } }>(`${apiBasePath}/${id}/status`, { status });
    },
    onSuccess: (_data, variables) => {
      if (isHelpdesk) {
        qc.invalidateQueries({ queryKey: helpdeskAutomationKeys.workflows() });
        qc.invalidateQueries({ queryKey: helpdeskAutomationKeys.workflow(variables.id) });
      } else {
        qc.invalidateQueries({ queryKey: automationKeys.workflows() });
        qc.invalidateQueries({ queryKey: automationKeys.workflow(variables.id) });
      }
    },
  });
}

// 4b. Generate Workflow with AI — single-shot draft, nothing persisted.
// See apps/workers/app-api/src/routes/workflows/generate.ts. WeldConnect workflows only;
// `/helpdesk-workflows` has no AI generation endpoint.
export interface GeneratedWorkflowTrigger {
  id: string;
  type: string;
  name: string;
  isEnabled: boolean;
  config: Record<string, unknown>;
}

export interface GeneratedWorkflowStep {
  id: string;
  type: string;
  name: string;
  description?: string;
  config: Record<string, unknown>;
}

export interface GeneratedWorkflowDraft {
  name: string;
  description?: string;
  triggers: GeneratedWorkflowTrigger[];
  steps: GeneratedWorkflowStep[];
}

export function useGenerateWorkflow() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (prompt: string) => {
      const client = await getClient();
      return client.post<{ data: { workflow: GeneratedWorkflowDraft; warnings: string[] } }>(
        `${WELDCONNECT_API.workflows}/generate`,
        { prompt },
      );
    },
  });
}

// 5. Duplicate Workflow
export function useDuplicateWorkflow(apiBasePath = WELDCONNECT_API.workflows) {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  const isHelpdesk = apiBasePath.startsWith('/helpdesk');
  return useMutation({
    mutationFn: async ({ id, name }: { id: string; name?: string }) => {
      const client = await getClient();
      return client.post<{ data: Workflow }>(`${apiBasePath}/${id}/duplicate`, { name });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: isHelpdesk ? helpdeskAutomationKeys.workflows() : automationKeys.workflows() });
    },
  });
}// 6. Test Workflow (Cloudflare Workflow)
export function useTestWorkflow() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, testData }: { id: string; testData?: Record<string, unknown> }) => {
      const client = await getClient();
      return client.post<{ data: { executionId: string; instanceId: string } }>(`${WELDCONNECT_API.workflows}/${id}/test`, { testData });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.executions() });
    },
  });
}
// ---- Executions ----

// 8. Cancel Execution
export function useCancelExecution() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.patch<{ data: { id: string; status: string } }>(`${WELDCONNECT_API.executions}/${id}/cancel`, {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.executions() });
    },
  });
}

// 9. Retry Execution
export function useRetryExecution() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.post<{ data: { id: string; instanceId: string; retryOf: string } }>(`${WELDCONNECT_API.executions}/${id}/retry`, {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.executions() });
    },
  });
}// 12. Update Template
export function useUpdateTemplate() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: {
      name?: string;
      description?: string;
      category?: string;
      difficulty?: 'beginner' | 'intermediate' | 'advanced';
      triggers?: unknown[];
      steps?: unknown[];
      settings?: Record<string, unknown>;
      tags?: string[];
      icon?: string;
      isPremium?: boolean;
    } }) => {
      const client = await getClient();
      return client.put<{ data: WorkflowTemplate }>(`${WELDCONNECT_API.templates}/${id}`, data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.templates() });
    },
  });
}// ---- Variables ----

// 26. Create Variable
export function useCreateVariable() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      name: string;
      description?: string;
      type?: string;
      value: string;
      isSecret?: boolean;
      scope?: 'global' | 'workflow' | 'execution';
      workflowId?: string;
    }) => {
      const client = await getClient();
      return client.post<{ data: WorkflowVariable }>(WELDCONNECT_API.variables, data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.variables() });
    },
  });
}

// 27. Update Variable
export function useUpdateVariable() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: {
      name?: string;
      description?: string;
      type?: string;
      value?: string;
    } }) => {
      const client = await getClient();
      return client.put<{ data: WorkflowVariable }>(`${WELDCONNECT_API.variables}/${id}`, data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.variables() });
    },
  });
}

// 28. Delete Variable
export function useDeleteVariable() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<{ success: boolean }>(`${WELDCONNECT_API.variables}/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.variables() });
    },
  });
}// ---- Webhooks ----

// 36. Create Webhook
export function useCreateWebhook() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      workflowId: string;
      triggerId?: string;
      name?: string;
      description?: string;
      validateSignature?: boolean;
      signatureHeader?: string;
      allowedMethods?: string[];
      ipWhitelist?: string[];
    }) => {
      const client = await getClient();
      return client.post<{ success: boolean; data: WorkflowWebhook & { webhookUrl: string } }>(WELDCONNECT_API.webhooks, data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.webhooks() });
    },
  });
}
// 38. Delete Webhook
export function useDeleteWebhook() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<{ success: boolean }>(`${WELDCONNECT_API.webhooks}/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.webhooks() });
    },
  });
}

// 39. Rotate Webhook Secret
export function useRotateWebhookSecret() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.patch<{ success: boolean; data: WorkflowWebhook }>(`${WELDCONNECT_API.webhooks}/${id}/rotate-secret`, {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.webhooks() });
    },
  });
}