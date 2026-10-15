
import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTopic } from '@weldsuite/realtime/react';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { calendarKeys } from '@/hooks/queries/use-calendar-queries';
import { toast } from 'sonner';
import { withQuery } from '@/lib/with-query';
import { invalidateOnboardingChecklist } from '@/hooks/queries/use-onboarding-checklist';
import { normalizeTaskStatus } from '@weldsuite/app-api-client/schemas/tasks';

export interface Task {
  id: string;
  /** Workspace-wide sequential number, displayed as the bare number. Null pre-backfill. */
  number?: number | null;
  title: string;
  description?: string;
  status: 'backlog' | 'todo' | 'in_progress' | 'review' | 'testing' | 'done' | 'cancelled';
  priority?: 'low' | 'medium' | 'high';
  assignee?: {
    id: string;
    name: string;
    avatar?: string;
  };
  assignees?: {
    id: string;
    name: string;
    avatar?: string;
  }[];
  linkedCompany?: {
    id: string;
    name: string;
    avatar?: string;
  };
  /** CRM person this task is linked to — mutually exclusive with `linkedCompany`. */
  linkedPerson?: {
    id: string;
    name: string;
    avatar?: string;
  };
  dueDate?: Date;
  createdAt: Date;
  completedAt?: Date;
  labels?: string[];
  repeat?: {
    frequency: 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'custom';
    interval?: number;
    unit?: 'days' | 'weeks' | 'months' | 'years';
  };
  scheduledStart?: Date | null;
  scheduledEnd?: Date | null;
  autoScheduled?: boolean | null;
  /** Minutes. `duration` on both the write payload and the wire read shape. */
  duration?: number;
  /** GitHub Issues integration — set when this task is linked to an issue. */
  githubIssueNumber?: number | null;
  githubRepoLinkId?: string | null;
  /** Set on subtasks: the task this one hangs under. */
  parentTaskId?: string | null;
  /**
   * Only present in the list because it sits in a listed task's subtask tree
   * (it isn't CRM-linked / assigned itself): shown nested, never as a row of
   * its own.
   */
  nestedOnly?: boolean;
}

export const crmTasksKeys = {
  all: ['crm-tasks'] as const,
  list: () => [...crmTasksKeys.all, 'list'] as const,
  /** The CRM tasks page's list: same tasks, plus each one's subtask tree. */
  listWithSubtasks: (assignedToId?: string) => [...crmTasksKeys.list(), assignedToId, 'with-subtasks'] as const,
};

export type RawTask = Omit<
  Task,
  'dueDate' | 'createdAt' | 'completedAt' | 'duration' | 'linkedCompany' | 'linkedPerson'
> & {
  dueDate?: string | null;
  createdAt: string;
  completedAt?: string | null;
  /** Minutes, as stored on the `tasks.duration` column. */
  duration?: number | null;
  /** Legacy alias some payloads (calendar events) use for the same value. */
  durationMinutes?: number | null;
  /** Server-resolved CRM company for `customerId` (flow-api `/tasks`). */
  linkedCompany?: { id: string; name: string; avatar?: string | null } | null;
  /** Server-resolved CRM person for `personId` (flow-api `/tasks`). */
  linkedPerson?: { id: string; name: string; avatar?: string | null } | null;
};

function crmStatusToTaskStatus(s?: Task['status'] | 'in-progress' | 'blocked'): string | undefined {
  if (!s) return undefined;
  if (s === 'in-progress') return 'in_progress';
  if (s === 'blocked') return 'backlog';
  return s;
}

export function hydrate(task: RawTask): Task {
  const { linkedCompany, linkedPerson, duration, durationMinutes, ...rest } = task;
  return {
    ...rest,
    status: normalizeTaskStatus(task.status) as Task['status'],
    dueDate: task.dueDate ? new Date(task.dueDate) : undefined,
    createdAt: new Date(task.createdAt),
    completedAt: task.completedAt ? new Date(task.completedAt) : undefined,
    duration: duration ?? durationMinutes ?? undefined,
    // The API resolves `customerId` to the company record (id, name, avatar).
    linkedCompany: linkedCompany
      ? { id: linkedCompany.id, name: linkedCompany.name, avatar: linkedCompany.avatar ?? undefined }
      : undefined,
    // Same resolution for `personId` — a task links to a company XOR a person.
    linkedPerson: linkedPerson
      ? { id: linkedPerson.id, name: linkedPerson.name, avatar: linkedPerson.avatar ?? undefined }
      : undefined,
  };
}

type RawTaskNode = RawTask & { subtaskCount?: number; children?: RawTaskNode[] };

/** Deepest subtask level loaded; matches the API's MAX_SUBTASK_DEPTH. */
const MAX_SUBTASK_DEPTH = 10;

/**
 * Fill `children` level by level from each row's `subtaskCount`, for an API
 * that ignores `includeSubtasks` without a projectId (it sends no `children`).
 */
