
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type {
  Workflow,
  WorkflowExecution,
  WorkflowTemplate,
  WorkflowSchedule,
  WorkflowVariable,
  DashboardStats,
} from '@weldsuite/core-api-client/schemas/weldconnect';

// Re-export types
export type {
  Workflow,
  WorkflowExecution,
  WorkflowTemplate,
  
  WorkflowVariable,
  
} from '@weldsuite/core-api-client/schemas/weldconnect';

// Legacy types still used in some components
type WorkflowIntegration = Record<string, unknown>;
type WorkflowTrigger = Record<string, unknown>;
export type WorkflowWebhook = Record<string, unknown>;
export type WorkflowErrorLog = Record<string, unknown>;
export type ActionType = { id: string; name: string; description: string; category: string; icon?: string };
export type TriggerType = { id: string; name: string; description: string; category: string; icon?: string };
export type EntityEvent = { entityType: string; events: string[] };
type SearchResult = { id: string; title: string; description?: string; href: string; type: string };
export type PaginationMeta = { page: number; pageSize: number; totalCount: number; totalPages: number; hasMore: boolean };
/** app-api list envelope pagination — opaque cursor, no page/totalPages. */
export type CursorPaginationMeta = { totalCount: number; hasMore: boolean; cursor: string | null };

// =============================================================================
// DTO Types
// =============================================================================

interface TaskDashboardDto {
  stats: {
    totalWorkflows: number;
    activeWorkflows: number;
    totalExecutions: number;
    successfulExecutions: number;
    failedExecutions: number;
    pendingExecutions: number;
    workflowsToReview: number;
  };
  recentExecutions: WorkflowExecution[];
  activeWorkflows: Workflow[];
  upcomingSchedules: WorkflowSchedule[];
}

interface ChartDataPoint {
  date: string;
  executed: number;
  succeeded: number;
}

// =============================================================================
// Query Keys
// =============================================================================

const helpdeskAutomationKeys = {
  all: ['helpdesk-automation'] as const,
  workflows: (filters?: any) => [...helpdeskAutomationKeys.all, 'workflows', filters] as const,
  workflow: (id: string) => [...helpdeskAutomationKeys.all, 'workflow', id] as const,
  workflowStats: () => [...helpdeskAutomationKeys.all, 'workflow-stats'] as const,
};

export const automationKeys = {
  all: ['automation'] as const,
  dashboard: () => [...automationKeys.all, 'dashboard'] as const,
  dashboardChart: (months?: number) => [...automationKeys.all, 'dashboard-chart', months] as const,
  search: (query?: string) => [...automationKeys.all, 'search', query] as const,
  workflows: (filters?: any) => [...automationKeys.all, 'workflows', filters] as const,
  workflow: (id: string) => [...automationKeys.all, 'workflow', id] as const,
  workflowStats: () => [...automationKeys.all, 'workflow-stats'] as const,
  workflowMetrics: (id: string) => [...automationKeys.all, 'workflow-metrics', id] as const,
  workflowsForChaining: (excludeId?: string) => [...automationKeys.all, 'workflows-chaining', excludeId] as const,
  executions: (filters?: any) => [...automationKeys.all, 'executions', filters] as const,
  execution: (id: string) => [...automationKeys.all, 'execution', id] as const,
  executionSteps: (id: string) => [...automationKeys.all, 'execution-steps', id] as const,
  executionLogs: (id: string) => [...automationKeys.all, 'execution-logs', id] as const,
  executionTrends: (period?: string) => [...automationKeys.all, 'execution-trends', period] as const,
  recentExecutions: (limit?: number) => [...automationKeys.all, 'recent-executions', limit] as const,
  slowExecutions: (limit?: number) => [...automationKeys.all, 'slow-executions', limit] as const,
  templates: (filters?: any) => [...automationKeys.all, 'templates', filters] as const,
  template: (id: string) => [...automationKeys.all, 'template', id] as const,
  templateCategories: () => [...automationKeys.all, 'template-categories'] as const,
  schedules: (filters?: any) => [...automationKeys.all, 'schedules', filters] as const,
  schedule: (id: string) => [...automationKeys.all, 'schedule', id] as const,
  integrations: (filters?: any) => [...automationKeys.all, 'integrations', filters] as const,
  integration: (id: string) => [...automationKeys.all, 'integration', id] as const,
  variables: (filters?: any) => [...automationKeys.all, 'variables', filters] as const,
  variable: (id: string) => [...automationKeys.all, 'variable', id] as const,
  triggers: (filters?: any) => [...automationKeys.all, 'triggers', filters] as const,
  trigger: (id: string) => [...automationKeys.all, 'trigger', id] as const,
  webhooks: (filters?: any) => [...automationKeys.all, 'webhooks', filters] as const,
  webhook: (id: string) => [...automationKeys.all, 'webhook', id] as const,
  webhookEvents: (id: string) => [...automationKeys.all, 'webhook-events', id] as const,
  actionTypes: (params?: any) => [...automationKeys.all, 'action-types', params] as const,
  triggerTypes: (params?: any) => [...automationKeys.all, 'trigger-types', params] as const,
  entityEvents: () => [...automationKeys.all, 'entity-events'] as const,
  errorStats: (params?: any) => [...automationKeys.all, 'error-stats', params] as const,
  performanceMetrics: (workflowId?: string) => [...automationKeys.all, 'performance-metrics', workflowId] as const,
  resourceUsage: () => [...automationKeys.all, 'resource-usage'] as const,
};

