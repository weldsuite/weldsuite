/**
 * WeldFlow agile, the sprint screens' own queries: the items of one sprint (the
 * Complete sprint dialog, the sprint report), the open backlog points (the
 * Gantt > Phases forecast) and "Make it a task" for a retro action. The
 * sprint, report, retro and delivery hooks are in `use-flow-agile-queries`.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { tasksApi, type ApiTask } from '@/app/weldflow/lib/api-client';
import { agileKeys, isAgileAvailable } from '@/hooks/queries/use-flow-agile-queries';
import { taskKeys } from '@/hooks/queries/use-task-queries';

/** A sprint's top-level items; `'none'` is the backlog. */
export function useSprintItems(projectId: string, sprintId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: [...agileKeys.root(projectId), 'sprint-items', sprintId ?? ''],
    queryFn: async (): Promise<ApiTask[]> => {
      const res = await tasksApi.listAllPages(projectId, { sprintId: sprintId ?? 'none' });
      if (!res.success || !res.data) throw new Error(res.error ?? 'Failed to load items');
      return res.data;
    },
    enabled: !!projectId && !!sprintId && enabled && isAgileAvailable(),
  });
}

/** Statuses that count as finished work. */
const CLOSED_STATUSES: ReadonlySet<string> = new Set(['done', 'completed', 'cancelled', 'canceled', 'closed']);

/** Whether a task's status means it is finished. */
export function isClosedStatus(status: string | null | undefined): boolean {
  return CLOSED_STATUSES.has((status ?? '').toLowerCase());
}

/** Every top-level item of the project: the sprint report's lists and the phase forecast read it. */
export function useProjectItems<T = ApiTask[]>(projectId: string, enabled = true, select?: (tasks: ApiTask[]) => T) {
  return useQuery({
    queryKey: [...agileKeys.root(projectId), 'items'],
    queryFn: async (): Promise<ApiTask[]> => {
      const res = await tasksApi.listAllPages(projectId);
      if (!res.success || !res.data) throw new Error(res.error ?? 'Failed to load items');
      return res.data;
    },
    select,
    enabled: !!projectId && enabled && isAgileAvailable(),
  });
}

export interface BacklogPoints {
  /** Story points of the items that are not done. */
  open: number;
  /** Story points of every item that was not cancelled. */
  total: number;
}

const sumPoints = (tasks: ApiTask[]): BacklogPoints => {
  let open = 0;
  let total = 0;
  for (const task of tasks) {
    const status = (task.status ?? '').toLowerCase();
    if (status === 'cancelled' || status === 'canceled') continue;
    const points = task.storyPoints ?? 0;
    total += points;
    if (!isClosedStatus(status)) open += points;
  }
  return { open, total };
};

/** The open and total story points of the project's items, for the phase forecast. */
export function useOpenBacklogPoints(projectId: string, enabled = true) {
  return useProjectItems(projectId, enabled, sumPoints);
}

/** A retro action as a task in the backlog (no sprint, type task). */
export function useMakeRetroActionTask(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (title: string) => {
      const res = await tasksApi.create(projectId, { title, type: 'task', sprintId: null });
      if (!res.success || !res.data) throw new Error(res.error ?? 'Failed to create the task');
      return res.data;
    },
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: agileKeys.project(projectId) }),
        qc.invalidateQueries({ queryKey: taskKeys.all }),
      ]),
  });
}
