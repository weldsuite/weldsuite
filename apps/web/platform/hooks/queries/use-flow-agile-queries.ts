/**
 * WeldFlow agile hooks: a project's delivery model, its sprints (with start,
 * complete and report), epic roll-ups, the agile fields of a task, and sprint
 * retros. Rust only: every query is off where `flow-agile` is unavailable.
 *
 * Every key sits under `projectKeys.all`, which `lib/realtime/sync-map.ts`
 * invalidates for `project_sprint`, `project_task` and `project_lesson`
 * events, so other people's changes show up too.
 */

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '@weldsuite/api-client';
import type {
  CompleteSprintInput,
  CreateRetroCardInput,
  CreateSprintInput,
  DeliverySettings,
  DeliverySettingsInput,
  StartSprintInput,
  TaskAgileInput,
  UpdateRetroCardInput,
  UpdateSprintInput,
} from '@weldsuite/app-api-client/domains/flow-agile';
import { deliveryModel, type DeliveryModel } from '@/app/weldflow/lib/delivery';
import type { ApiProject } from '@/app/weldflow/lib/api-client';
import { useAppApi } from '@/lib/api/use-app-api';
import { isFeatureAvailable } from '@/lib/edition';
import { projectKeys, useProject } from '@/hooks/queries/use-projects-queries';
import { taskKeys } from '@/hooks/queries/use-task-queries';

export const agileKeys = {
  project: (projectId: string) => [...projectKeys.all, projectId] as const,
  root: (projectId: string) => [...projectKeys.all, projectId, 'agile'] as const,
  sprints: (projectId: string) => [...agileKeys.root(projectId), 'sprints'] as const,
  sprint: (projectId: string, sprintId: string) => [...agileKeys.sprints(projectId), sprintId] as const,
  report: (projectId: string, sprintId: string) => [...agileKeys.sprint(projectId, sprintId), 'report'] as const,
  epics: (projectId: string) => [...agileKeys.root(projectId), 'epics'] as const,
  retro: (projectId: string, sprintId: string) => [...agileKeys.sprint(projectId, sprintId), 'retro'] as const,
};

/** Whether this edition serves agile delivery (Rust only). */
export function isAgileAvailable(): boolean {
  return isFeatureAvailable('flow-agile');
}

/** A 4xx will not heal by retrying. */
function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  return !(isApiError(error) && error.status >= 400 && error.status < 500) && failureCount < 3;
}

// ---------------------------------------------------------------------------
// Delivery approach
// ---------------------------------------------------------------------------

/** The project's delivery model, read from the project detail's settings. */
export function useProjectDelivery(projectId: string): DeliveryModel & { isLoading: boolean } {
  const query = useProject(projectId);
  const settings = query.data?.data?.settings;
  return useMemo(
    () => ({ ...deliveryModel(settings, isAgileAvailable()), isLoading: query.isLoading }),
    [settings, query.isLoading],
  );
}

type ProjectDetail = { data: ApiProject };

/**
 * Save the delivery setting (`PUT /projects/:id/delivery`, written whole).
 * The project detail follows at once and rolls back if the save fails.
 */
export function useUpdateProjectDelivery(projectId: string) {
  const { flowAgile } = useAppApi();
  const qc = useQueryClient();
  const key = projectKeys.detail(projectId);

  const write = (delivery: DeliverySettingsInput | DeliverySettings) =>
    qc.setQueryData<ProjectDetail>(key, (old) =>
      old?.data ? { ...old, data: { ...old.data, settings: { ...old.data.settings, delivery } } } : old,
    );

  return useMutation({
    // Each save sends the whole setting, so they must land in order.
    scope: { id: `project-delivery-${projectId}` },
    mutationFn: (input: DeliverySettingsInput) => flowAgile.updateDelivery(projectId, input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<ProjectDetail>(key);
      write(input);
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) qc.setQueryData(key, context.previous);
    },
    onSuccess: (response) => {
      if (response?.data) write(response.data);
    },
  });
}

// ---------------------------------------------------------------------------
// Sprints
// ---------------------------------------------------------------------------

/** Every sprint of the project (up to 100), newest first. */
export function useProjectSprints(projectId: string, enabled = true) {
  const { flowAgile } = useAppApi();
  return useQuery({
    queryKey: agileKeys.sprints(projectId),
    queryFn: () => flowAgile.listSprints({ projectId, limit: 100 }),
    select: (res) => res.data,
    enabled: !!projectId && enabled && isAgileAvailable(),
    retry: retryUnlessClientError,
  });
}

export function useSprint(projectId: string, sprintId: string) {
  const { flowAgile } = useAppApi();
  return useQuery({
    queryKey: agileKeys.sprint(projectId, sprintId),
    queryFn: () => flowAgile.getSprint(sprintId),
    select: (res) => res.data,
    enabled: !!sprintId && isAgileAvailable(),
    retry: retryUnlessClientError,
  });
}