// =============================================================================
// Helper to build query string
// =============================================================================

function buildQueryString(params: Record<string, any>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  }
  const qs = searchParams.toString();
  return qs ? `?${qs}` : '';
}

// =============================================================================
// Query Hooks
// =============================================================================

// 1. Dashboard Stats
function useDashboardStats() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.dashboard(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any }>('/workflow-dashboard/stats');
    },
  });
}

// 2. Dashboard Chart
function useDashboardChart(months?: number) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.dashboardChart(months),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString({ period: 'month', ...(months ? { months } : {}) });
      return client.get<{ data: { trends: ChartDataPoint[] } }>(`/workflow-executions/trends${query}`);
    },
  });
}

// 3. Automation Search
function useAutomationSearch(query?: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.search(query),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ success: boolean; data: SearchResult[] }>(`/workflow-dashboard/search?q=${encodeURIComponent(query || '')}`);
    },
    enabled: !!query,
  });
}

// 4. Workflows (list)
export function useWorkflows(filters?: Record<string, any>) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.workflows(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(filters || {});
      return client.get<{ data: Workflow[]; pagination: PaginationMeta }>(`/workflows${query}`);
    },
  });
}

// 5. Workflow (single)
function useWorkflow(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.workflow(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: Workflow }>(`/workflows/${id}`);
    },
    enabled: !!id && enabled,
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
      } }>('/workflows/stats');
    },
  });
}

// Helpdesk Workflows (list) — app-api `/helpdesk-workflows` (cursor paginated).
export function useHelpdeskWorkflows(filters?: Record<string, any>) {
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
}

// 7. Workflow Metrics
function useWorkflowMetrics(workflowId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.workflowMetrics(workflowId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: {
        totalExecutions: number;
        successCount: number;
        failureCount: number;
        averageExecutionTime: number;
        recentExecutions: WorkflowExecution[];
      } }>(`/workflows/${workflowId}/metrics`);
    },
    enabled: !!workflowId && enabled,
  });
}

// 8. Workflows For Chaining
function useWorkflowsForChaining(excludeId?: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.workflowsForChaining(excludeId),
    queryFn: async () => {
      const client = await getClient();
      const query = excludeId ? `?exclude=${excludeId}` : '';
      return client.get<{ data: Array<{ id: string; name: string; status: string }> }>(`/workflows/for-chaining${query}`);
    },
  });
}

// 9. Executions (list)
export function useExecutions(filters?: Record<string, any>) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.executions(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(filters || {});
      return client.get<{ data: WorkflowExecution[]; pagination: PaginationMeta }>(`/workflow-executions${query}`);
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
      return client.get<{ data: WorkflowExecution }>(`/workflow-executions/${id}`);
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
      return client.get<{ data: WorkflowExecution[] }>(`/workflow-executions/recent?limit=${limit}`);
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
      return client.get<{ data: any[] }>(`/workflow-executions/${executionId}/steps`);
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
      return client.get<{ data: any[] }>(`/workflow-executions/${executionId}/logs`);
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
      } }>(`/workflow-executions/trends${query}`);
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
      return client.get<{ data: WorkflowExecution[] }>(`/workflow-executions/slow?limit=${limit}`);
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
      return client.get<{ success: boolean; data: ActionType[] }>(`/workflow-dashboard/action-types${query}`);
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
      return client.get<{ success: boolean; data: TriggerType[] }>(`/workflow-dashboard/trigger-types${query}`);
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
      return client.get<{ success: boolean; data: EntityEvent[] }>('/workflow-dashboard/entity-events');
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
      } }>(`/workflow-dashboard/performance${query}`);
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
      } }>(`/workflow-dashboard/errors${query}`);
    },
  });
}

