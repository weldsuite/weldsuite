
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

// =============================================================================
// Query Keys
// =============================================================================

export const projectKeys = {
  all: ['projects'] as const,
  lists: () => [...projectKeys.all, 'list'] as const,
  list: (filters?: Record<string, any>) => [...projectKeys.lists(), filters] as const,
  details: () => [...projectKeys.all, 'detail'] as const,
  detail: (id: string) => [...projectKeys.details(), id] as const,
  stats: () => [...projectKeys.all, 'stats'] as const,
  tasks: (projectId: string, params?: Record<string, any>) => [...projectKeys.all, projectId, 'tasks', params] as const,
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

function buildQueryString(params: Record<string, any>): string {
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
      const qs: Record<string, any> = { ...(params ?? {}) };
      if (qs.pageSize !== undefined) {
        qs.limit = qs.pageSize;
        delete qs.pageSize;
      }
      delete qs.page;
      const query = buildQueryString(qs);
      return client.get<{
        data: any[];
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
      const qs: Record<string, any> = { limit: pageSize, ...filters };
      if (pageParam) qs.cursor = pageParam;
      const query = buildQueryString(qs);
      return client.get<{
        data: any[];
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
      return client.get<{ data: any }>(`/projects/${id}`);
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
      const qs: Record<string, any> = { projectId, ...(params ?? {}) };
      if (qs.pageSize !== undefined) {
        qs.limit = qs.pageSize;
        delete qs.pageSize;
      }
      delete qs.page;
      const query = buildQueryString(qs);
      return client.get<{
        data: any[];
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
      const qs: Record<string, any> = {
        projectId,
        limit: pageSize,
        ...filters,
        labelIds: filters.labelIds && filters.labelIds.length > 0 ? filters.labelIds.join(',') : undefined,
      };
      if (pageParam) qs.cursor = pageParam;
      const query = buildQueryString(qs);
      return client.get<{
        data: any[];
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
}

function useProjectMilestones(projectId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: projectKeys.milestones(projectId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } }>(
        `/milestones?projectId=${encodeURIComponent(projectId)}&limit=100`,
      );
    },
    enabled: !!projectId && enabled,
  });
}

function useProjectSprints(projectId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: projectKeys.sprints(projectId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } }>(
        `/sprints?projectId=${encodeURIComponent(projectId)}&limit=100`,
      );
    },
    enabled: !!projectId && enabled,
  });
}

export function useProjectMembers(projectId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: projectKeys.members(projectId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } }>(
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
      return client.get<{ data: any[] }>(
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
      return client.get<{ data: any[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } }>(
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
      return client.get<{ data: any[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } }>(
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
      return client.get<{ data: any[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } }>(
        `/project-messages?${params}`,
      );
    },
    enabled: !!projectId && enabled,
  });
}

function useProjectWhiteboard(projectId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: projectKeys.whiteboard(projectId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any }>(
        `/whiteboards?projectId=${encodeURIComponent(projectId)}&limit=1`,
      );
    },
    enabled: !!projectId && enabled,
  });
}

function useProjectWhiteboards(projectId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: projectKeys.whiteboards(projectId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } }>(
        `/whiteboards?projectId=${encodeURIComponent(projectId)}&limit=100`,
      );
    },
    enabled: !!projectId && enabled,
  });
}

function useProjectWhiteboardDetail(projectId: string, whiteboardId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: projectKeys.whiteboardDetail(whiteboardId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any }>(`/whiteboards/${whiteboardId}`);
    },
    enabled: !!projectId && !!whiteboardId && enabled,
  });
}

function useProjectDocument(projectId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: projectKeys.document(projectId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any[] }>(
        `/project-documents?projectId=${encodeURIComponent(projectId)}&limit=100`,
      );
    },
    enabled: !!projectId && enabled,
  });
}

export function useProjectWorkload(projectId?: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: projectKeys.workload(projectId),
    queryFn: async () => {
      const client = await getClient();
      const path = projectId
        ? `/projects/${projectId}/workload`
        : '/projects/workload/overview';
      return client.get<{ data: any }>(path);
    },
  });
}