export function useSprintReport(projectId: string, sprintId: string | null | undefined) {
  const { flowAgile } = useAppApi();
  return useQuery({
    queryKey: agileKeys.report(projectId, sprintId ?? ''),
    queryFn: () => flowAgile.getSprintReport(sprintId ?? ''),
    select: (res) => res.data,
    enabled: !!sprintId && isAgileAvailable(),
    retry: retryUnlessClientError,
  });
}

/** Refresh everything a sprint or task change can move: the project's lists and the task panel. */
function useInvalidateProject(projectId: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: agileKeys.project(projectId) }),
      qc.invalidateQueries({ queryKey: taskKeys.all }),
      qc.invalidateQueries({ queryKey: ['app-api', 'task-panel'] }),
    ]);
}

export function useCreateSprint(projectId: string) {
  const { flowAgile } = useAppApi();
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: (input: Omit<CreateSprintInput, 'projectId'>) => flowAgile.createSprint({ ...input, projectId }),
    onSuccess: invalidate,
  });
}

export function useUpdateSprint(projectId: string) {
  const { flowAgile } = useAppApi();
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateSprintInput }) => flowAgile.updateSprint(id, input),
    onSuccess: invalidate,
  });
}

export function useDeleteSprint(projectId: string) {
  const { flowAgile } = useAppApi();
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: (id: string) => flowAgile.deleteSprint(id),
    onSuccess: invalidate,
  });
}

export function useStartSprint(projectId: string) {
  const { flowAgile } = useAppApi();
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input?: StartSprintInput }) => flowAgile.startSprint(id, input),
    onSuccess: invalidate,
  });
}

export function useCompleteSprint(projectId: string) {
  const { flowAgile } = useAppApi();
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: CompleteSprintInput }) => flowAgile.completeSprint(id, input),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Epics and the agile fields of a task
// ---------------------------------------------------------------------------

export function useProjectEpics(projectId: string, enabled = true) {
  const { flowAgile } = useAppApi();
  return useQuery({
    queryKey: agileKeys.epics(projectId),
    queryFn: () => flowAgile.listEpics(projectId),
    select: (res) => res.data,
    enabled: !!projectId && enabled && isAgileAvailable(),
    retry: retryUnlessClientError,
  });
}

/** Type, sprint, epic, story points or acceptance criteria of one task. */
export function useUpdateTaskAgile(projectId: string) {
  const { flowAgile } = useAppApi();
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: ({ taskId, input }: { taskId: string; input: TaskAgileInput }) =>
      flowAgile.updateTaskAgile(taskId, input),
    onSuccess: invalidate,
  });
}

/** The same change for several tasks (the backlog's bulk bar), one request each. */
export function useBulkUpdateTaskAgile(projectId: string) {
  const { flowAgile } = useAppApi();
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: async ({ taskIds, input }: { taskIds: string[]; input: TaskAgileInput }) => {
      for (const taskId of taskIds) {
        // In order, so the tasks' change events arrive as the user made them.
        await flowAgile.updateTaskAgile(taskId, input);
      }
    },
    onSettled: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Retros
// ---------------------------------------------------------------------------

export function useRetroCards(projectId: string, sprintId: string) {
  const { flowAgile } = useAppApi();
  return useQuery({
    queryKey: agileKeys.retro(projectId, sprintId),
    queryFn: () => flowAgile.listRetroCards(projectId, sprintId),
    select: (res) => res.data,
    enabled: !!projectId && !!sprintId && isAgileAvailable(),
    retry: retryUnlessClientError,
  });
}

function useInvalidateRetro(projectId: string, sprintId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: agileKeys.retro(projectId, sprintId) });
}

export function useCreateRetroCard(projectId: string, sprintId: string) {
  const { flowAgile } = useAppApi();
  const invalidate = useInvalidateRetro(projectId, sprintId);
  return useMutation({
    mutationFn: (input: Omit<CreateRetroCardInput, 'projectId' | 'sprintId'>) =>
      flowAgile.createRetroCard({ ...input, projectId, sprintId }),
    onSuccess: invalidate,
  });
}

export function useUpdateRetroCard(projectId: string, sprintId: string) {
  const { flowAgile } = useAppApi();
  const invalidate = useInvalidateRetro(projectId, sprintId);
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateRetroCardInput }) => flowAgile.updateRetroCard(id, input),
    onSuccess: invalidate,
  });
}

export function useDeleteRetroCard(projectId: string, sprintId: string) {
  const { flowAgile } = useAppApi();
  const invalidate = useInvalidateRetro(projectId, sprintId);
  return useMutation({
    mutationFn: (id: string) => flowAgile.deleteRetroCard(id),
    onSuccess: invalidate,
  });
}

export function useVoteRetroCard(projectId: string, sprintId: string) {
  const { flowAgile } = useAppApi();
  const invalidate = useInvalidateRetro(projectId, sprintId);
  return useMutation({
    mutationFn: ({ id, voted }: { id: string; voted: boolean }) =>
      voted ? flowAgile.unvoteRetroCard(id) : flowAgile.voteRetroCard(id),
    onSuccess: invalidate,
  });
}