// 21. Resource Usage
function useResourceUsage() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.resourceUsage(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ success: boolean; data: {
        workflows: { total: number; active: number };
        executions: { total: number; running: number; completed: number; failed: number };
        triggers: { schedules: number; webhooks: number };
      } }>('/workflow-dashboard/resource-usage');
    },
  });
}

// 22. Templates (list)
function useTemplates(filters?: Record<string, any>) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.templates(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(filters || {});
      return client.get<{ data: WorkflowTemplate[]; pagination: PaginationMeta }>(`/workflow-templates${query}`);
    },
  });
}

// 23. Template (single)
export function useTemplate(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.template(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: WorkflowTemplate }>(`/workflow-templates/${id}`);
    },
    enabled: !!id && enabled,
  });
}

// 24. Template Categories
function useTemplateCategories() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.templateCategories(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: Array<{ id: string; name: string; count: number }> }>('/workflow-templates/categories');
    },
  });
}

// 25. Schedules (list)
function useSchedules(filters?: Record<string, any>) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.schedules(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(filters || {});
      return client.get<{ data: WorkflowSchedule[]; pagination: PaginationMeta }>(`/workflow-schedules${query}`);
    },
  });
}

// 26. Schedule (single)
function useSchedule(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.schedule(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: WorkflowSchedule }>(`/workflow-schedules/${id}`);
    },
    enabled: !!id && enabled,
  });
}

// 27. Integrations (list)
function useIntegrations(filters?: Record<string, any>) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.integrations(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(filters || {});
      return client.get<{ success: boolean; data: WorkflowIntegration[]; pagination: PaginationMeta }>(`/workflow-integrations${query}`);
    },
  });
}

// 28. Integration (single)
function useIntegration(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.integration(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ success: boolean; data: WorkflowIntegration }>(`/workflow-integrations/${id}`);
    },
    enabled: !!id && enabled,
  });
}

// 29. Variables (list)
export function useVariables(filters?: Record<string, any>) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.variables(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(filters || {});
      return client.get<{ data: WorkflowVariable[]; pagination: PaginationMeta }>(`/workflow-variables${query}`);
    },
  });
}

// 30. Variable (single)
function useVariable(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.variable(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: WorkflowVariable }>(`/workflow-variables/${id}`);
    },
    enabled: !!id && enabled,
  });
}

// 31. Triggers (list)
function useTriggers(filters?: Record<string, any>) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.triggers(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(filters || {});
      return client.get<{ data: WorkflowTrigger[]; pagination: PaginationMeta }>(`/workflow-triggers${query}`);
    },
  });
}

// 32. Trigger (single)
function useTrigger(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.trigger(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: WorkflowTrigger }>(`/workflow-triggers/${id}`);
    },
    enabled: !!id && enabled,
  });
}

// 33. Webhooks (list)
export function useWebhooks(filters?: Record<string, any>) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.webhooks(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(filters || {});
      return client.get<{ success: boolean; data: WorkflowWebhook[]; pagination: PaginationMeta }>(`/workflow-webhooks${query}`);
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
      return client.get<{ success: boolean; data: WorkflowWebhook }>(`/workflow-webhooks/${id}`);
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
      }> }>(`/workflow-webhooks/${webhookId}/events`);
    },
    enabled: !!webhookId && enabled,
  });
}

// 36. Workflow Webhook
function useWorkflowWebhook(workflowId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: automationKeys.webhook(workflowId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ success: boolean; data: {
        id: string;
        url: string;
        externalUrl: string | null;
        secret: string | null;
        isEnabled: boolean;
      } | null }>(`/workflow-webhooks/workflow/${workflowId}`);
    },
    enabled: !!workflowId && enabled,
  });
}