async function loadSubtreesByCount(
  client: { get: <T>(url: string) => Promise<T> },
  rows: RawTaskNode[],
): Promise<void> {
  let frontier = rows.filter((row) => (row.subtaskCount ?? 0) > 0);
  for (let depth = 0; depth < MAX_SUBTASK_DEPTH && frontier.length > 0; depth++) {
    const next: RawTaskNode[] = [];
    await Promise.all(frontier.map(async (node) => {
      const params = new URLSearchParams({ parentTaskId: node.id, limit: '100' });
      const res = await client.get<{ data: RawTaskNode[] }>(withQuery('/tasks', params.toString()));
      node.children = res.data ?? [];
      next.push(...node.children.filter((child) => (child.subtaskCount ?? 0) > 0));
    }));
    frontier = next;
  }
}

/**
 * Hydrate a list fetched with `includeSubtasks`: every listed task, plus each
 * subtask in their trees as a row of its own (so row actions find it by id).
 * A subtask that isn't itself one of the listed tasks is marked `nestedOnly`.
 */
export function hydrateTaskTree(rows: RawTaskNode[]): Task[] {
  const listedIds = new Set(rows.map((row) => row.id));
  const seen = new Set<string>();
  const out: Task[] = [];
  const walk = (node: RawTaskNode) => {
    const { children, ...raw } = node;
    if (!seen.has(node.id)) {
      seen.add(node.id);
      out.push({ ...hydrate(raw), nestedOnly: !listedIds.has(node.id) });
    }
    for (const child of children ?? []) walk(child);
  };
  for (const row of rows) walk(row);
  return out;
}

/** The CRM tasks list with every task's subtask tree (shared by the page and its prefetch). */
export async function fetchCrmTasksWithSubtasks(
  client: { get: <T>(url: string) => Promise<T> },
  assignedToId?: string,
): Promise<Task[]> {
  const params = new URLSearchParams();
  if (assignedToId) params.set('assigneeId', assignedToId);
  params.set('crmLinked', 'true');
  params.set('includeSubtasks', 'true');
  const res = await client.get<{ data: RawTaskNode[] }>(withQuery('/tasks', params.toString()));
  const rows = res.data ?? [];
  if (rows.length > 0 && !rows.some((row) => 'children' in row)) await loadSubtreesByCount(client, rows);
  return hydrateTaskTree(rows);
}

/**
 * The CRM tasks page's list: like `useCrmTasks`, plus every task's subtasks
 * (deeper levels included) so the page can nest them under their parent.
 */
export function useCrmTasksWithSubtasks(assignedToId?: string) {
  const { getClient } = useAppApiClient();
  useTaskLiveSync();
  return useQuery({
    queryKey: crmTasksKeys.listWithSubtasks(assignedToId),
    queryFn: async () => fetchCrmTasksWithSubtasks(await getClient(), assignedToId),
  });
}

function useTaskLiveSync(): void {
  const qc = useQueryClient();
  const handler = useCallback(() => {
    qc.invalidateQueries({ queryKey: crmTasksKeys.all });
  }, [qc]);
  useTopic<{ id: string }>('task', handler);
}

export function useCrmTasks(assignedToId?: string) {
  const { getClient } = useAppApiClient();
  useTaskLiveSync();
  return useQuery({
    queryKey: [...crmTasksKeys.list(), assignedToId],
    queryFn: async () => {
      const client = await getClient();
      const params = new URLSearchParams();
      if (assignedToId) params.set('assigneeId', assignedToId);
      // CRM page only shows tasks linked to a company/person — never project tasks.
      params.set('crmLinked', 'true');
      const query = params.toString();
      const res = await client.get<{ data: RawTask[] }>(withQuery('/tasks', query));
      return (res.data ?? []).map(hydrate);
    },
  });
}

export function useCreateTask() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: {
      title: string;
      description?: string;
      status?: Task['status'] | 'in-progress' | 'blocked';
      priority?: NonNullable<Task['priority']>;
      dueDate?: Date;
      /**
       * Pins the task's calendar block to this start (no auto-placement): a task
       * created from a calendar slot lands where it was clicked.
       */
      startDate?: Date;
      assigneeId?: string;
      assigneeIds?: string[];
      /** Minutes. */
      duration?: number;
      linkedCompanyId?: string;
      /** CRM person link — mutually exclusive with `linkedCompanyId`. */
      personId?: string;
      labels?: string[];
      repeat?: NonNullable<Task['repeat']>;
    }) => {
      const client = await getClient();
      try {
        await client.post<{ data: { id: string } }>('/tasks', {
          title: data.title,
          description: data.description,
          status: crmStatusToTaskStatus(data.status),
          priority: data.priority,
          assigneeId: data.assigneeId,
          assigneeIds: data.assigneeIds,
          customerId: data.linkedCompanyId,
          personId: data.personId,
          duration: data.duration,
          dueDate: data.dueDate ? data.dueDate.toISOString() : undefined,
          startDate: data.startDate ? data.startDate.toISOString() : undefined,
          labels: data.labels,
          repeat: data.repeat,
        });
        return { success: true as const };
      } catch (err) {
        return {
          success: false as const,
          error: err instanceof Error ? err.message : 'Failed to create task',
        };
      }
    },
    onSuccess: (result) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: crmTasksKeys.all });
        invalidateOnboardingChecklist(queryClient);
        // Every created task gets a calendar block: refresh the calendar now
        // instead of on the next reload.
        queryClient.invalidateQueries({ queryKey: calendarKeys.all });
        toast.success('Task created');
      } else {
        toast.error(result.error || 'Failed to create task');
      }
    },
    onError: () => {
      toast.error('Failed to create task');
    },
  });
}

