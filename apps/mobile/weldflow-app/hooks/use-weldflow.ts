import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  ListProjectsQuery,
  ListTasksQuery,
  ListMyTasksQuery,
  CreateTaskInput,
  UpdateTaskInput,
  UpdateTaskStatusInput,
  CreateLabelInput,
} from '@/types/weldflow';
import api from '@/services/app-api';
import { nextCursorParam, nextPageParam } from '@/lib/pagination';

/** Paging is the hook's job: callers pass filters only. */
type InfiniteProjectsParams = Omit<ListProjectsQuery, 'cursor'>;
type InfiniteProjectTasksParams = Omit<ListTasksQuery, 'cursor'>;
type InfiniteMyTasksParams = Omit<ListMyTasksQuery, 'cursor' | 'page'>;

// Infinite lists cache `{ pages, pageParams }`, not a single page, so they get
// their own `infinite` key segment. Sharing a key with the plain hooks would
// hand one hook the other's data shape. Everything stays under `['weldflow']`
// so the mutations' blanket invalidation still refreshes them.
export const qk = {
  projects: (params?: ListProjectsQuery) => ['weldflow', 'projects', params ?? {}] as const,
  projectsInfinite: (params?: InfiniteProjectsParams) =>
    ['weldflow', 'projects', 'infinite', params ?? {}] as const,
  project: (id: string) => ['weldflow', 'project', id] as const,
  projectTasks: (projectId: string, params?: ListTasksQuery) =>
    ['weldflow', 'project-tasks', projectId, params ?? {}] as const,
  projectTasksInfinite: (projectId: string, params?: InfiniteProjectTasksParams) =>
    ['weldflow', 'project-tasks', projectId, 'infinite', params ?? {}] as const,
  task: (projectId: string, taskId: string) => ['weldflow', 'task', projectId, taskId] as const,
  subtasks: (taskId: string) => ['weldflow', 'subtasks', taskId] as const,
  myTasks: (params?: ListMyTasksQuery) => ['weldflow', 'my-tasks', params ?? {}] as const,
  myTasksInfinite: (params?: InfiniteMyTasksParams) =>
    ['weldflow', 'my-tasks', 'infinite', params ?? {}] as const,
  projectMembers: (projectId: string) => ['weldflow', 'project-members', projectId] as const,
  labels: () => ['weldflow', 'labels'] as const,
};

export function useProjects(params: ListProjectsQuery = { limit: 25 }) {
  return useQuery({
    queryKey: qk.projects(params),
    queryFn: () => api.weldflow.listProjects(params),
  });
}

/** Keyset-paged projects (`GET /api/projects`, cursor = id of the last row). */
export function useInfiniteProjects(params: InfiniteProjectsParams = { limit: 25 }) {
  return useInfiniteQuery({
    queryKey: qk.projectsInfinite(params),
    queryFn: ({ pageParam }) =>
      api.weldflow.listProjects({ ...params, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => nextCursorParam(lastPage),
  });
}

export function useProject(projectId: string) {
  return useQuery({
    queryKey: qk.project(projectId),
    queryFn: () => api.weldflow.getProject(projectId),
    enabled: !!projectId,
  });
}

export function useProjectTasks(projectId: string, params: ListTasksQuery = { limit: 50 }) {
  return useQuery({
    queryKey: qk.projectTasks(projectId, params),
    queryFn: () => api.weldflow.listProjectTasks(projectId, params),
    enabled: !!projectId,
  });
}

/** Top-level tasks of a project, keyset-paged from the second page on. */
export function useInfiniteProjectTasks(
  projectId: string,
  params: InfiniteProjectTasksParams = { limit: 50 },
) {
  return useInfiniteQuery({
    queryKey: qk.projectTasksInfinite(projectId, params),
    queryFn: ({ pageParam }) =>
      api.weldflow.listProjectTasks(projectId, { ...params, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => nextCursorParam(lastPage),
    enabled: !!projectId,
  });
}

/** Direct children of a task. Pass `enabled: false` to skip the request. */
export function useSubtasks(taskId: string, enabled = true) {
  return useQuery({
    queryKey: qk.subtasks(taskId),
    queryFn: () => api.weldflow.listSubtasks(taskId),
    enabled: enabled && !!taskId,
  });
}

export function useTask(projectId: string, taskId: string) {
  return useQuery({
    queryKey: qk.task(projectId, taskId),
    queryFn: () => api.weldflow.getTask(projectId, taskId),
    enabled: !!projectId && !!taskId,
  });
}

export function useMyTasks(params: ListMyTasksQuery = { limit: 50 }) {
  return useQuery({
    queryKey: qk.myTasks(params),
    queryFn: () => api.weldflow.listMyTasks(params),
  });
}

/** Offset-paged my tasks (`GET /api/my-tasks`, `page` 1, 2, ...). */
export function useInfiniteMyTasks(params: InfiniteMyTasksParams = { limit: 50 }) {
  return useInfiniteQuery({
    queryKey: qk.myTasksInfinite(params),
    queryFn: ({ pageParam }) => api.weldflow.listMyTasks({ ...params, page: pageParam }),
    initialPageParam: 1,
    getNextPageParam: (lastPage, allPages) => nextPageParam(lastPage, allPages),
  });
}

export function useProjectMembers(projectId: string) {
  return useQuery({
    queryKey: qk.projectMembers(projectId),
    queryFn: () => api.weldflow.listProjectMembers(projectId),
    enabled: !!projectId,
  });
}

export function useUpdateTaskStatus(projectId: string, taskId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateTaskStatusInput) =>
      api.weldflow.updateTaskStatus(projectId, taskId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['weldflow'] });
    },
  });
}

export function useUpdateTask(projectId: string, taskId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateTaskInput) => api.weldflow.updateTask(projectId, taskId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['weldflow'] });
    },
  });
}

export function useCreateTask(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateTaskInput) => api.weldflow.createTask(projectId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['weldflow'] });
    },
  });
}

export function useLabels() {
  return useQuery({
    queryKey: qk.labels(),
    queryFn: () => api.weldflow.listLabels(),
  });
}

export function useCreateLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateLabelInput) => api.weldflow.createLabel(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.labels() });
    },
  });
}
