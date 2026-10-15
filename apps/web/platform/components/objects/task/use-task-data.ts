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
import { useAppApi, useAppApiClient } from '@/lib/api/use-app-api';
import type { CreateTaskInput, UpdateTaskInput } from '@weldsuite/app-api-client/schemas/tasks';
import type { TaskRow } from '@weldsuite/app-api-client/domains/tasks';

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
      // Project task lists live under ['projects', projectId, 'tasks', ...] — no
      // entry in that key starts with "task", so match the segment explicitly.
      if (first === 'projects') return k.includes('tasks');
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
  ancestors: (parentTaskId: string) => [...taskPanelKeys.all, 'ancestors', parentTaskId] as const,
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

/**
 * The task's subtasks. In a project the API also nests every deeper level
 * under `children` (includeSubtasks), so the panel shows the whole subtree;
 * tasks outside a project get their direct children only. `task` is the
 * loaded task row, undefined while it is still loading.
 */
export function useTaskSubtasks(taskId: string | null | undefined, task: TaskRow | undefined) {
  const api = useAppApi();
  const projectId = task ? (task.projectId ?? null) : undefined;
  return useQuery({
    queryKey: [...taskPanelKeys.subtasks(taskId ?? ''), projectId ?? null],
    queryFn: async () => {
      const res = await api.tasks.list({
        parentTaskId: taskId!,
        limit: 100,
        ...(projectId ? { projectId, includeSubtasks: true } : {}),
      });
      return res.data ?? [];
    },
    // `projectId` is undefined until the task itself has loaded; null means
    // "no project". Waiting avoids fetching the flat list and then the tree.
    enabled: !!taskId && projectId !== undefined,
    staleTime: 10_000,
  });
}

/** Deepest parent-chain walk; matches the API's MAX_SUBTASK_DEPTH. */
const MAX_ANCESTOR_DEPTH = 10;

/**
 * The chain of tasks above a subtask, root first (last = `parentTaskId`
 * itself), so the panel can show which main task a subtask belongs to.
 */
export function useTaskAncestors(parentTaskId: string | null | undefined) {
  const api = useAppApi();
  return useQuery({
    queryKey: taskPanelKeys.ancestors(parentTaskId ?? ''),
    queryFn: async () => {
      const chain: TaskRow[] = [];
      const seen = new Set<string>();
      let nextId: string | null | undefined = parentTaskId;
      while (nextId && !seen.has(nextId) && chain.length < MAX_ANCESTOR_DEPTH) {
        seen.add(nextId);
        const res = await api.tasks.get(nextId);
        if (!res.data) break;
        chain.unshift(res.data);
        nextId = res.data.parentTaskId;
      }
      return chain;
    },
    enabled: !!parentTaskId,
    staleTime: 15_000,
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

/**
 * Companies the task's "Company" field can link to. Only fetched for tasks
 * that are not part of a project (CRM / personal tasks), which are the ones
 * that carry a CRM record link.
 */
export function useTaskCompanyOptions(enabled: boolean) {
  const api = useAppApi();
  return useQuery({
    queryKey: [...taskPanelKeys.all, 'company-options'] as const,
    queryFn: async () => {
      const res = await api.companies.list({ limit: 100 });
      return res.data ?? [];
    },
    enabled,
    staleTime: 60_000,
  });
}

/**
 * CRM people the task's record field can link to. `inCrm` matches the People
 * table's own filter, so mail/helpdesk auto-created contacts stay out.
 */
export function useTaskPersonOptions(enabled: boolean) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...taskPanelKeys.all, 'person-options'] as const,
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{
        data: { id: string; displayName?: string | null; avatarUrl?: string | null }[];
      }>('/people?limit=100&inCrm=true');
      return res.data ?? [];
    },
    enabled,
    staleTime: 60_000,
  });
}

export function useUpdateTask(taskId: string) {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: UpdateTaskInput) => {
      await api.tasks.update(taskId, data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: taskPanelKeys.task(taskId) });
      invalidateAllTaskLists(qc);
    },
  });
}

/**
 * Fired on `window` after a task is deleted from the panel. Pages that keep
 * their task list in local state (Gantt, pipeline) listen and drop the row;
 * react-query lists are covered by the invalidation below.
 */
export const TASK_DELETED_EVENT = 'weldflow:task-deleted';

export function useDeleteTask(taskId: string) {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api.tasks.delete(taskId);
    },
    onSuccess: () => {
      window.dispatchEvent(new CustomEvent(TASK_DELETED_EVENT, { detail: { id: taskId } }));
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
      // Every open subtree can contain the new row (an ancestor's panel shows
      // the whole tree), so refresh all of them, not just the parent's.
      qc.invalidateQueries({ queryKey: [...taskPanelKeys.all, 'subtasks'] });
      qc.invalidateQueries({ queryKey: taskPanelKeys.task(parentTaskId) });
      invalidateAllTaskLists(qc);
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

/**
 * Duplicate a task: creates the copy, then refreshes every task list so it
 * shows up without a reload.
 */
export function useDuplicateTask() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateTaskInput) => {
      const res = await api.tasks.create(data);
      return res.data;
    },
    onSuccess: () => {
      invalidateAllTaskLists(qc);
    },
  });
}