export function useToggleTask() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ taskId, completed }: { taskId: string; completed: boolean }) => {
      const client = await getClient();
      await client.patch<{ data: { id: string } }>(`/tasks/${taskId}`, {
        status: completed ? 'done' : 'todo',
      });
    },
    onMutate: async ({ taskId, completed }) => {
      await queryClient.cancelQueries({ queryKey: crmTasksKeys.list() });
      const previousTasks = queryClient.getQueryData<Task[]>(crmTasksKeys.list());
      queryClient.setQueryData<Task[]>(crmTasksKeys.list(), (old) =>
        old?.map((task) =>
          task.id === taskId
            ? { ...task, status: completed ? 'done' : 'todo' }
            : task,
        ),
      );
      return { previousTasks };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousTasks) {
        queryClient.setQueryData(crmTasksKeys.list(), context.previousTasks);
      }
      toast.error('Failed to update task');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: crmTasksKeys.all });
    },
  });
}

export function useUpdateTask() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      taskId,
      data,
    }: {
      taskId: string;
      data: Partial<
        Pick<
          Task,
          'status' | 'dueDate' | 'priority' | 'title' | 'description' | 'repeat' | 'labels' | 'duration'
        >
      > & {
        assignee?: NonNullable<Task['assignee']> | null;
        assignees?: NonNullable<Task['assignees']> | null;
        linkedCompany?: NonNullable<Task['linkedCompany']> | null;
        /** CRM person link — mutually exclusive with `linkedCompany`. */
        linkedPerson?: NonNullable<Task['linkedPerson']> | null;
      };
    }) => {
      const client = await getClient();
      const payload: Record<string, unknown> = { ...data };
      if (data.dueDate) {
        payload.dueDate =
          data.dueDate instanceof Date ? data.dueDate.toISOString() : data.dueDate;
      }
      if (data.assignee !== undefined) {
        payload.assigneeId = data.assignee?.id ?? null;
        delete payload.assignee;
      }
      if (data.linkedCompany !== undefined) {
        payload.customerId = data.linkedCompany?.id ?? null;
        delete payload.linkedCompany;
      }
      if (data.linkedPerson !== undefined) {
        payload.personId = data.linkedPerson?.id ?? null;
        delete payload.linkedPerson;
      }
      await client.patch<{ data: { id: string } }>(`/tasks/${taskId}`, payload);
    },
    onMutate: async ({ taskId, data }) => {
      await queryClient.cancelQueries({ queryKey: crmTasksKeys.list() });
      const previousTasks = queryClient.getQueryData<Task[]>(crmTasksKeys.list());
      queryClient.setQueryData<Task[]>(crmTasksKeys.list(), (old) =>
        old?.map((task) => (task.id === taskId ? ({ ...task, ...data } as Task) : task)),
      );
      return { previousTasks };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousTasks) {
        queryClient.setQueryData(crmTasksKeys.list(), context.previousTasks);
      }
      toast.error('Failed to update task');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: crmTasksKeys.all });
    },
  });
}

export function useDeleteTask() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (taskId: string) => {
      const client = await getClient();
      await client.delete<void>(`/tasks/${taskId}`);
      return { success: true as const };
    },
    onMutate: async (taskId) => {
      await queryClient.cancelQueries({ queryKey: crmTasksKeys.list() });
      const previousTasks = queryClient.getQueryData<Task[]>(crmTasksKeys.list());
      queryClient.setQueryData<Task[]>(crmTasksKeys.list(), (old) =>
        old?.filter((task) => task.id !== taskId),
      );
      return { previousTasks };
    },
    onSuccess: () => {
      toast.success('Task deleted');
    },
    onError: (_err, _taskId, context) => {
      if (context?.previousTasks) {
        queryClient.setQueryData(crmTasksKeys.list(), context.previousTasks);
      }
      toast.error('Failed to delete task');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: crmTasksKeys.all });
    },
  });
}