// =============================================================================
// Mutation Hooks
// =============================================================================

// ---- Workflows ----

// `apiBasePath` lets the same hook back two different surfaces, both on app-api:
//   `/workflows`           — WeldConnect automation (default)
//   `/helpdesk-workflows`  — WeldDesk helpdesk workflows
// The two differ only in the mount path and the query keys they invalidate.

// 1. Create Workflow
export function useCreateWorkflow(apiBasePath = '/workflows') {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  const isHelpdesk = apiBasePath.startsWith('/helpdesk');
  return useMutation({
    mutationFn: async (data: {
      name: string;
      description?: string;
      status?: string;
      triggers?: any[];
      steps?: any[];
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
export function useUpdateWorkflow(apiBasePath = '/workflows') {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  const isHelpdesk = apiBasePath.startsWith('/helpdesk');
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: {
      name?: string;
      description?: string;
      status?: string;
      triggers?: any[];
      steps?: any[];
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
export function useDeleteWorkflow(apiBasePath = '/workflows') {
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
export function useUpdateWorkflowStatus(apiBasePath = '/workflows') {
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
        '/workflows/generate',
        { prompt },
      );
    },
  });
}

// 5. Duplicate Workflow
export function useDuplicateWorkflow(apiBasePath = '/workflows') {
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
}

// -- Seed / Reset Default Workflows --

function useSeedDefaultWorkflows(apiBasePath = '/helpdesk-workflows') {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  const isHelpdesk = apiBasePath.startsWith('/helpdesk');
  return useMutation({
    mutationFn: async () => {
      const client = await getClient();
      return client.post<{ data: { seeded: number; templateIds: string[] } }>(`${apiBasePath}/seed-defaults`, {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: isHelpdesk ? helpdeskAutomationKeys.workflows() : automationKeys.workflows() });
      if (isHelpdesk) qc.invalidateQueries({ queryKey: helpdeskAutomationKeys.workflowStats() });
    },
  });
}

function useResetDefaultWorkflows(apiBasePath = '/helpdesk-workflows') {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  const isHelpdesk = apiBasePath.startsWith('/helpdesk');
  return useMutation({
    mutationFn: async () => {
      const client = await getClient();
      return client.post<{ data: { deleted: number; created: number; templateIds: string[] } }>(`${apiBasePath}/reset-defaults`, {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: isHelpdesk ? helpdeskAutomationKeys.workflows() : automationKeys.workflows() });
      if (isHelpdesk) qc.invalidateQueries({ queryKey: helpdeskAutomationKeys.workflowStats() });
    },
  });
}

// 6. Test Workflow (Cloudflare Workflow)
export function useTestWorkflow() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, testData }: { id: string; testData?: Record<string, unknown> }) => {
      const client = await getClient();
      return client.post<{ data: { executionId: string; instanceId: string } }>(`/workflows/${id}/test`, { testData });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.executions() });
    },
  });
}

// 7. Trigger Workflow (Cloudflare Workflow)
function useTriggerWorkflow() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data?: Record<string, unknown> }) => {
      const client = await getClient();
      return client.post<{ data: { executionId: string; instanceId: string } }>(`/workflows/${id}/trigger`, { data });
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
      return client.patch<{ data: { id: string; status: string } }>(`/workflow-executions/${id}/cancel`, {});
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
      return client.post<{ data: { id: string; instanceId: string; retryOf: string } }>(`/workflow-executions/${id}/retry`, {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.executions() });
    },
  });
}

// 10. Create Execution
function useCreateExecution() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      workflowId: string;
      triggerType?: string;
      triggerData?: Record<string, unknown>;
    }) => {
      const client = await getClient();
      return client.post<{ data: WorkflowExecution }>('/workflow-executions', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.executions() });
    },
  });
}

// ---- Templates ----

// 11. Create Template
function useCreateTemplate() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      name: string;
      description?: string;
      category?: string;
      difficulty?: 'beginner' | 'intermediate' | 'advanced';
      triggers?: any[];
      steps?: any[];
      settings?: Record<string, unknown>;
      tags?: string[];
      icon?: string;
      isPremium?: boolean;
    }) => {
      const client = await getClient();
      return client.post<{ data: WorkflowTemplate }>('/workflow-templates', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.templates() });
    },
  });
}

