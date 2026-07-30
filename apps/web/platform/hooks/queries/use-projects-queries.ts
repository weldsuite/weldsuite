
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type {
  ApiProject,
  ApiProjectMember,
  ApiAvailableProjectUser,
  ApiTimeEntry,
  ApiProjectFile,
  ApiProjectMessage,
} from '@/app/weldflow/lib/api-client';
import type { AnalyticsReport as AnalyticsReportSummary } from '@/app/weldflow/analytics/_components/analytics-list-client';
import type { AnalyticsReport, AnalyticsChart } from '@/app/weldflow/analytics/[id]/_components/report-view-client';
import type { Projects } from '@/lib/api/types/apps/projects.types';
import type { ProjectGoals } from '@/lib/api/domains/weldflow';

// =============================================================================
// Query Keys
// =============================================================================

export const projectKeys = {
  all: ['projects'] as const,
  lists: () => [...projectKeys.all, 'list'] as const,
  list: (filters?: Record<string, unknown>) => [...projectKeys.lists(), filters] as const,
  details: () => [...projectKeys.all, 'detail'] as const,
  detail: (id: string) => [...projectKeys.details(), id] as const,
  stats: () => [...projectKeys.all, 'stats'] as const,
  tasks: (projectId: string, params?: Record<string, unknown>) => [...projectKeys.all, projectId, 'tasks', params] as const,
  milestones: (projectId: string) => [...projectKeys.all, projectId, 'milestones'] as const,
  sprints: (projectId: string) => [...projectKeys.all, projectId, 'sprints'] as const,
  members: (projectId: string) => [...projectKeys.all, projectId, 'members'] as const,
  timeEntries: (projectId: string) => [...projectKeys.all, projectId, 'time-entries'] as const,
  files: (projectId: string) => [...projectKeys.all, projectId, 'files'] as const,
  messages: (projectId: string, limit?: number) => [...projectKeys.all, projectId, 'messages', limit] as const,
  whiteboard: (projectId: string) => [...projectKeys.all, projectId, 'whiteboard'] as const,
  whiteboards: (projectId: string) => [...projectKeys.all, projectId, 'whiteboards'] as const,
  whiteboardDetail: (whiteboardId: string) => [...projectKeys.all, 'whiteboard-detail', whiteboardId] as const,
  document: (projectId: string) => [...projectKeys.all, projectId, 'document'] as const,
  workload: (projectId?: string) => [...projectKeys.all, 'workload', projectId] as const,
  goals: (projectId: string) => [...projectKeys.all, projectId, 'goals'] as const,
  analytics: () => [...projectKeys.all, 'analytics'] as const,
  analyticsReports: () => [...projectKeys.analytics(), 'reports'] as const,
  analyticsReport: (id: string) => [...projectKeys.analytics(), 'reports', id] as const,
  analyticsCharts: (reportId: string) => [...projectKeys.analytics(), 'reports', reportId, 'charts'] as const,
  analyticsChartsData: (reportId: string) => [...projectKeys.analytics(), 'reports', reportId, 'charts-data'] as const,
  kpiSummary: (period: string, projectId?: string) =>
    [...projectKeys.analytics(), 'kpi-summary', period, projectId ?? 'workspace'] as const,
};

// =============================================================================
// Helper to build query string
// =============================================================================

function buildQueryString(params: Record<string, unknown>): string {
  const queryParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      queryParams.set(key, String(value));
    }
  }
  const query = queryParams.toString();
  return query ? `?${query}` : '';
}

// =============================================================================
// Queries
// =============================================================================

export function useProjects(params?: {
  page?: number;
  pageSize?: number;
  status?: string;
  search?: string;
  isActive?: boolean;
}) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: projectKeys.list(params),
    queryFn: async () => {
      const client = await getClient();
      const qs: Record<string, unknown> = { ...(params ?? {}) };
      if (qs.pageSize !== undefined) {
        qs.limit = qs.pageSize;
        delete qs.pageSize;
      }
      delete qs.page;
      const query = buildQueryString(qs);
      return client.get<{
        data: ApiProject[];
        pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
      }>(`/projects${query}`);
    },
  });
}

export type ProjectListFilters = {
  search?: string;
  status?: string;
  customerId?: string;
  isActive?: boolean;
  priority?: string;
  ownerId?: string;
  sortField?: 'name' | 'status' | 'priority' | 'dueDate' | 'owner' | 'createdAt';
  sortDirection?: 'asc' | 'desc';
};

