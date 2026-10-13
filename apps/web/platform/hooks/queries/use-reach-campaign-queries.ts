/**
 * WeldReach campaign hooks: the list, one campaign with its steps and
 * mailboxes, enrollments, previews and per-step stats.
 *
 * Keys live under the `['reach', …]` prefix shared by every WeldReach hook.
 */

import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type { ListResponse } from '@weldsuite/app-api-client/types';
import type {
  AddReachCampaignProspectsInput,
  CreateReachCampaignInput,
  ReachCampaign,
  ReachCampaignDetail,
  ReachCampaignStatus,
  ReachEnrollment,
  ReachEnrollmentStatus,
  ReachStepInput,
  UpdateReachCampaignInput,
} from '@weldsuite/app-api-client/schemas/reach';

const PAGE_SIZE = 50;

export const reachCampaignKeys = {
  all: ['reach', 'campaigns'] as const,
  lists: () => [...reachCampaignKeys.all, 'list'] as const,
  list: (status: ReachCampaignStatus | undefined) =>
    [...reachCampaignKeys.lists(), status ?? 'all'] as const,
  detail: (id: string) => [...reachCampaignKeys.all, 'detail', id] as const,
  enrollments: (id: string) => [...reachCampaignKeys.all, 'enrollments', id] as const,
  enrollmentList: (id: string, status: ReachEnrollmentStatus | undefined) =>
    [...reachCampaignKeys.enrollments(id), status ?? 'all'] as const,
  stats: (id: string) => [...reachCampaignKeys.all, 'stats', id] as const,
  preview: (id: string, subject: string, body: string, prospectId: string | undefined) =>
    [...reachCampaignKeys.all, 'preview', id, subject, body, prospectId ?? 'sample'] as const,
};

function flattenPages<T>(pages: Array<ListResponse<T>> | undefined): T[] {
  return pages?.flatMap((page) => page.data) ?? [];
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

/** Campaigns, newest activity first, following cursor pages as the list scrolls. */
export function useReachCampaigns(status?: ReachCampaignStatus) {
  const { reach } = useAppApi();

  const query = useInfiniteQuery({
    queryKey: reachCampaignKeys.list(status),
    queryFn: ({ pageParam }) =>
      reach.listCampaigns({ status, cursor: pageParam, limit: PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.pagination.hasMore ? (last.pagination.cursor ?? undefined) : undefined),
    // Switching the status filter keeps the list (and its toolbar) on screen while the next one loads.
    placeholderData: keepPreviousData,
  });

  return {
    ...query,
    campaigns: flattenPages<ReachCampaign>(query.data?.pages),
  };
}

export function useReachCampaign(id: string | undefined) {
  const { reach } = useAppApi();

  return useQuery({
    queryKey: reachCampaignKeys.detail(id ?? ''),
    queryFn: () => reach.getCampaign(id as string),
    select: (res) => res.data,
    enabled: Boolean(id),
  });
}

export function useCreateReachCampaign() {
  const { reach } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateReachCampaignInput) => reach.createCampaign(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: reachCampaignKeys.lists() });
    },
  });
}

/** Writes a fresh campaign detail into the cache and refreshes what depends on it. */
function useApplyCampaign() {
  const qc = useQueryClient();
  return (id: string, campaign: ReachCampaignDetail) => {
    qc.setQueryData(reachCampaignKeys.detail(id), { data: campaign });
    void qc.invalidateQueries({ queryKey: reachCampaignKeys.lists() });
  };
}

export function useUpdateReachCampaign(id: string) {
  const { reach } = useAppApi();
  const apply = useApplyCampaign();

  return useMutation({
    mutationFn: (input: UpdateReachCampaignInput) => reach.updateCampaign(id, input),
    onSuccess: (res) => apply(id, res.data),
  });
}

export function useDeleteReachCampaign() {
  const { reach } = useAppApi();
  const qc = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: (id) => reach.deleteCampaign(id),
    onSuccess: (_result, id) => {
      qc.removeQueries({ queryKey: reachCampaignKeys.detail(id) });
      void qc.invalidateQueries({ queryKey: reachCampaignKeys.lists() });
    },
  });
}

