/**
 * WeldFlow scheduling hooks: the computed schedule of a project, its task
 * dependencies, and its phases with stage gates.
 *
 * Every query lives under `scheduleKeys.all`. `platformSyncMap` invalidates
 * that root for `task_dependency` and `project_phase` events, so keep the root
 * in step with `lib/realtime/sync-map.ts`. Writes that move task dates also
 * refresh the task lists.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '@weldsuite/api-client';
import { useAppApi } from '@/lib/api/use-app-api';
import { projectKeys } from '@/hooks/queries/use-projects-queries';
import { taskKeys } from '@/hooks/queries/use-task-queries';
import type {
  CreatePhaseInput,
  CreateTaskDependencyInput,
  ReorderPhasesInput,
  ScheduleMoveInput,
  UpdatePhaseInput,
  UpdateScheduleSettingsInput,
  UpdateTaskDependencyInput,
  WaiveCriterionInput,
} from '@weldsuite/app-api-client/domains/project-schedule';

export const scheduleKeys = {
  all: ['project-schedule'] as const,
  schedules: () => [...scheduleKeys.all, 'schedule'] as const,
  schedule: (projectId: string) => [...scheduleKeys.schedules(), projectId] as const,
  previews: () => [...scheduleKeys.all, 'preview'] as const,
  preview: (projectId: string, move: ScheduleMoveInput | null) => [...scheduleKeys.previews(), projectId, move] as const,
  phases: () => [...scheduleKeys.all, 'phases'] as const,
  phaseList: (projectId: string) => [...scheduleKeys.phases(), 'list', projectId] as const,
  phaseCheck: (id: string) => [...scheduleKeys.phases(), 'check', id] as const,
};

/** A 4xx will not heal by retrying (not found, no access). */
function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  return !(isApiError(error) && error.status >= 400 && error.status < 500) && failureCount < 3;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** The computed schedule: early and late dates, float, critical path, conflicts, links. */
export function useProjectSchedule(projectId: string, enabled = true) {
  const { projectSchedule } = useAppApi();
  return useQuery({
    queryKey: scheduleKeys.schedule(projectId),
    queryFn: () => projectSchedule.getProjectSchedule(projectId),
    select: (res) => res.data,
    enabled: !!projectId && enabled,
    retry: retryUnlessClientError,
  });
}

/** What a move would do, before it is saved; idle while no move is being tried. */
export function useScheduleMovePreview(projectId: string, move: ScheduleMoveInput | null) {
  const { projectSchedule } = useAppApi();
  return useQuery({
    queryKey: scheduleKeys.preview(projectId, move),
    queryFn: () => projectSchedule.previewScheduleMove(projectId, move as ScheduleMoveInput),
    select: (res) => res.data,
    enabled: !!projectId && move !== null,
    retry: false,
    staleTime: 0,
  });
}

/** The lifecycle: phases in order, with their gate approvals. */
export function usePhases(projectId: string, enabled = true) {
  const { projectSchedule } = useAppApi();
  return useQuery({
    queryKey: scheduleKeys.phaseList(projectId),
    queryFn: () => projectSchedule.listPhases(projectId),
    select: (res) => res.data,
    enabled: !!projectId && enabled,
    retry: retryUnlessClientError,
  });
}

/** One phase's gate evaluated on read, with the link to the data behind each criterion. */
export function usePhaseGate(phaseId: string | null) {
  const { projectSchedule } = useAppApi();
  return useQuery({
    queryKey: scheduleKeys.phaseCheck(phaseId ?? ''),
    queryFn: () => projectSchedule.checkPhase(phaseId as string),
    select: (res) => res.data,
    enabled: !!phaseId,
    retry: retryUnlessClientError,
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

type QueryClient = ReturnType<typeof useQueryClient>;

function invalidateSchedule(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: scheduleKeys.all });
}

/** A write that moves task dates also changes the task lists and the Gantt. */
function invalidateScheduleAndTasks(qc: QueryClient, projectId: string) {
  qc.invalidateQueries({ queryKey: [...projectKeys.all, projectId, 'tasks'] });
  qc.invalidateQueries({ queryKey: taskKeys.all });
  return invalidateSchedule(qc);
}

export function useCreateTaskDependency(projectId: string) {
  const { projectSchedule } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskDependencyInput) => projectSchedule.createTaskDependency(input),
    onSuccess: () => invalidateScheduleAndTasks(qc, projectId),
  });
}

export function useUpdateTaskDependency() {
  const { projectSchedule } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; data: UpdateTaskDependencyInput }) => projectSchedule.updateTaskDependency(input.id, input.data),
    onSuccess: () => invalidateSchedule(qc),
  });
}

export function useDeleteTaskDependency(projectId: string) {
  const { projectSchedule } = useAppApi();
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => projectSchedule.deleteTaskDependency(id),
    onSuccess: () => invalidateScheduleAndTasks(qc, projectId),
  });
}

/** Save a move. With auto-schedule on, the dependents it pushes move with it, in one batch. */
export function useApplyScheduleMove(projectId: string) {
  const { projectSchedule } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ScheduleMoveInput) => projectSchedule.applyScheduleMove(projectId, input),
    onSuccess: () => invalidateScheduleAndTasks(qc, projectId),
  });
}

/** With auto-schedule off a move is an ordinary edit of the task; the conflicts show afterwards. */
export function useMoveTaskDates(projectId: string) {
  const { tasks } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { taskId: string; startDate: string; dueDate: string }) =>
      tasks.update(input.taskId, { startDate: input.startDate, dueDate: input.dueDate }),
    onSuccess: () => invalidateScheduleAndTasks(qc, projectId),
  });
}

export function useUpdateScheduleSettings(projectId: string) {
  const { projectSchedule } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateScheduleSettingsInput) => projectSchedule.updateScheduleSettings(projectId, input),
    onSuccess: () => invalidateSchedule(qc),
  });
}

export function useCreatePhase() {
  const { projectSchedule } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePhaseInput) => projectSchedule.createPhase(input),
    onSuccess: () => invalidateSchedule(qc),
  });
}

export function useUpdatePhase() {
  const { projectSchedule } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; data: UpdatePhaseInput }) => projectSchedule.updatePhase(input.id, input.data),
    onSuccess: () => invalidateSchedule(qc),
  });
}

export function useDeletePhase() {
  const { projectSchedule } = useAppApi();
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => projectSchedule.deletePhase(id),
    onSuccess: () => invalidateSchedule(qc),
  });
}

export function useReorderPhases() {
  const { projectSchedule } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReorderPhasesInput) => projectSchedule.reorderPhases(input),
    onSuccess: () => invalidateSchedule(qc),
  });
}

export function useTickCriterion() {
  const { projectSchedule } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; index: number; met: boolean }) => projectSchedule.tickCriterion(input.id, input.index, input.met),
    onSuccess: () => invalidateSchedule(qc),
  });
}

export function useWaiveCriterion() {
  const { projectSchedule } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; data: WaiveCriterionInput }) => projectSchedule.waiveCriterion(input.id, input.data),
    onSuccess: () => invalidateSchedule(qc),
  });
}

export function useRequestGateApproval() {
  const { projectSchedule } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => projectSchedule.requestGateApproval(id),
    onSuccess: () => invalidateSchedule(qc),
  });
}
