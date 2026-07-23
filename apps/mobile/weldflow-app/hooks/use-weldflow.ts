import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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

export const qk = {
  projects: (params?: ListProjectsQuery) => ['weldflow', 'projects', params ?? {}] as const,
  project: (id: string) => ['weldflow', 'project', id] as const,
  projectTasks: (projectId: string, params?: ListTasksQuery) =>
    ['weldflow', 'project-tasks', projectId, params ?? {}] as const,
  task: (projectId: string, taskId: string) => ['weldflow', 'task', projectId, taskId] as const,
  myTasks: (params?: ListMyTasksQuery) => ['weldflow', 'my-tasks', params ?? {}] as const,
  projectMembers: (projectId: string) => ['weldflow', 'project-members', projectId] as const,
  labels: () => ['weldflow', 'labels'] as const,
};

export function useProjects(params: ListProjectsQuery = { limit: 25 }) {
  return useQuery({
    queryKey: qk.projects(params),
    queryFn: () => api.weldflow.listProjects(params),
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