export function useInfiniteProjects(filters: ProjectListFilters = {}, pageSize = 25) {
  const { getClient } = useAppApiClient();
  return useInfiniteQuery({
    queryKey: [...projectKeys.lists(), 'infinite', pageSize, filters],
    queryFn: async ({ pageParam }: { pageParam?: string | null }) => {
      const client = await getClient();
      const qs: Record<string, unknown> = { limit: pageSize, ...filters };
      if (pageParam) qs.cursor = pageParam;
      const query = buildQueryString(qs);
      return client.get<{
        data: ApiProject[];
        pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
      }>(`/projects${query}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => {
      const pagination = lastPage.pagination;
      if (!pagination) return undefined;
      return pagination.hasMore ? pagination.cursor : undefined;
    },
  });
}

export function useProject(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: projectKeys.detail(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: ApiProject }>(`/projects/${id}`);
    },
    enabled: !!id && enabled,
  });
}


export function useProjectTasks(projectId: string, params?: { page?: number; pageSize?: number; includeSubtasks?: boolean }, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: projectKeys.tasks(projectId, params),
    queryFn: async () => {
      const client = await getClient();
      const qs: Record<string, unknown> = { projectId, ...(params ?? {}) };
      if (qs.pageSize !== undefined) {
        qs.limit = qs.pageSize;
        delete qs.pageSize;
      }
      delete qs.page;
      const query = buildQueryString(qs);
      return client.get<{
        data: Projects.ProjectTask[];
        pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
      }>(`/tasks${query}`);
    },
    enabled: !!projectId && enabled,
  });
}

export type ProjectTaskFilters = {
  search?: string;
  status?: string;
  priority?: string;
  assigneeId?: string;
  sprintId?: string;
  milestoneId?: string;
  type?: string;
  parentTaskId?: string;
  labelIds?: string[];
  dueDateBucket?: 'overdue' | 'today' | 'this-week' | 'later' | 'no-date';
  sortField?: 'title' | 'status' | 'priority' | 'dueDate' | 'assignee' | 'position' | 'createdAt';
  sortDirection?: 'asc' | 'desc';
  includeSubtasks?: boolean;
};

export function useInfiniteProjectTasks(
  projectId: string,
  filters: ProjectTaskFilters = {},
  pageSize = 50,
  enabled = true
) {
  const { getClient } = useAppApiClient();
  return useInfiniteQuery({
    queryKey: [...projectKeys.tasks(projectId), 'infinite', pageSize, filters],
    queryFn: async ({ pageParam }: { pageParam?: string | null }) => {
      const client = await getClient();
      const qs: Record<string, unknown> = {
        projectId,
        limit: pageSize,
        ...filters,
        labelIds: filters.labelIds && filters.labelIds.length > 0 ? filters.labelIds.join(',') : undefined,
      };
      if (pageParam) qs.cursor = pageParam;
      const query = buildQueryString(qs);
      return client.get<{
        data: Projects.ProjectTask[];
        pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
      }>(`/tasks${query}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => {
      const pagination = lastPage.pagination;
      if (!pagination) return undefined;
      return pagination.hasMore ? pagination.cursor : undefined;
    },
    enabled: !!projectId && enabled,
  });
}export function useProjectMembers(projectId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: projectKeys.members(projectId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: ApiProjectMember[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } }>(
        `/project-members?projectId=${encodeURIComponent(projectId)}&limit=100`,
      );
    },
    enabled: !!projectId && enabled,
  });
}

export function useProjectAvailableUsers(projectId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...projectKeys.members(projectId), 'available'] as const,
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: ApiAvailableProjectUser[] }>(
        `/project-members/available?projectId=${encodeURIComponent(projectId)}`,
      );
    },
    enabled: !!projectId && enabled,
  });
}

export function useProjectTimeEntries(projectId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: projectKeys.timeEntries(projectId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: ApiTimeEntry[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } }>(
        `/time-entries?projectId=${encodeURIComponent(projectId)}&limit=100`,
      );
    },
    enabled: !!projectId && enabled,
  });
}

export function useProjectFiles(projectId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: projectKeys.files(projectId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: ApiProjectFile[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } }>(
        `/project-files?projectId=${encodeURIComponent(projectId)}&limit=100`,
      );
    },
    enabled: !!projectId && enabled,
  });
}

