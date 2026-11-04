/**
 * WeldFlow governance hooks (slice B): decisions, deliverables, the scope and
 * benefits with their measurements, and the goal-card targets.
 *
 * Every query lives under `governanceKeys.all`. `platformSyncMap` invalidates
 * that root for `project_decision`, `project_deliverable`, `project_scope` and
 * `project_benefit` events, so keep the root in step with
 * `lib/realtime/sync-map.ts`.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '@weldsuite/api-client';
import { useAppApi, useAppApiClient } from '@/lib/api/use-app-api';
import { taskKeys } from '@/hooks/queries/use-task-queries';
import type {
  Benefit,
  CreateBenefitInput,
  CreateDecisionInput,
  CreateDeliverableInput,
  CreateMeasurementInput,
  DecideDecisionInput,
  Decision,
  Deliverable,
  PutScopeInput,
  RejectDeliverableInput,
  RequestSignoffInput,
  SupersedeDecisionInput,
  UpdateBenefitInput,
  UpdateDecisionInput,
  UpdateDeliverableInput,
} from '@weldsuite/app-api-client/domains/project-governance';

export const governanceKeys = {
  all: ['project-governance'] as const,
  decisions: (projectId: string) => [...governanceKeys.all, 'decisions', projectId] as const,
  decision: (id: string) => [...governanceKeys.all, 'decision', id] as const,
  deliverables: (projectId: string) => [...governanceKeys.all, 'deliverables', projectId] as const,
  deliverable: (id: string) => [...governanceKeys.all, 'deliverable', id] as const,
  scope: (projectId: string) => [...governanceKeys.all, 'scope', projectId] as const,
  baselines: (projectId: string) => [...governanceKeys.all, 'baselines', projectId] as const,
  benefits: (projectId: string) => [...governanceKeys.all, 'benefits', projectId] as const,
  benefit: (id: string) => [...governanceKeys.all, 'benefit', id] as const,
  goalTargets: (projectId: string) => [...governanceKeys.all, 'goal-targets', projectId] as const,
};

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

/** A 4xx will not heal by retrying (not found, no access). */
function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  return !(isApiError(error) && error.status >= 400 && error.status < 500) && failureCount < 3;
}

/** Read every page of a cursor list. */
async function readAll<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ data: T[]; pagination?: { hasMore: boolean; cursor: string | null } }>,
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchPage(cursor);
    rows.push(...res.data);
    if (!res.pagination?.hasMore || !res.pagination.cursor) break;
    cursor = res.pagination.cursor;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useDecisions(projectId: string) {
  const { projectGovernance } = useAppApi();
  return useQuery({
    queryKey: governanceKeys.decisions(projectId),
    queryFn: (): Promise<Decision[]> =>
      readAll((cursor) => projectGovernance.listDecisions({ projectId, limit: PAGE_SIZE, cursor })),
    enabled: !!projectId,
    retry: retryUnlessClientError,
  });
}

export function useDecision(id: string | null) {
  const { projectGovernance } = useAppApi();
  return useQuery({
    queryKey: governanceKeys.decision(id ?? ''),
    queryFn: () => projectGovernance.getDecision(id as string),
    select: (res) => res.data,
    enabled: !!id,
    retry: retryUnlessClientError,
  });
}

export function useDeliverables(projectId: string) {
  const { projectGovernance } = useAppApi();
  return useQuery({
    queryKey: governanceKeys.deliverables(projectId),
    queryFn: (): Promise<Deliverable[]> =>
      readAll((cursor) => projectGovernance.listDeliverables({ projectId, limit: 200, cursor })),
    enabled: !!projectId,
    retry: retryUnlessClientError,
  });
}

export function useDeliverable(id: string | null) {
  const { projectGovernance } = useAppApi();
  return useQuery({
    queryKey: governanceKeys.deliverable(id ?? ''),
    queryFn: () => projectGovernance.getDeliverable(id as string),
    select: (res) => res.data,
    enabled: !!id,
    retry: retryUnlessClientError,
  });
}

export function useScope(projectId: string) {
  const { projectGovernance } = useAppApi();
  return useQuery({
    queryKey: governanceKeys.scope(projectId),
    queryFn: () => projectGovernance.getScope(projectId),
    select: (res) => res.data,
    enabled: !!projectId,
    retry: retryUnlessClientError,
  });
}

/** One baseline version, as `/api/project-baselines` answers it (slice A). */
export interface BaselineVersion {
  id: string;
  version: number;
  changeRequestId: string | null;
  createdAt: string;
  snapshot?: {
    goLive?: string | null;
    deliverables?: unknown[];
    budgetedAmount?: string | null;
    budgetCurrency?: string | null;
  } | null;
}

/**
 * The baseline versions, newest first. `/api/project-baselines` belongs to the
 * change-control slice: until it answers (4xx, or an empty stub) the list is
 * empty and the Scope page shows its empty state.
 */
