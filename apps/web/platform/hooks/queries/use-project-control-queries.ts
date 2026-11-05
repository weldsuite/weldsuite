/**
 * WeldFlow project-control hooks: the RAID log (risks, assumptions, issues,
 * dependencies) and the links between register items, tasks and milestones.
 *
 * Every RAID query lives under `raidKeys.all`. `platformSyncMap` invalidates
 * that root for `project_raid_item`, `project_control_link` and (because task
 * progress is part of an item) `project_task` events, so keep the root in step
 * with `lib/realtime/sync-map.ts`.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '@weldsuite/api-client';
import { useAppApi, useAppApiClient } from '@/lib/api/use-app-api';
import { projectKeys } from '@/hooks/queries/use-projects-queries';
import { taskKeys } from '@/hooks/queries/use-task-queries';
import type {
  AssessRiskInput,
  ConvertRaidItemInput,
  CreateControlLinkInput,
  CreateRaidItemInput,
  CreateRaidTaskInput,
  RaidItem,
  UpdateRaidItemInput,
  UpdateRiskCategoriesInput,
} from '@weldsuite/app-api-client/domains/project-control';

export const raidKeys = {
  all: ['project-raid'] as const,
  lists: () => [...raidKeys.all, 'list'] as const,
  list: (projectId: string) => [...raidKeys.lists(), projectId] as const,
  matrices: () => [...raidKeys.all, 'matrix'] as const,
  matrix: (projectId: string, residual: boolean) => [...raidKeys.matrices(), projectId, residual] as const,
  details: () => [...raidKeys.all, 'detail'] as const,
  detail: (id: string) => [...raidKeys.details(), id] as const,
  /** Workspace-wide: the same list for every project. */
  categories: () => [...raidKeys.all, 'categories'] as const,
};

/** Rows per request: the most `GET /api/project-raid` returns. */
const RAID_PAGE_SIZE = 100;
/** A register has tens of items; this only stops a runaway cursor. */
const RAID_MAX_PAGES = 20;

/** A 4xx will not heal by retrying (not found, no access). */
function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  return !(isApiError(error) && error.status >= 400 && error.status < 500) && failureCount < 3;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Every item of a project, all four kinds, open and closed. The register
 * screens filter, sort and count on the client, so they share this one query.
 */
export function useRaidItems(projectId: string, enabled = true) {
  const { projectControl } = useAppApi();

  return useQuery({
    queryKey: raidKeys.list(projectId),
    queryFn: async (): Promise<RaidItem[]> => {
      const items: RaidItem[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < RAID_MAX_PAGES; page++) {
        const res = await projectControl.listRaidItems({ projectId, limit: RAID_PAGE_SIZE, cursor });
        items.push(...res.data);
        if (!res.pagination?.hasMore || !res.pagination.cursor) break;
        cursor = res.pagination.cursor;
      }
      return items;
    },
    enabled: !!projectId && enabled,
    retry: retryUnlessClientError,
  });
}

/** The 5x5 counts of open risks, as they stand now or after mitigation. */
export function useRaidMatrix(projectId: string, residual: boolean, enabled = true) {
  const { projectControl } = useAppApi();

  return useQuery({
    queryKey: raidKeys.matrix(projectId, residual),
    queryFn: () => projectControl.getRaidMatrix({ projectId, residual }),
    select: (res) => res.data,
    enabled: !!projectId && enabled,
    retry: retryUnlessClientError,
  });
}

/** One item with its assessments (newest first), its links and its task progress. */
export function useRaidItem(id: string | null) {
  const { projectControl } = useAppApi();

  return useQuery({
    queryKey: raidKeys.detail(id ?? ''),
    queryFn: () => projectControl.getRaidItem(id as string),
    select: (res) => res.data,
    enabled: !!id,
    retry: retryUnlessClientError,
  });
}

/** The workspace's risk categories: the built-ins (with their hidden flags) and the custom ones. */
export function useRiskCategories(enabled = true) {
  const { projectControl } = useAppApi();

  return useQuery({
    queryKey: raidKeys.categories(),
    queryFn: () => projectControl.getRiskCategories(),
    select: (res) => res.data,
    enabled,
    staleTime: 5 * 60_000,
    retry: retryUnlessClientError,
  });
}