// 12. Update Template
export function useUpdateTemplate() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: {
      name?: string;
      description?: string;
      category?: string;
      difficulty?: 'beginner' | 'intermediate' | 'advanced';
      triggers?: any[];
      steps?: any[];
      settings?: Record<string, unknown>;
      tags?: string[];
      icon?: string;
      isPremium?: boolean;
    } }) => {
      const client = await getClient();
      return client.put<{ data: WorkflowTemplate }>(`/workflow-templates/${id}`, data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.templates() });
    },
  });
}

// 13. Delete Template
function useDeleteTemplate() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<{ success: boolean }>(`/workflow-templates/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.templates() });
    },
  });
}

// 14. Create From Template (use template)
function useCreateFromTemplate() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ templateId, params }: { templateId: string; params?: {
      name?: string;
      description?: string;
      activate?: boolean;
    } }) => {
      const client = await getClient();
      return client.post<{ data: Workflow }>(`/workflow-templates/${templateId}/use`, params || {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.workflows() });
    },
  });
}

// 15. Create Template From Workflow
function useCreateTemplateFromWorkflow() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ workflowId, params }: { workflowId: string; params?: {
      name?: string;
      description?: string;
      category?: string;
    } }) => {
      const client = await getClient();
      return client.post<{ data: WorkflowTemplate }>(`/workflow-templates/from-workflow/${workflowId}`, params || {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.templates() });
    },
  });
}

// ---- Schedules ----

// 16. Create Schedule
function useCreateSchedule() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      workflowId: string;
      triggerId?: string;
      name: string;
      cronExpression: string;
      timezone?: string;
      startDate?: string;
      endDate?: string;
      isEnabled?: boolean;
    }) => {
      const client = await getClient();
      return client.post<{ data: WorkflowSchedule }>('/workflow-schedules', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.schedules() });
    },
  });
}

// 17. Update Schedule
function useUpdateSchedule() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: {
      name?: string;
      cronExpression?: string;
      timezone?: string;
      startDate?: string | null;
      endDate?: string | null;
      isEnabled?: boolean;
    } }) => {
      const client = await getClient();
      return client.put<{ data: WorkflowSchedule }>(`/workflow-schedules/${id}`, data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.schedules() });
    },
  });
}

// 18. Delete Schedule
function useDeleteSchedule() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<{ success: boolean }>(`/workflow-schedules/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.schedules() });
    },
  });
}

// 19. Toggle Schedule — body required (was previously broken: sent `{}`).
function useToggleSchedule() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const client = await getClient();
      return client.patch<{ data: WorkflowSchedule }>(`/workflow-schedules/${id}/toggle`, { enabled });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.schedules() });
    },
  });
}

// ---- Integrations ----

// 20. Create Integration
function useCreateIntegration() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      name: string;
      description?: string;
      category?: string;
      icon?: string;
      config?: Record<string, unknown>;
      credentials?: Record<string, unknown>;
      authType?: string;
    }) => {
      const client = await getClient();
      return client.post<{ success: boolean; data: WorkflowIntegration }>('/workflow-integrations', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.integrations() });
    },
  });
}

// 21. Update Integration
function useUpdateIntegration() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: {
      name?: string;
      description?: string;
      category?: string;
      icon?: string;
      config?: Record<string, unknown>;
      credentials?: Record<string, unknown>;
      authType?: string;
    } }) => {
      const client = await getClient();
      return client.put<{ success: boolean; data: WorkflowIntegration }>(`/workflow-integrations/${id}`, data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.integrations() });
    },
  });
}

// 22. Delete Integration
function useDeleteIntegration() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<{ success: boolean }>(`/workflow-integrations/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.integrations() });
    },
  });
}

// 23. Connect Integration
function useConnectIntegration() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, credentials }: { id: string; credentials?: Record<string, unknown> }) => {
      const client = await getClient();
      return client.patch<{ success: boolean; data: { id: string; status: string } }>(`/workflow-integrations/${id}/connect`, { credentials });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.integrations() });
    },
  });
}

// 24. Disconnect Integration
function useDisconnectIntegration() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.patch<{ success: boolean; data: { id: string; status: string } }>(`/workflow-integrations/${id}/disconnect`, {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.integrations() });
    },
  });
}

// 25. Test Integration
function useTestIntegration() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.post<{ success: boolean; data: { success: boolean; message?: string } }>(`/workflow-integrations/${id}/test`, {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.integrations() });
    },
  });
}

// ---- Variables ----

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
      return client.post<{ data: WorkflowVariable }>('/workflow-variables', data);
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
      return client.put<{ data: WorkflowVariable }>(`/workflow-variables/${id}`, data);
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
      return client.delete<{ success: boolean }>(`/workflow-variables/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.variables() });
    },
  });
}