export function useBaselineVersions(projectId: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: governanceKeys.baselines(projectId),
    queryFn: async (): Promise<BaselineVersion[]> => {
      const client = await getClient();
      try {
        const res = await client.get<{ data?: BaselineVersion[] }>(
          `/project-baselines?projectId=${encodeURIComponent(projectId)}`,
        );
        const rows = Array.isArray(res?.data) ? res.data : [];
        return [...rows].sort((a, b) => b.version - a.version);
      } catch (error) {
        if (isApiError(error) && error.status >= 400 && error.status < 500) return [];
        throw error;
      }
    },
    enabled: !!projectId,
    retry: retryUnlessClientError,
  });
}

export function useBenefits(projectId: string) {
  const { projectGovernance } = useAppApi();
  return useQuery({
    queryKey: governanceKeys.benefits(projectId),
    queryFn: (): Promise<Benefit[]> =>
      readAll((cursor) => projectGovernance.listBenefits({ projectId, limit: PAGE_SIZE, cursor })),
    enabled: !!projectId,
    retry: retryUnlessClientError,
  });
}

export function useBenefit(id: string | null) {
  const { projectGovernance } = useAppApi();
  return useQuery({
    queryKey: governanceKeys.benefit(id ?? ''),
    queryFn: () => projectGovernance.getBenefit(id as string),
    select: (res) => res.data,
    enabled: !!id,
    retry: retryUnlessClientError,
  });
}

/** Progress of the targets on the project's goal cards. */
export function useGoalTargets(projectId: string) {
  const { projectGovernance } = useAppApi();
  return useQuery({
    queryKey: governanceKeys.goalTargets(projectId),
    queryFn: () => projectGovernance.getGoalTargets(projectId),
    select: (res) => res.data,
    enabled: !!projectId,
    retry: retryUnlessClientError,
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

type QueryClient = ReturnType<typeof useQueryClient>;

/** A governance write changes lists and details alike. */
function invalidate(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: governanceKeys.all });
}

export function useCreateDecision() {
  const { projectGovernance } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDecisionInput) => projectGovernance.createDecision(input),
    onSuccess: () => invalidate(qc),
  });
}

export function useUpdateDecision() {
  const { projectGovernance } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; data: UpdateDecisionInput }) => projectGovernance.updateDecision(input.id, input.data),
    onSuccess: () => invalidate(qc),
  });
}

export function useDeleteDecision() {
  const { projectGovernance } = useAppApi();
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => projectGovernance.deleteDecision(id),
    onSuccess: () => invalidate(qc),
  });
}

export function useDecideDecision() {
  const { projectGovernance } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; data: DecideDecisionInput }) => projectGovernance.decideDecision(input.id, input.data),
    onSuccess: () => invalidate(qc),
  });
}

export function useSupersedeDecision() {
  const { projectGovernance } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; data: SupersedeDecisionInput }) =>
      projectGovernance.supersedeDecision(input.id, input.data),
    onSuccess: () => invalidate(qc),
  });
}

export function useCreateDeliverable() {
  const { projectGovernance } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDeliverableInput) => projectGovernance.createDeliverable(input),
    onSuccess: () => invalidate(qc),
  });
}

export function useUpdateDeliverable() {
  const { projectGovernance } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; data: UpdateDeliverableInput }) =>
      projectGovernance.updateDeliverable(input.id, input.data),
    onSuccess: () => invalidate(qc),
  });
}

export function useDeleteDeliverable() {
  const { projectGovernance } = useAppApi();
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => projectGovernance.deleteDeliverable(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: taskKeys.all });
      return invalidate(qc);
    },
  });
}

export function useRequestSignoff() {
  const { projectGovernance } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; data: RequestSignoffInput }) => projectGovernance.requestSignoff(input.id, input.data),
    onSuccess: () => invalidate(qc),
  });
}

export function useAcceptDeliverable() {
  const { projectGovernance } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => projectGovernance.acceptDeliverable(id),
    onSuccess: () => invalidate(qc),
  });
}

export function useRejectDeliverable() {
  const { projectGovernance } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; data?: RejectDeliverableInput }) => projectGovernance.rejectDeliverable(input.id, input.data),
    onSuccess: () => invalidate(qc),
  });
}

export function usePutScope(projectId: string) {
  const { projectGovernance } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PutScopeInput) => projectGovernance.putScope(projectId, input),
    onSuccess: () => invalidate(qc),
  });
}

export function useCreateBenefit() {
  const { projectGovernance } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBenefitInput) => projectGovernance.createBenefit(input),
    onSuccess: () => invalidate(qc),
  });
}

export function useUpdateBenefit() {
  const { projectGovernance } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; data: UpdateBenefitInput }) => projectGovernance.updateBenefit(input.id, input.data),
    onSuccess: () => invalidate(qc),
  });
}

export function useDeleteBenefit() {
  const { projectGovernance } = useAppApi();
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => projectGovernance.deleteBenefit(id),
    onSuccess: () => invalidate(qc),
  });
}

export function useCreateMeasurement() {
  const { projectGovernance } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; data: CreateMeasurementInput }) =>
      projectGovernance.createMeasurement(input.id, input.data),
    onSuccess: () => invalidate(qc),
  });
}
