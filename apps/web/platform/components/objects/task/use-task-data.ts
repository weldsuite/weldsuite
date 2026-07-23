/**
 * React-Query hooks for the task object panel — all reads/writes go through
 * the new app-api worker via `useAppApi()`. The panel is self-contained:
 * callers just `useObjectPanel().open('task', id)` and this layer fetches
 * task, comments, subtasks, labels, members.
 *
 * Endpoints used (all on app-api):
 *   - GET    /api/tasks/:id
 *   - GET    /api/tasks?parentTaskId=…       (subtasks)
 *   - GET    /api/tasks?projectId=…          (dep-picker source)
 *   - PATCH  /api/tasks/:id
 *   - DELETE /api/tasks/:id
 *   - GET    /api/task-comments?taskId=…
 *   - POST/PATCH/DELETE /api/task-comments[/:id]
 *   - GET    /api/project-labels?projectId=…
 *   - POST   /api/project-labels
 *   - GET    /api/project-members?projectId=…
 *   - GET    /api/team-members               (workspace fallback)
 */

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';

/**
 * Broad invalidation predicate — bumps every React-Query cache entry whose
 * key looks task-shaped. Callers of the panel (my-tasks, pipeline, tasks,
 * gantt) each maintain their own list cache under their own key prefix; the
 * panel doesn't know which page it's open on top of, so the cheapest correct
 * thing is to invalidate them all.
 */
function invalidateAllTaskLists(qc: QueryClient): void {
  qc.invalidateQueries({
    predicate: (q) => {
      const k = q.queryKey;
      if (!Array.isArray(k)) return false;
      const first = String(k[0] ?? '');
      return (
        first === 'task-panel' ||
        first === 'app-api' ||
        first === 'crm-tasks' ||
        first === 'tasks' ||
        first === 'project-tasks' ||
        first === 'my-tasks' ||
        first.includes('task')
      );
    },
  });
}

const taskPanelKeys = {
  all: ['app-api', 'task-panel'] as const,
  task: (taskId: string) => [...taskPanelKeys.all, 'task', taskId] as const,
  comments: (taskId: string) => [...taskPanelKeys.all, 'comments', taskId] as const,
  subtasks: (taskId: string) => [...taskPanelKeys.all, 'subtasks', taskId] as const,
  labels: (projectId: string | null | undefined) =>
    [...taskPanelKeys.all, 'labels', projectId ?? '__workspace__'] as const,
  projectTasks: (projectId: string) =>
    [...taskPanelKeys.all, 'project-tasks', projectId] as const,
  projectMembers: (projectId: string) =>
    [...taskPanelKeys.all, 'project-members', projectId] as const,
  workspaceMembers: () => [...taskPanelKeys.all, 'workspace-members'] as const,
};

export function useTaskById(taskId: string | null | undefined) {
  const api = useAppApi();
  return useQuery({
    queryKey: taskPanelKeys.task(taskId ?? ''),
    queryFn: async () => {
      const res = await api.tasks.get(taskId!);
      return res.data;
    },
    enabled: !!taskId,
    staleTime: 15_000,
  });
}

export function useTaskComments(taskId: string | null | undefined) {
  const api = useAppApi();
  return useQuery({
    queryKey: taskPanelKeys.comments(taskId ?? ''),
    queryFn: async () => {
      const res = await api.taskComments.list({ taskId: taskId!, limit: 100 });
      return res.data ?? [];
    },
    enabled: !!taskId,
    staleTime: 10_000,
  });
}

export function useTaskSubtasks(taskId: string | null | undefined) {
  const api = useAppApi();
  return useQuery({
    queryKey: taskPanelKeys.subtasks(taskId ?? ''),
    queryFn: async () => {
      const res = await api.tasks.list({ parentTaskId: taskId!, limit: 100 });
      return res.data ?? [];
    },
    enabled: !!taskId,
    staleTime: 10_000,
  });
}

export function useProjectLabels(projectId: string | null | undefined) {
  const api = useAppApi();
  return useQuery({
    queryKey: taskPanelKeys.labels(projectId),
    queryFn: async () => {
      // App-api treats omitted projectId as "workspace-wide" labels.
      const res = await api.projectLabels.list(projectId ? { projectId, limit: 100 } : { limit: 100 });
      return res.data ?? [];
    },
    staleTime: 30_000,
  });
}

