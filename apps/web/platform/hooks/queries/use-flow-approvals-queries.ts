/**
 * WeldFlow approvals hooks (project-control slice A): My reviews, Sent by me,
 * Done, answering, delegation, the sponsor, change requests with their approval
 * rules, and baselines.
 *
 * Every query lives under `flowApprovalKeys.all`. `platformSyncMap` invalidates
 * that root for `flow_approval`, `project_change_request` and `project_baseline`
 * events, so keep the root in step with `lib/realtime/sync-map.ts`.
 *
 * `useMyReviewsCount` runs wherever the WeldFlow sidebar does (every module),
 * so it is one cheap request and never throws.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { isApiError } from '@weldsuite/api-client';
import { useAppApi } from '@/lib/api/use-app-api';
import { projectKeys } from '@/hooks/queries/use-projects-queries';
import { raidKeys } from '@/hooks/queries/use-project-control-queries';
import type {
  ChangeControlSettingsInput,
  CompareBaselinesQuery,
  CreateChangeRequestInput,
  CreateDelegationInput,
  DecideApprovalInput,
  ListChangeRequestsQuery,
  MyReviewsQuery,
  RequestRiskAcceptanceInput,
  UpdateChangeRequestInput,
} from '@weldsuite/app-api-client/domains/flow-approvals';

export const flowApprovalKeys = {
  all: ['flow-approvals'] as const,
  mine: (query: MyReviewsQuery = {}) => [...flowApprovalKeys.all, 'mine', query] as const,
  count: () => [...flowApprovalKeys.all, 'count'] as const,
  sent: (query: MyReviewsQuery = {}) => [...flowApprovalKeys.all, 'sent', query] as const,
  done: (query: MyReviewsQuery = {}) => [...flowApprovalKeys.all, 'done', query] as const,
  delegations: () => [...flowApprovalKeys.all, 'delegations'] as const,
  changes: (projectId: string) => [...flowApprovalKeys.all, 'changes', projectId] as const,
  change: (id: string) => [...flowApprovalKeys.all, 'change', id] as const,
  control: (projectId: string) => [...flowApprovalKeys.all, 'control', projectId] as const,
  baselines: (projectId: string) => [...flowApprovalKeys.all, 'baselines', projectId] as const,
  compare: (query: CompareBaselinesQuery) => [...flowApprovalKeys.all, 'compare', query] as const,
};

/** A 4xx will not heal by retrying (not found, no access). */
function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  return !(isApiError(error) && error.status >= 400 && error.status < 500) && failureCount < 3;
}

// ── My reviews ──────────────────────────────────────────────────────────────

/** How many reviews wait for the current user: the WeldFlow sidebar badge. */
export function useMyReviewsCount(): { data: number } {
  const { flowApprovals } = useAppApi();
  const { isLoaded, isSignedIn, orgId } = useAuth();
  const query = useQuery({
    queryKey: flowApprovalKeys.count(),
    queryFn: async () => {
      try {
        return (await flowApprovals.getMyReviewsCount()).data.count;
      } catch {
        return 0;
      }
    },
    enabled: isLoaded && !!isSignedIn && !!orgId,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  return { data: query.data ?? 0 };
}

export function useMyReviews(query: MyReviewsQuery = {}) {
  const { flowApprovals } = useAppApi();
  return useQuery({
    queryKey: flowApprovalKeys.mine(query),
    queryFn: () => flowApprovals.getMyReviews(query),
    select: (res) => res.data,
    retry: retryUnlessClientError,
  });
}

export function useReviewsSent(query: MyReviewsQuery = {}, enabled = true) {
  const { flowApprovals } = useAppApi();
  return useInfiniteQuery({
    queryKey: flowApprovalKeys.sent(query),
    queryFn: ({ pageParam }) => flowApprovals.listSentReviews({ ...query, cursor: pageParam, limit: 25 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.pagination?.hasMore ? (last.pagination.cursor ?? undefined) : undefined),
    enabled,
    retry: retryUnlessClientError,
  });
}

export function useReviewsDone(query: MyReviewsQuery = {}, enabled = true) {
  const { flowApprovals } = useAppApi();
  return useInfiniteQuery({
    queryKey: flowApprovalKeys.done(query),
    queryFn: ({ pageParam }) => flowApprovals.listDoneReviews({ ...query, cursor: pageParam, limit: 25 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.pagination?.hasMore ? (last.pagination.cursor ?? undefined) : undefined),
    enabled,
    retry: retryUnlessClientError,
  });
}

type QueryClient = ReturnType<typeof useQueryClient>;

/** An answer changes the inbox and whatever the subject changed: projects, change requests, the RAID log. */
function invalidateAfterAnswer(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: flowApprovalKeys.all });
  void queryClient.invalidateQueries({ queryKey: projectKeys.all });
  void queryClient.invalidateQueries({ queryKey: raidKeys.all });
}

export function useDecideReview() {
  const { flowApprovals } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: DecideApprovalInput & { id: string }) => flowApprovals.decideReview(id, input),
    onSuccess: () => invalidateAfterAnswer(queryClient),
  });
}

// ── Delegations and the sponsor ─────────────────────────────────────────────