/** Replaces every step. The API refuses it with a 409 while the campaign is active. */
export function useReplaceReachSteps(id: string) {
  const { reach } = useAppApi();
  const apply = useApplyCampaign();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (steps: ReachStepInput[]) => reach.replaceSteps(id, steps),
    onSuccess: (res) => {
      apply(id, res.data);
      void qc.invalidateQueries({ queryKey: reachCampaignKeys.stats(id) });
    },
  });
}

export function useSetReachCampaignMailboxes(id: string) {
  const { reach } = useAppApi();
  const apply = useApplyCampaign();

  return useMutation({
    mutationFn: (mailboxIds: string[]) => reach.setMailboxes(id, mailboxIds),
    onSuccess: (res) => apply(id, res.data),
  });
}

/** Launch, pause and resume share their cache effects. */
function useCampaignTransition(id: string, kind: 'launch' | 'pause' | 'resume') {
  const { reach } = useAppApi();
  const apply = useApplyCampaign();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: () => reach[kind](id),
    onSuccess: (res) => {
      apply(id, res.data);
      void qc.invalidateQueries({ queryKey: reachCampaignKeys.enrollments(id) });
    },
  });
}

export const useLaunchReachCampaign = (id: string) => useCampaignTransition(id, 'launch');
export const usePauseReachCampaign = (id: string) => useCampaignTransition(id, 'pause');
export const useResumeReachCampaign = (id: string) => useCampaignTransition(id, 'resume');

// ---------------------------------------------------------------------------
// Enrollments (the prospects of a campaign)
// ---------------------------------------------------------------------------

export function useReachEnrollments(campaignId: string, status?: ReachEnrollmentStatus) {
  const { reach } = useAppApi();

  const query = useInfiniteQuery({
    queryKey: reachCampaignKeys.enrollmentList(campaignId, status),
    queryFn: ({ pageParam }) =>
      reach.listEnrollments(campaignId, { status, cursor: pageParam, limit: PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.pagination.hasMore ? (last.pagination.cursor ?? undefined) : undefined),
    placeholderData: keepPreviousData,
  });

  return {
    ...query,
    enrollments: flattenPages<ReachEnrollment>(query.data?.pages),
    totalCount: query.data?.pages[0]?.pagination.totalCount ?? 0,
  };
}

export function useAddReachCampaignProspects(campaignId: string) {
  const { reach } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: AddReachCampaignProspectsInput) => reach.addProspects(campaignId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: reachCampaignKeys.enrollments(campaignId) });
      void qc.invalidateQueries({ queryKey: reachCampaignKeys.detail(campaignId) });
      void qc.invalidateQueries({ queryKey: reachCampaignKeys.lists() });
      void qc.invalidateQueries({ queryKey: reachCampaignKeys.stats(campaignId) });
    },
  });
}

export function useRemoveReachEnrollment(campaignId: string) {
  const { reach } = useAppApi();
  const qc = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: (enrollmentId) => reach.removeEnrollment(campaignId, enrollmentId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: reachCampaignKeys.enrollments(campaignId) });
      void qc.invalidateQueries({ queryKey: reachCampaignKeys.detail(campaignId) });
      void qc.invalidateQueries({ queryKey: reachCampaignKeys.lists() });
    },
  });
}

// ---------------------------------------------------------------------------
// Preview and stats
// ---------------------------------------------------------------------------

/**
 * Renders unsaved step text for one prospect (or a sample one). Callers
 * debounce `subject` and `body`; the previous preview stays up while the next loads.
 */
export function useReachStepPreview(
  campaignId: string,
  input: { subject: string; body: string; prospectId?: string },
) {
  const { reach } = useAppApi();

  return useQuery({
    queryKey: reachCampaignKeys.preview(campaignId, input.subject, input.body, input.prospectId),
    queryFn: () =>
      reach.preview(campaignId, {
        subject: input.subject,
        body: input.body,
        prospectId: input.prospectId,
      }),
    select: (res) => res.data,
    enabled: input.subject.trim() !== '' || input.body.trim() !== '',
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  });
}

export function useReachStepStats(campaignId: string) {
  const { reach } = useAppApi();

  return useQuery({
    queryKey: reachCampaignKeys.stats(campaignId),
    queryFn: () => reach.stepStats(campaignId),
    select: (res) => res.data,
  });
}
