/**
 * WeldFlow agile: what the Backlog and the epic page read and write beyond the
 * shared agile hooks (`use-flow-agile-queries`): a project's items as backlog
 * rows, an epic's items and links, ordering, quick create and delete.
 *
 * Every key sits under `agileKeys.root(projectId)`, which realtime events for
 * project tasks and sprints invalidate (`lib/realtime/sync-map.ts`).
 */

import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '@weldsuite/api-client';
import type { LinkedObject } from '@weldsuite/app-api-client/schemas/project-control';
import { tasksApi, type ApiTask } from '@/app/weldflow/lib/api-client';
import { toBacklogItem, type BacklogItem } from '@/app/weldflow/lib/backlog';
import { useAppApi } from '@/lib/api/use-app-api';
import { isFeatureAvailable } from '@/lib/edition';
import { agileKeys, useProjectDelivery } from '@/hooks/queries/use-flow-agile-queries';
import { taskKeys } from '@/hooks/queries/use-task-queries';

export const agileBacklogKeys = {
  items: (projectId: string) => [...agileKeys.root(projectId), 'backlog-items'] as const,
  epicItems: (projectId: string, epicId: string) => [...agileKeys.root(projectId), 'epic-items', epicId] as const,
  epicLinks: (projectId: string, epicId: string) => [...agileKeys.root(projectId), 'epic-links', epicId] as const,
};

function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  return !(isApiError(error) && error.status >= 400 && error.status < 500) && failureCount < 3;
}

/** A failed envelope from the task API as an error the screens can show. */
function unwrap<T>(res: { success: boolean; data?: T; error?: string }, fallback: string): T {
  if (!res.success || res.data === undefined) throw new Error(res.error || fallback);
  return res.data;
}

/**
 * Every top-level task of the project as a backlog row. The Backlog groups,
 * filters and counts them on the client, so this is one query.
 */
export function useBacklogItems(projectId: string, enabled = true) {
  const delivery = useProjectDelivery(projectId);
  const featureLevel = delivery.settings.itemTypes.featureLevel;
  const select = useCallback(
    (tasks: ApiTask[]): BacklogItem[] => tasks.map((task) => toBacklogItem(task, featureLevel)),
    [featureLevel],
  );
  return useQuery({
    queryKey: agileBacklogKeys.items(projectId),
    queryFn: async () => unwrap(await tasksApi.listAllPages(projectId), 'Failed to load the backlog'),
    select,
    enabled: !!projectId && enabled && isFeatureAvailable('flow-agile'),
    retry: retryUnlessClientError,
  });
}

/** The items of one epic or feature (top-level tasks with that `epicId`). */
export function useEpicItems(projectId: string, epicId: string) {
  const delivery = useProjectDelivery(projectId);
  const featureLevel = delivery.settings.itemTypes.featureLevel;
  const select = useCallback(
    (tasks: ApiTask[]): BacklogItem[] => tasks.map((task) => toBacklogItem(task, featureLevel)),
    [featureLevel],
  );
  return useQuery({
    queryKey: agileBacklogKeys.epicItems(projectId, epicId),
    queryFn: async () => unwrap(await tasksApi.listAllPages(projectId, { epicId }), 'Failed to load the epic'),
    select,
    enabled: !!projectId && !!epicId && isFeatureAvailable('flow-agile'),
    retry: retryUnlessClientError,
  });
}

/**
 * The RAID items and milestones linked to an epic, from both ends of a link
 * (`GET /api/project-control-links`).
 */
export function useEpicLinks(projectId: string, epicId: string) {
  const { projectControl } = useAppApi();
  return useQuery({
    queryKey: agileBacklogKeys.epicLinks(projectId, epicId),
    queryFn: async (): Promise<LinkedObject[]> => {
      const end = { type: 'task' as const, id: epicId };
      const [outgoing, incoming] = await Promise.all([
        projectControl.listControlLinks({ from: end }),
        projectControl.listControlLinks({ to: end }),
      ]);
      const seen = new Set<string>();
      return [...outgoing.data, ...incoming.data].filter((link) => {
        if (seen.has(link.id)) return false;
        seen.add(link.id);
        return link.target.type === 'raid_item' || link.target.type === 'milestone';
      });
    },
    enabled: !!projectId && !!epicId && isFeatureAvailable('flow-agile'),
    retry: retryUnlessClientError,
  });
}

/** Refresh the project's lists, the shared agile queries and the task panel. */
function useInvalidateBacklog(projectId: string) {
  const qc = useQueryClient();
  return useCallback(
    () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: agileKeys.project(projectId) }),
        qc.invalidateQueries({ queryKey: taskKeys.all }),
        qc.invalidateQueries({ queryKey: ['app-api', 'task-panel'] }),
      ]),
    [qc, projectId],
  );
}

/** Save an order: the ids of one section, first to last (`PATCH /tasks/reorder`). */
export function useReorderItems(projectId: string) {
  const invalidate = useInvalidateBacklog(projectId);
  return useMutation({
    mutationFn: async (taskIds: string[]) => unwrap(await tasksApi.reorderTasks(projectId, taskIds), 'Failed to reorder'),
    onSettled: invalidate,
  });
}

export interface CreateItemInput {
  title: string;
  type?: string;
  sprintId?: string | null;
  epicId?: string | null;
}

/** A new item with a type, and optionally its sprint or epic. */
export function useCreateItem(projectId: string) {
  const invalidate = useInvalidateBacklog(projectId);
  return useMutation({
    mutationFn: async (input: CreateItemInput) =>
      unwrap(
        await tasksApi.create(projectId, {
          title: input.title,
          type: input.type,
          sprintId: input.sprintId ?? undefined,
          epicId: input.epicId ?? undefined,
        }),
        'Failed to create the item',
      ),
    onSuccess: invalidate,
  });
}

/** Delete items one after the other (a task's own delete removes its subtasks too). */
export function useDeleteItems(projectId: string) {
  const invalidate = useInvalidateBacklog(projectId);
  return useMutation({
    mutationFn: async (taskIds: string[]) => {
      for (const taskId of taskIds) {
        const res = await tasksApi.delete(projectId, taskId);
        if (!res.success) throw new Error(res.error || 'Failed to delete');
      }
    },
    onSettled: invalidate,
  });
}