export function useDelegations() {
  const { flowApprovals } = useAppApi();
  return useQuery({
    queryKey: flowApprovalKeys.delegations(),
    queryFn: () => flowApprovals.listDelegations(),
    select: (res) => res.data,
    retry: retryUnlessClientError,
  });
}

export function useCreateDelegation() {
  const { flowApprovals } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDelegationInput) => flowApprovals.createDelegation(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: flowApprovalKeys.all }),
  });
}

export function useDeleteDelegation() {
  const { flowApprovals } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => flowApprovals.deleteDelegation(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: flowApprovalKeys.all }),
  });
}

export function useSetProjectSponsor(projectId: string) {
  const { flowApprovals } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sponsorId: string | null) => flowApprovals.setProjectSponsor(projectId, { sponsorId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: flowApprovalKeys.control(projectId) });
      void queryClient.invalidateQueries({ queryKey: projectKeys.all });
    },
  });
}

// ── Change requests ─────────────────────────────────────────────────────────

/** Every change request of a project (a project has tens), for the counts and the list. */
export function useChangeRequests(projectId: string, query: Omit<ListChangeRequestsQuery, 'projectId' | 'cursor' | 'limit'> = {}) {
  const { flowApprovals } = useAppApi();
  return useQuery({
    queryKey: [...flowApprovalKeys.changes(projectId), query] as const,
    queryFn: async () => (await flowApprovals.listChangeRequests({ projectId, limit: 100, ...query })).data,
    enabled: !!projectId,
    retry: retryUnlessClientError,
  });
}

export function useChangeRequest(id: string | null) {
  const { flowApprovals } = useAppApi();
  return useQuery({
    queryKey: flowApprovalKeys.change(id ?? ''),
    queryFn: () => flowApprovals.getChangeRequest(id as string),
    select: (res) => res.data,
    enabled: !!id,
    retry: retryUnlessClientError,
  });
}

function invalidateChanges(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: flowApprovalKeys.all });
  void queryClient.invalidateQueries({ queryKey: projectKeys.all });
}

export function useCreateChangeRequest() {
  const { flowApprovals } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateChangeRequestInput) => flowApprovals.createChangeRequest(input),
    onSuccess: () => invalidateChanges(queryClient),
  });
}

export function useUpdateChangeRequest() {
  const { flowApprovals } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateChangeRequestInput & { id: string }) => flowApprovals.updateChangeRequest(id, input),
    onSuccess: () => invalidateChanges(queryClient),
  });
}

export function useDeleteChangeRequest() {
  const { flowApprovals } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => flowApprovals.deleteChangeRequest(id),
    onSuccess: () => invalidateChanges(queryClient),
  });
}

export function useSubmitChangeRequest() {
  const { flowApprovals } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => flowApprovals.submitChangeRequest(id),
    onSuccess: () => invalidateChanges(queryClient),
  });
}

export function useWithdrawChangeRequest() {
  const { flowApprovals } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => flowApprovals.withdrawChangeRequest(id),
    onSuccess: () => invalidateChanges(queryClient),
  });
}

export function useChangeControl(projectId: string) {
  const { flowApprovals } = useAppApi();
  return useQuery({
    queryKey: flowApprovalKeys.control(projectId),
    queryFn: () => flowApprovals.getChangeControl(projectId),
    select: (res) => res.data,
    enabled: !!projectId,
    retry: retryUnlessClientError,
  });
}

export function useSetChangeControl(projectId: string) {
  const { flowApprovals } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ChangeControlSettingsInput) => flowApprovals.setChangeControl(projectId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: flowApprovalKeys.control(projectId) });
      void queryClient.invalidateQueries({ queryKey: projectKeys.all });
    },
  });
}

// ── Baselines ───────────────────────────────────────────────────────────────

export function useBaselines(projectId: string) {
  const { flowApprovals } = useAppApi();
  return useQuery({
    queryKey: flowApprovalKeys.baselines(projectId),
    queryFn: async () => (await flowApprovals.listBaselines({ projectId, limit: 100 })).data,
    enabled: !!projectId,
    retry: retryUnlessClientError,
  });
}

/** The variance of a baseline version (the latest by default) against the live plan. A project with no baseline answers 404: `data` stays undefined. */
export function useBaselineComparison(query: CompareBaselinesQuery, enabled = true) {
  const { flowApprovals } = useAppApi();
  return useQuery({
    queryKey: flowApprovalKeys.compare(query),
    queryFn: () => flowApprovals.compareBaselines(query),
    select: (res) => res.data,
    enabled: enabled && !!(query.projectId || query.from),
    retry: retryUnlessClientError,
  });
}

export function useSignOffBaseline(projectId: string) {
  const { flowApprovals } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => flowApprovals.signOffBaseline(projectId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: flowApprovalKeys.all });
      void queryClient.invalidateQueries({ queryKey: projectKeys.all });
    },
  });
}

// ── Risk acceptance ─────────────────────────────────────────────────────────

export function useRequestRiskAcceptance() {
  const { flowApprovals } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: RequestRiskAcceptanceInput & { id: string }) => flowApprovals.requestRiskAcceptance(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: flowApprovalKeys.all });
      void queryClient.invalidateQueries({ queryKey: raidKeys.all });
    },
  });
}
