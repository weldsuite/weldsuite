
import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTopic } from '@weldsuite/realtime/react';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { toast } from 'sonner';

export interface Task {
  id: string;
  /** Workspace-wide sequential number, displayed as TASK-<number>. Null pre-backfill. */
  number?: number | null;
  title: string;
  description?: string;
  status: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'testing' | 'done' | 'cancelled';
  priority?: 'low' | 'medium' | 'high';
  assignee?: {
    id: string;
    name: string;
  };
  assignees?: {
    id: string;
    name: string;
  }[];
  linkedCompany?: {
    id: string;
    name: string;
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
}

export const crmTasksKeys = {
  all: ['crm-tasks'] as const,
  list: () => [...crmTasksKeys.all, 'list'] as const,
};

function crmStatusToTaskStatus(s?: Task['status'] | 'in-progress' | 'blocked'): string | undefined {
  if (!s) return undefined;
  if (s === 'in-progress') return 'in_progress';
  if (s === 'blocked') return 'backlog';
  return s;
}

function hydrate(task: any): Task {
  return {
    ...task,
    dueDate: task.dueDate ? new Date(task.dueDate) : undefined,
    createdAt: new Date(task.createdAt),
    completedAt: task.completedAt ? new Date(task.completedAt) : undefined,
  };
}

function useTaskLiveSync(): void {
  const qc = useQueryClient();
  const handler = useCallback(
    (_event: { event: string; data: { id: string } }) => {
      qc.invalidateQueries({ queryKey: crmTasksKeys.all });
    },
    [qc],
  );
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
      const res = await client.get<{ data: any[] }>(`/tasks${query ? `?${query}` : ''}`);
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
      priority?: Task['priority'];
      dueDate?: Date;
      assigneeId?: string;
      linkedCompanyId?: string;
      labels?: string[];
      repeat?: Task['repeat'];
    }) => {
      const client = await getClient();
      try {
        await client.post<{ data: { id: string } }>('/tasks', {
          title: data.title,
          description: data.description,
          status: crmStatusToTaskStatus(data.status),
          priority: data.priority,
          assigneeId: data.assigneeId,
          customerId: data.linkedCompanyId,
          dueDate: data.dueDate ? data.dueDate.toISOString() : undefined,
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
        Pick<Task, 'status' | 'dueDate' | 'priority' | 'title' | 'description' | 'repeat' | 'labels'>
      > & {
        assignee?: Task['assignee'] | null;
        assignees?: Task['assignees'] | null;
        linkedCompany?: Task['linkedCompany'] | null;
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