// ---- Triggers ----

// 29. Create Trigger
function useCreateTrigger() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      workflowId: string;
      name: string;
      category: string;
      config?: Record<string, unknown>;
      isEnabled?: boolean;
    }) => {
      const client = await getClient();
      return client.post<{ success: boolean; data: WorkflowTrigger }>('/workflow-triggers', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.triggers() });
    },
  });
}

// 30. Update Trigger
function useUpdateTrigger() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: {
      name?: string;
      category?: string;
      config?: Record<string, unknown>;
      isEnabled?: boolean;
    } }) => {
      const client = await getClient();
      return client.put<{ success: boolean; data: WorkflowTrigger }>(`/workflow-triggers/${id}`, data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.triggers() });
    },
  });
}

// 31. Delete Trigger
function useDeleteTrigger() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<{ success: boolean; workflowId?: string }>(`/workflow-triggers/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.triggers() });
    },
  });
}

// 32. Enable Trigger
function useEnableTrigger() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.patch<{ success: boolean; data: WorkflowTrigger }>(`/workflow-triggers/${id}/enable`, {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.triggers() });
    },
  });
}

// 33. Disable Trigger
function useDisableTrigger() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.patch<{ success: boolean; data: WorkflowTrigger }>(`/workflow-triggers/${id}/disable`, {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.triggers() });
    },
  });
}

// 34. Create Entity Trigger
function useCreateEntityTrigger() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      workflowId: string;
      name?: string;
      entityType: string;
      eventType: string;
      filters?: Record<string, unknown>;
    }) => {
      const client = await getClient();
      return client.post<{ success: boolean; data: WorkflowTrigger }>('/workflow-triggers/entity', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.triggers() });
    },
  });
}

// 35. Create Schedule Trigger
function useCreateScheduleTrigger() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      workflowId: string;
      name?: string;
      cronExpression: string;
      timezone?: string;
      startDate?: string;
      endDate?: string;
    }) => {
      const client = await getClient();
      return client.post<{ success: boolean; data: WorkflowTrigger }>('/workflow-triggers/schedule', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.triggers() });
    },
  });
}

// ---- Webhooks ----

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
      return client.post<{ success: boolean; data: WorkflowWebhook & { webhookUrl: string } }>('/workflow-webhooks', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.webhooks() });
    },
  });
}

// 37. Update Webhook
function useUpdateWebhook() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: {
      name?: string;
      description?: string;
      validateSignature?: boolean;
      signatureHeader?: string;
      allowedMethods?: string[];
      ipWhitelist?: string[];
      isEnabled?: boolean;
    } }) => {
      const client = await getClient();
      return client.put<{ success: boolean; data: WorkflowWebhook }>(`/workflow-webhooks/${id}`, data);
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
      return client.delete<{ success: boolean }>(`/workflow-webhooks/${id}`);
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
      return client.patch<{ success: boolean; data: WorkflowWebhook }>(`/workflow-webhooks/${id}/rotate-secret`, {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.webhooks() });
    },
  });
}

// 40. Create Webhook Trigger
function useCreateWebhookTrigger() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (workflowId: string) => {
      const client = await getClient();
      return client.post<{ success: boolean; data: WorkflowTrigger & {
        webhookId: string;
        webhookUrl: string;
        secret: string;
      } }>('/workflow-webhooks/create-trigger', { workflowId });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.webhooks() });
    },
  });
}

// ---- Errors ----

// 41. Acknowledge Error
function useAcknowledgeError() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (errorId: string) => {
      const client = await getClient();
      return client.patch<{ success: boolean; data: WorkflowErrorLog }>(`/workflow-dashboard/errors/${errorId}/acknowledge`, {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: automationKeys.errorStats() });
    },
  });
}
