
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient, useAppApi } from '@/lib/api/use-app-api';
import type { Projects } from '@/lib/api/types/apps/projects.types';

// =============================================================================
// Query Keys
// =============================================================================

export const taskKeys = {
  all: ['task'] as const,
  dashboard: () => [...taskKeys.all, 'dashboard'] as const,
  tasks: () => [...taskKeys.all, 'tasks'] as const,
  taskList: (filters?: Record<string, unknown>) => [...taskKeys.tasks(), 'list', filters] as const,
  taskDetail: (id: string) => [...taskKeys.tasks(), 'detail', id] as const,
  importantTasks: () => [...taskKeys.tasks(), 'important'] as const,
  myTasks: () => [...taskKeys.tasks(), 'my'] as const,
  projects: () => [...taskKeys.all, 'projects'] as const,
  projectList: (params?: Record<string, unknown>) => [...taskKeys.projects(), 'list', params] as const,
  projectDetail: (id: string) => [...taskKeys.projects(), 'detail', id] as const,
  tags: (params?: Record<string, unknown>) => [...taskKeys.all, 'tags', params] as const,
  teamMembers: (params?: Record<string, unknown>) => [...taskKeys.all, 'team-members', params] as const,
  teamMemberDetail: (id: string) => [...taskKeys.all, 'team-members', 'detail', id] as const,
};

// =============================================================================
// Helper to build query string
// =============================================================================

function buildQueryString(params: Record<string, unknown>): string {
  const queryParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      if (Array.isArray(value)) {
        value.forEach((v) => queryParams.append(key, String(v)));
      } else {
        queryParams.set(key, String(value));
      }
    }
  }
  const query = queryParams.toString();
  return query ? `?${query}` : '';
}

// =============================================================================
// Queries
// =============================================================================

export function useTasks(filters?: {
  status?: string;
  priority?: string;
  assigneeId?: string;
  customerId?: string;
  personId?: string;
  contactId?: string;
  projectId?: string;
  tags?: string[];
  isImportant?: boolean;
  isArchived?: boolean;
  search?: string;
  page?: number;
  pageSize?: number;
  cursor?: string;
}) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: taskKeys.taskList(filters),
    queryFn: async () => {
      const client = await getClient();
      const qs: Record<string, unknown> = { ...(filters ?? {}) };
      if (qs.pageSize !== undefined) {
        qs.limit = qs.pageSize;
        delete qs.pageSize;
      }
      delete qs.page;
      const query = buildQueryString(qs);
      return client.get<{
        data: unknown[];
        pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
      }>(`/tasks${query}`);
    },
  });
}
export function useTaskProjects(params?: { page?: number; pageSize?: number; cursor?: string }) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: taskKeys.projectList(params),
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
        data: unknown[];
        pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
      }>(`/task-projects${query}`);
    },
  });
}export type MyTasksFilters = {
  search?: string;
  status?: string;
  priority?: string;
  projectId?: string;
  labelIds?: string[];
  dueDateBucket?: 'overdue' | 'today' | 'this-week' | 'later' | 'no-date';
  sortField?: 'title' | 'status' | 'priority' | 'dueDate' | 'assignee' | 'position' | 'createdAt';
  sortDirection?: 'asc' | 'desc';
};

export function useInfiniteMyTasks(filters: MyTasksFilters = {}, pageSize = 50) {
  const { getClient } = useAppApiClient();
  return useInfiniteQuery({
    queryKey: [...taskKeys.myTasks(), 'infinite', pageSize, filters],
    queryFn: async ({ pageParam = 1 }) => {
      const client = await getClient();
      const query = buildQueryString({
        page: pageParam,
        pageSize,
        ...filters,
        labelIds: filters.labelIds && filters.labelIds.length > 0 ? filters.labelIds.join(',') : undefined,
      });
      return client.get<{
        data: Projects.ProjectTask[];
        pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
      }>(`/my-tasks${query}`);
    },
    initialPageParam: 1,
    // app-api /my-tasks is offset-based: it returns `hasMore` (cursor is null),
    // so the next page is simply the running page count + 1.
    getNextPageParam: (lastPage, allPages) => {
      return lastPage.pagination?.hasMore ? allPages.length + 1 : undefined;
    },
  });
}

// =============================================================================
// Mutations
// =============================================================================

export function useCreateTask() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      title: string;
      description?: string;
      status?: string;
      priority?: string;
      assigneeId?: string;
      projectId?: string;
      dueDate?: string;
      tags?: string[];
      isImportant?: boolean;
    }) => {
      const client = await getClient();
      return client.post<{ data: unknown }>('/tasks', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: taskKeys.tasks() });
      qc.invalidateQueries({ queryKey: taskKeys.dashboard() });
    },
  });
}/**
 * Move a task (and its subtasks) to another project. Project-scoped references
 * are cleared & reset server-side. Gated behind the `weldflow-move-task`
 * Flagship flag (enforced both in the UI and on the endpoint).
 */
export function useMoveTask() {
  const { tasks } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, projectId }: { id: string; projectId: string }) => {
      const res = await tasks.move(id, { projectId });
      return res.data;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: taskKeys.tasks() });
      qc.invalidateQueries({ queryKey: taskKeys.taskDetail(variables.id) });
      qc.invalidateQueries({ queryKey: taskKeys.projects() });
      qc.invalidateQueries({ queryKey: taskKeys.dashboard() });
    },
  });
}