export interface ProjectMilestoneOption {
  id: string;
  name: string;
  dueDate: string | null;
  status: string;
}

/**
 * The project's milestones, for the "threatens milestone" link. Optional data:
 * a member without `milestones:read` simply gets an empty list.
 */
export function useProjectMilestones(projectId: string, enabled = true) {
  const { getClient } = useAppApiClient();

  return useQuery({
    queryKey: [...projectKeys.milestones(projectId), 'options'] as const,
    queryFn: async (): Promise<ProjectMilestoneOption[]> => {
      const client = await getClient();
      try {
        const res = await client.get<{ data: ProjectMilestoneOption[] }>(
          `/milestones?projectId=${encodeURIComponent(projectId)}&limit=100`,
        );
        return res.data;
      } catch (error) {
        if (isApiError(error) && error.status === 403) return [];
        throw error;
      }
    },
    enabled: !!projectId && enabled,
    retry: retryUnlessClientError,
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

type QueryClient = ReturnType<typeof useQueryClient>;

/** A register write changes the lists, the matrix and every open detail. */
function invalidateRaid(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: raidKeys.all });
}

/** A write that also moves tasks (a new task, a task marked done). */
function invalidateRaidAndTasks(qc: QueryClient, projectId: string) {
  qc.invalidateQueries({ queryKey: [...projectKeys.all, projectId, 'tasks'] });
  qc.invalidateQueries({ queryKey: taskKeys.all });
  return invalidateRaid(qc);
}

export function useCreateRaidItem() {
  const { projectControl } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateRaidItemInput) => projectControl.createRaidItem(input),
    onSuccess: () => invalidateRaid(qc),
  });
}

export function useUpdateRaidItem() {
  const { projectControl } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; data: UpdateRaidItemInput }) => projectControl.updateRaidItem(input.id, input.data),
    onSuccess: () => invalidateRaid(qc),
  });
}

/** Replace the risk categories. A rename moves items too, so every RAID query refreshes. */
export function useUpdateRiskCategories() {
  const { projectControl } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateRiskCategoriesInput) => projectControl.updateRiskCategories(input),
    onSuccess: () => invalidateRaid(qc),
  });
}

export function useDeleteRaidItem() {
  const { projectControl } = useAppApi();
  const qc = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: (id) => projectControl.deleteRaidItem(id),
    onSuccess: () => invalidateRaid(qc),
  });
}

export function useAssessRisk() {
  const { projectControl } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; data: AssessRiskInput }) => projectControl.assessRisk(input.id, input.data),
    onSuccess: () => invalidateRaid(qc),
  });
}

export function useConvertRaidItem() {
  const { projectControl } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; data: ConvertRaidItemInput }) => projectControl.convertRaidItem(input.id, input.data),
    onSuccess: () => invalidateRaid(qc),
  });
}

/** A new mitigation task (risk) or resolution task (issue), linked to the item. */
export function useCreateRaidTask(projectId: string) {
  const { projectControl } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; data: CreateRaidTaskInput }) => projectControl.createRaidTask(input.id, input.data),
    onSuccess: () => invalidateRaidAndTasks(qc, projectId),
  });
}

export function useCreateControlLink() {
  const { projectControl } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateControlLinkInput) => projectControl.createControlLink(input),
    onSuccess: () => invalidateRaid(qc),
  });
}

export function useDeleteControlLink() {
  const { projectControl } = useAppApi();
  const qc = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: (linkId) => projectControl.deleteControlLink(linkId),
    onSuccess: () => invalidateRaid(qc),
  });
}

/** Check a linked task off (or back to to-do) from the item's detail. */
export function useSetRaidTaskDone(projectId: string) {
  const { tasks } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { taskId: string; done: boolean }) =>
      tasks.update(input.taskId, { status: input.done ? 'done' : 'todo' }),
    onSuccess: () => invalidateRaidAndTasks(qc, projectId),
  });
}