export function useProjectMessages(projectId: string, limit?: number, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: projectKeys.messages(projectId, limit),
    queryFn: async () => {
      const client = await getClient();
      const params = new URLSearchParams({ projectId });
      if (limit) params.set('limit', String(limit));
      return client.get<{ data: ApiProjectMessage[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } }>(
        `/project-messages?${params}`,
      );
    },
    enabled: !!projectId && enabled,
  });
}export function useProjectWorkload(projectId?: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: projectKeys.workload(projectId),
    queryFn: async () => {
      const client = await getClient();
      const path = projectId
        ? `/projects/${projectId}/workload`
        : '/projects/workload/overview';
      return client.get<{ data: Projects.WorkloadOverview }>(path);
    },
  });
}

export function useProjectGoals(projectId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: projectKeys.goals(projectId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: ProjectGoals }>(`/goals/by-project/${projectId}`);
    },
    enabled: !!projectId && enabled,
  });
}// =============================================================================
// Analytics Queries
// =============================================================================

export function useProjectKpiSummary(
  opts?: { projectId?: string; period?: '7d' | '30d' | '90d'; enabled?: boolean },
) {
  const { getClient } = useAppApiClient();
  const period = opts?.period ?? '30d';
  const projectId = opts?.projectId;
  return useQuery({
    queryKey: projectKeys.kpiSummary(period, projectId),
    queryFn: async () => {
      const client = await getClient();
      const qs = buildQueryString({ period, projectId });
      const path = projectId
        ? `/project-analytics/projects/${projectId}/summary?period=${period}`
        : `/project-analytics/summary${qs}`;
      return client.get<{
        data: import('@weldsuite/core-api-client/schemas/project-analytics').ProjectKpiSummary;
      }>(path);
    },
    enabled: opts?.enabled !== false,
  });
}

export function useProjectAnalyticsReports() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: projectKeys.analyticsReports(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: AnalyticsReportSummary[] }>('/project-analytics/reports');
    },
  });
}

export function useProjectAnalyticsReport(reportId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: projectKeys.analyticsReport(reportId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: { report: AnalyticsReport; charts: AnalyticsChart[] } }>(`/project-analytics/reports/${reportId}`);
    },
    enabled: !!reportId && enabled,
  });
}

export function useProjectAnalyticsCharts(reportId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: projectKeys.analyticsCharts(reportId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: AnalyticsChart[] }>(`/project-analytics/reports/${reportId}/charts`);
    },
    enabled: !!reportId && enabled,
  });
}

// =============================================================================
// Analytics Mutations
// =============================================================================

export function useCreateProjectAnalyticsReport() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { title: string; description?: string }) => {
      const client = await getClient();
      return client.post<{ data: { id: string } }>('/project-analytics/reports', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.analyticsReports() });
    },
  });
}

export function useUpdateProjectAnalyticsReport() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ reportId, data }: { reportId: string; data: { title?: string; description?: string } }) => {
      const client = await getClient();
      return client.put<{ data: { id: string } }>(`/project-analytics/reports/${reportId}`, data);
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: projectKeys.analyticsReports() });
      qc.invalidateQueries({ queryKey: projectKeys.analyticsReport(variables.reportId) });
    },
  });
}

export function useDeleteProjectAnalyticsReport() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (reportId: string) => {
      const client = await getClient();
      return client.delete<{ data: { deleted: boolean } }>(`/project-analytics/reports/${reportId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.analyticsReports() });
    },
  });
}
export function useCreateProjectAnalyticsChart() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ reportId, data }: {
      reportId: string;
      data: {
        title: string;
        description?: string;
        chartType: string;
        entity: string;
        metric: string;
        color?: string;
        timeRange?: string;
        groupBy?: string;
        aggregation?: string;
        sortOrder?: string;
        limit?: number;
        compareWith?: string;
        smoothCurve?: boolean;
        fillArea?: boolean;
        showDataLabels?: boolean;
        showLegend?: boolean;
        layout?: { x: number; y: number; w: number; h: number };
      };
    }) => {
      const client = await getClient();
      return client.post<{ data: { id: string } }>(`/project-analytics/reports/${reportId}/charts`, data);
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: projectKeys.analyticsCharts(variables.reportId) });
      qc.invalidateQueries({ queryKey: projectKeys.analyticsReport(variables.reportId) });
      qc.invalidateQueries({ queryKey: projectKeys.analyticsReports() });
    },
  });
}