export function useProjectTasksForDeps(projectId: string | null | undefined) {
  const api = useAppApi();
  return useQuery({
    queryKey: taskPanelKeys.projectTasks(projectId ?? ''),
    queryFn: async () => {
      const res = await api.tasks.list({ projectId: projectId!, limit: 100 });
      return res.data ?? [];
    },
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useProjectMembers(projectId: string | null | undefined) {
  const api = useAppApi();
  return useQuery({
    queryKey: taskPanelKeys.projectMembers(projectId ?? ''),
    queryFn: async () => {
      const res = await api.projectMembers.list({ projectId: projectId!, limit: 100 });
      return res.data ?? [];
    },
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useWorkspaceMembersForTaskPanel() {
  const api = useAppApi();
  return useQuery({
    queryKey: taskPanelKeys.workspaceMembers(),
    queryFn: async () => {
      const res = await api.teamMembers.list();
      return res.data ?? [];
    },
    staleTime: 60_000,
  });
}

export function useUpdateTask(taskId: string) {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Record<string, any>) => {
      await api.tasks.update(taskId, data as any);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: taskPanelKeys.task(taskId) });
      invalidateAllTaskLists(qc);
    },
  });
}

export function useDeleteTask(taskId: string) {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api.tasks.delete(taskId);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: taskPanelKeys.all });
      invalidateAllTaskLists(qc);
    },
  });
}

/**
 * Task attachments are backed by real `files` rows (entityType='task'), not the
 * legacy customFields blob. Add persists a files row for a just-uploaded object;
 * remove soft-deletes it. Both refetch the task so its `attachments` array (and
 * the list `attachmentsCount` badge) update. See docs/custom-fields-blob-extraction.md.
 */
export function useAddTaskAttachment(taskId: string) {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    // Task-scoped endpoint (gated by tasks:update, not Drive files:*). Returns
    // the persisted row so callers can reconcile an optimistic entry's temp id.
    mutationFn: async (a: {
      fileName: string;
      fileKey: string;
      fileSize: number;
      mimeType: string;
      url: string;
    }) => {
      const res = await api.tasks.addAttachment(taskId, a);
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: taskPanelKeys.task(taskId) });
      invalidateAllTaskLists(qc);
    },
  });
}

export function useRemoveTaskAttachment(taskId: string) {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (fileId: string) => {
      await api.tasks.removeAttachment(taskId, fileId);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: taskPanelKeys.task(taskId) });
      invalidateAllTaskLists(qc);
    },
  });
}

export function useToggleTask(taskId: string, currentStatus: string | undefined) {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const next = currentStatus === 'done' ? 'todo' : 'done';
      await api.tasks.update(taskId, { status: next });
      return next;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: taskPanelKeys.task(taskId) });
      invalidateAllTaskLists(qc);
    },
  });
}

export function useAddTaskComment(taskId: string) {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: string) => {
      await api.taskComments.create({ taskId, body });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: taskPanelKeys.comments(taskId) });
    },
  });
}

export function useUpdateTaskComment(taskId: string) {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: string }) => {
      await api.taskComments.update(id, { body, taskId });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: taskPanelKeys.comments(taskId) });
    },
  });
}

export function useDeleteTaskComment(taskId: string) {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.taskComments.delete(id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: taskPanelKeys.comments(taskId) });
    },
  });
}

export function useCreateProjectLabel(projectId: string | null | undefined) {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { name: string; color: string }) => {
      const res = await api.projectLabels.create({
        ...data,
        ...(projectId ? { projectId } : {}),
      });
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: taskPanelKeys.labels(projectId) });
    },
  });
}

export function useCreateSubtask(parentTaskId: string, projectId: string | null | undefined) {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { title: string; status?: string }) => {
      const res = await api.tasks.create({
        title: data.title,
        status: data.status ?? 'todo',
        parentTaskId,
        ...(projectId ? { projectId } : {}),
      });
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: taskPanelKeys.subtasks(parentTaskId) });
    },
  });
}

export function useToggleSubtask() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, currentStatus }: { id: string; currentStatus: string }) => {
      const next = currentStatus === 'done' ? 'todo' : 'done';
      await api.tasks.update(id, { status: next });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: taskPanelKeys.all });
      invalidateAllTaskLists(qc);
    },
  });
}