export function useProjectGoals(projectId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: projectKeys.goals(projectId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any }>(`/goals/by-project/${projectId}`);
    },
    enabled: !!projectId && enabled,
  });
}

// =============================================================================
// Mutations
// =============================================================================

function useCreateProject() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      name: string;
      description?: string;
      status?: string;
      customerId?: string;
      startDate?: string;
      endDate?: string;
      budgetedAmount?: string;
      hourlyRate?: string;
      color?: string;
    }) => {
      const client = await getClient();
      return client.post<{ data: any }>('/projects', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.all });
    },
  });
}

function useUpdateProject() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: {
      id: string;
      data: {
        name?: string;
        description?: string;
        status?: string;
        customerId?: string;
        startDate?: string;
        endDate?: string;
        budgetedAmount?: string;
        hourlyRate?: string;
        color?: string;
      };
    }) => {
      const client = await getClient();
      return client.patch<{ data: any }>(`/projects/${id}`, data);
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: projectKeys.all });
      qc.invalidateQueries({ queryKey: projectKeys.detail(variables.id) });
    },
  });
}

function useDeleteProject() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<{ data: { deleted: boolean } }>(`/projects/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.all });
    },
  });
}

function useUpdateProjectStatus() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const client = await getClient();
      return client.patch<{ data: any }>(`/projects/${id}`, { status });
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: projectKeys.all });
      qc.invalidateQueries({ queryKey: projectKeys.detail(variables.id) });
    },
  });
}

function useCreateProjectTask() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, data }: {
      projectId: string;
      data: {
        title: string;
        description?: string;
        assigneeId?: string;
        dueDate?: string;
        priority?: string;
        status?: string;
        duration?: number;
      };
    }) => {
      const client = await getClient();
      return client.post<{ data: any }>(`/tasks/projects/${projectId}`, data);
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: projectKeys.tasks(variables.projectId) });
      qc.invalidateQueries({ queryKey: projectKeys.detail(variables.projectId) });
    },
  });
}

function useUpdateProjectTask() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ taskId, data }: {
      taskId: string;
      data: {
        projectId: string;
        title?: string;
        description?: string;
        status?: string;
        priority?: string;
        assigneeId?: string;
        dueDate?: string;
        startDate?: string;
        estimatedHours?: number;
        duration?: number;
      };
    }) => {
      const client = await getClient();
      return client.patch<{ data: any }>(`/tasks/${taskId}`, data);
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: projectKeys.tasks(variables.data.projectId) });
      qc.invalidateQueries({ queryKey: projectKeys.all });
    },
  });
}

function useDeleteProjectTask() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ taskId, projectId }: { taskId: string; projectId: string }) => {
      const client = await getClient();
      return client.delete<void>(`/tasks/${taskId}`);
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: projectKeys.tasks(variables.projectId) });
      qc.invalidateQueries({ queryKey: projectKeys.all });
    },
  });
}

function useCreateProjectMilestone() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, data }: {
      projectId: string;
      data: {
        name: string;
        description?: string;
        dueDate?: string;
        status?: string;
      };
    }) => {
      const client = await getClient();
      return client.post<{ data: any }>('/milestones', { projectId, ...data });
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: projectKeys.milestones(variables.projectId) });
      qc.invalidateQueries({ queryKey: projectKeys.detail(variables.projectId) });
    },
  });
}

function useUpdateProjectMilestone() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: {
      id: string;
      data: {
        projectId: string;
        name?: string;
        description?: string;
        dueDate?: string;
        status?: string;
      };
    }) => {
      const client = await getClient();
      return client.patch<{ data: any }>(`/milestones/${id}`, data);
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: projectKeys.milestones(variables.data.projectId) });
      qc.invalidateQueries({ queryKey: projectKeys.all });
    },
  });
}

function useDeleteProjectMilestone() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, projectId }: { id: string; projectId: string }) => {
      const client = await getClient();
      return client.delete<{ data: { deleted: boolean } }>(`/milestones/${id}`);
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: projectKeys.milestones(variables.projectId) });
      qc.invalidateQueries({ queryKey: projectKeys.all });
    },
  });
}

function useStartSprint() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, sprintId }: { projectId: string; sprintId: string }) => {
      const client = await getClient();
      return client.patch<{ data: any }>(`/sprints/${sprintId}`, { status: 'active' });
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: projectKeys.sprints(variables.projectId) });
      qc.invalidateQueries({ queryKey: projectKeys.detail(variables.projectId) });
    },
  });
}

function useCompleteSprint() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, sprintId }: { projectId: string; sprintId: string }) => {
      const client = await getClient();
      return client.patch<{ data: any }>(`/sprints/${sprintId}`, { status: 'completed' });
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: projectKeys.sprints(variables.projectId) });
      qc.invalidateQueries({ queryKey: projectKeys.detail(variables.projectId) });
    },
  });
}

function useCreateProjectSprint() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, data }: {
      projectId: string;
      data: {
        name: string;
        startDate: string;
        endDate: string;
        goal?: string;
      };
    }) => {
      const client = await getClient();
      return client.post<{ data: any }>('/sprints', { projectId, ...data });
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: projectKeys.sprints(variables.projectId) });
      qc.invalidateQueries({ queryKey: projectKeys.detail(variables.projectId) });
    },
  });
}

function useAddProjectMember() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, userId, role }: { projectId: string; userId: string; role?: string }) => {
      const client = await getClient();
      return client.post<{ data: any }>('/project-members', { projectId, userId, role: role || 'member' });
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: projectKeys.members(variables.projectId) });
      qc.invalidateQueries({ queryKey: projectKeys.detail(variables.projectId) });
    },
  });
}

function useRemoveProjectMember() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, userId }: { projectId: string; userId: string }) => {
      const client = await getClient();
      return client.delete<{ data: { deleted: boolean } }>(
        `/project-members/by-user/${projectId}/${userId}`,
      );
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: projectKeys.members(variables.projectId) });
      qc.invalidateQueries({ queryKey: projectKeys.detail(variables.projectId) });
    },
  });
}

function useCreateTimeEntry() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      projectId?: string;
      taskId?: string;
      date: string;
      duration: string;
      description?: string;
      billable?: boolean;
    }) => {
      const client = await getClient();
      return client.post<{ data: any }>('/time-entries', {
        projectId: data.projectId,
        taskId: data.taskId,
        description: data.description,
        date: data.date,
        duration: data.duration,
        billable: data.billable ?? true,
      });
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: projectKeys.all });
      if (variables.projectId) {
        qc.invalidateQueries({ queryKey: projectKeys.timeEntries(variables.projectId) });
      }
    },
  });
}

function useUpdateTimeEntry() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: {
      id: string;
      data: {
        projectId?: string;
        description?: string;
        duration?: string;
        date?: string;
        billable?: boolean;
      };
    }) => {
      const client = await getClient();
      return client.patch<{ data: any }>(`/time-entries/${id}`, {
        description: data.description,
        date: data.date,
        duration: data.duration,
        billable: data.billable,
      });
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: projectKeys.all });
      if (variables.data.projectId) {
        qc.invalidateQueries({ queryKey: projectKeys.timeEntries(variables.data.projectId) });
      }
    },
  });
}

function useDeleteTimeEntry() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, projectId }: { id: string; projectId?: string }) => {
      const client = await getClient();
      return client.delete<{ data: { deleted: boolean } }>(`/time-entries/${id}`);
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: projectKeys.all });
      if (variables.projectId) {
        qc.invalidateQueries({ queryKey: projectKeys.timeEntries(variables.projectId) });
      }
    },
  });
}

function useApproveTimeEntry() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, projectId }: { id: string; projectId?: string }) => {
      const client = await getClient();
      return client.patch<{ data: any }>(`/time-entries/${id}/approve`, {});
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: projectKeys.all });
      if (variables.projectId) {
        qc.invalidateQueries({ queryKey: projectKeys.timeEntries(variables.projectId) });
      }
    },
  });
}

function useSaveProjectWhiteboard() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, data }: {
      projectId: string;
      data: {
        elements: any[];
        appState?: Record<string, unknown>;
      };
    }) => {
      const client = await getClient();
      return client.post<{ data: any }>('/whiteboards', { projectId, name: 'Whiteboard', ...data });
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: projectKeys.whiteboard(variables.projectId) });
    },
  });
}

function useSaveProjectDocument() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, data }: {
      projectId: string;
      data: {
        title: string;
        content: string;
        coverImage?: string;
      };
    }) => {
      const client = await getClient();
      return client.post<{ data: any }>('/project-documents', { projectId, ...data });
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: projectKeys.document(variables.projectId) });
    },
  });
}

function useCreateProjectMessage() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, data }: {
      projectId: string;
      data: {
        message: string;
        messageType?: string;
        replyToId?: string;
      };
    }) => {
      const client = await getClient();
      return client.post<{ data: any }>('/project-messages', { projectId, ...data });
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: projectKeys.messages(variables.projectId) });
    },
  });
}

// =============================================================================
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

export function useAnalyticsReports() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: projectKeys.analyticsReports(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any[] }>('/project-analytics/reports');
    },
  });
}

export function useAnalyticsReport(reportId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: projectKeys.analyticsReport(reportId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: { report: any; charts: any[] } }>(`/project-analytics/reports/${reportId}`);
    },
    enabled: !!reportId && enabled,
  });
}

export function useAnalyticsCharts(reportId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: projectKeys.analyticsCharts(reportId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any[] }>(`/project-analytics/reports/${reportId}/charts`);
    },
    enabled: !!reportId && enabled,
  });
}

// =============================================================================
// Analytics Mutations
// =============================================================================

export function useCreateAnalyticsReport() {
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

export function useUpdateAnalyticsReport() {
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

export function useDeleteAnalyticsReport() {
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

function useDuplicateAnalyticsReport() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (reportId: string) => {
      const client = await getClient();
      return client.post<{ data: { id: string } }>(`/project-analytics/reports/${reportId}/duplicate`, {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.analyticsReports() });
    },
  });
}

export function useCreateAnalyticsChart() {
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

function useDeleteAnalyticsChart() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ reportId, chartId }: { reportId: string; chartId: string }) => {
      const client = await getClient();
      return client.delete<{ data: { deleted: boolean } }>(
        `/project-analytics/reports/${reportId}/charts/${chartId}`,
      );
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: projectKeys.analyticsCharts(variables.reportId) });
      qc.invalidateQueries({ queryKey: projectKeys.analyticsReport(variables.reportId) });
      qc.invalidateQueries({ queryKey: projectKeys.analyticsReports() });
    },
  });
}

function useDuplicateAnalyticsChart() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ reportId, chartId }: { reportId: string; chartId: string }) => {
      const client = await getClient();
      return client.post<{ data: { id: string } }>(
        `/project-analytics/reports/${reportId}/charts/${chartId}/duplicate`,
        {},
      );
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: projectKeys.analyticsCharts(variables.reportId) });
      qc.invalidateQueries({ queryKey: projectKeys.analyticsReport(variables.reportId) });
      qc.invalidateQueries({ queryKey: projectKeys.analyticsReports() });
    },
  });
}

function useUpdateAnalyticsChartLayouts() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ reportId, layouts }: {
      reportId: string;
      layouts: Array<{ chartId: string; layout: { x: number; y: number; w: number; h: number; minW?: number; minH?: number } }>;
    }) => {
      const client = await getClient();
      return client.patch<{ data: any }>(
        `/project-analytics/reports/${reportId}/charts/layouts`,
        { layouts },
      );
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: projectKeys.analyticsCharts(variables.reportId) });
    },
  });
}
