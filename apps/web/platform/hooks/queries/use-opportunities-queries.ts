import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useTopic } from '@weldsuite/realtime/react';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { Opportunity, OpportunityFilters } from '@/lib/api/domains/weldcrm';
import { asText } from '@weldsuite/text';

export type { Opportunity, OpportunityFilters } from '@/lib/api/domains/weldcrm';

interface ListResponse<T> {
  data: T[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

interface DetailResponse<T> {
  data: T;
}

export const opportunityKeys = {
  all: ['crm', 'opportunities'] as const,
  lists: () => [...opportunityKeys.all, 'list'] as const,
  list: (filters?: Record<string, unknown>) => [...opportunityKeys.lists(), filters] as const,
  details: () => [...opportunityKeys.all, 'detail'] as const,
  detail: (id: string) => [...opportunityKeys.details(), id] as const,
  /** Mutation key shared by every PATCH that edits a deal (see `useUpdateOpportunity`). */
  update: () => [...opportunityKeys.all, 'update'] as const,
  activities: (id: string) => [...opportunityKeys.all, id, 'activities'] as const,
  byPipeline: (pipelineId: string) =>
    [...opportunityKeys.all, 'pipeline', pipelineId] as const,
  byContact: (contactId: string) =>
    [...opportunityKeys.all, 'contact', contactId] as const,
  byCompany: (companyId: string) =>
    [...opportunityKeys.all, 'company', companyId] as const,
};

function buildQuery(params: Record<string, unknown> | undefined): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    search.set(k, asText(v));
  }
  const q = search.toString();
  return q ? `?${q}` : '';
}

type OpportunityRealtimePayload = { id: string };

function useOpportunityLiveSync(): void {
  const qc = useQueryClient();
  const handler = useCallback(
    (event: { event: string; data: OpportunityRealtimePayload }) => {
      const id = event.data?.id;
      qc.invalidateQueries({ queryKey: opportunityKeys.all });
      if (event.event === 'deleted' && id) {
        qc.removeQueries({ queryKey: opportunityKeys.detail(id) });
      }
    },
    [qc],
  );
  useTopic<OpportunityRealtimePayload>('opportunity', handler);
}

export function useOpportunities(filters?: OpportunityFilters) {
  const { getClient } = useAppApiClient();
  useOpportunityLiveSync();
  return useQuery({
    queryKey: opportunityKeys.list(filters as Record<string, unknown> | undefined),
    queryFn: async () => {
      const client = await getClient();
      return client.get<ListResponse<Opportunity>>(
        `/opportunities${buildQuery(filters as Record<string, unknown> | undefined)}`,
      );
    },
  });
}

export function useOpportunity(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  useOpportunityLiveSync();
  return useQuery({
    queryKey: opportunityKeys.detail(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DetailResponse<Opportunity>>(`/opportunities/${id}`);
    },
    enabled: !!id && enabled,
  });
}
export function useOpportunityActivities(opportunityId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  useOpportunityLiveSync();
  return useQuery({
    queryKey: opportunityKeys.activities(opportunityId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<ListResponse<unknown>>(
        `/activities?type=&opportunityId=${encodeURIComponent(opportunityId)}`,
      );
    },
    enabled: !!opportunityId && enabled,
  });
}

export function useOpportunitiesByPipeline(pipelineId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  useOpportunityLiveSync();
  return useQuery({
    queryKey: opportunityKeys.byPipeline(pipelineId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<ListResponse<Opportunity>>(
        `/opportunities?pipeline=${encodeURIComponent(pipelineId)}&limit=100`,
      );
    },
    enabled: !!pipelineId && enabled,
  });
}export function useCreateOpportunity() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Partial<Opportunity>) => {
      const client = await getClient();
      const res = await client.post<DetailResponse<{ id: string }>>('/opportunities', data);
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: opportunityKeys.all });
    },
  });
}

/**
 * Write a PATCH body into the cached deal so every open view (the deal panel's
 * header and rows) shows the edit straight away instead of waiting for a
 * refetch round-trip. `undefined` fields are skipped, like the server does.
 *
 * Cancelling the in-flight detail GET first matters: it was issued before this
 * edit reached the server, so its (old) response would otherwise land on top of
 * the write and put the previous name back.
 */
async function applyOpportunityPatch(
  qc: QueryClient,
  id: string,
  patch: Partial<Opportunity>,
): Promise<void> {
  const key = opportunityKeys.detail(id);
  await qc.cancelQueries({ queryKey: key });
  qc.setQueryData<DetailResponse<Opportunity>>(key, (cached) => {
    if (!cached?.data) return cached;
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as Partial<Opportunity>;
    return { ...cached, data: { ...cached.data, ...defined } };
  });
}

/**
 * Refetch deals after an edit, but only once the last in-flight edit of this
 * deal has settled. Two quick edits (rename, then change the amount) are two
 * overlapping PATCHes; refetching after the faster one can read the row before
 * the slower one is committed and bring back a half-updated deal (new amount,
 * old name). The last edit to settle refetches the final state.
 */
function refetchWhenLastEditSettles(qc: QueryClient, id: string): void {
  const pending = qc.isMutating({
    mutationKey: opportunityKeys.update(),
    predicate: (mutation) => (mutation.state.variables as { id?: string } | undefined)?.id === id,
  });
  // The settling mutation still counts as pending while its own onSettled runs.
  if (pending > 1) return;
  void qc.invalidateQueries({ queryKey: opportunityKeys.all });
}

export function useUpdateOpportunity() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationKey: opportunityKeys.update(),
    mutationFn: async ({ id, data }: { id: string; data: Partial<Opportunity> }) => {
      const client = await getClient();
      const res = await client.patch<DetailResponse<{ id: string }>>(`/opportunities/${id}`, data);
      return res.data;
    },
    onMutate: ({ id, data }) => applyOpportunityPatch(qc, id, data),
    // Also on error: the refetch replaces the optimistic edit with the server's truth.
    onSettled: (_data, _error, variables) => refetchWhenLastEditSettles(qc, variables.id),
  });
}

export function useUpdateOpportunityStage() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationKey: opportunityKeys.update(),
    mutationFn: async ({ id, stage, stageId }: { id: string; stage: string; stageId?: string }) => {
      const client = await getClient();
      await client.patch<DetailResponse<{ id: string }>>(`/opportunities/${id}`, { stage, stageId });
    },
    onMutate: ({ id, stage, stageId }) => applyOpportunityPatch(qc, id, { stage, stageId }),
    onSettled: (_data, _error, variables) => refetchWhenLastEditSettles(qc, variables.id),
  });
}

export function useDeleteOpportunity() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.delete<void>(`/opportunities/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: opportunityKeys.all });
    },
  });
}

export function useWinOpportunity() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, closeDate }: { id: string; closeDate?: string }) => {
      const client = await getClient();
      await client.patch<DetailResponse<{ id: string }>>(`/opportunities/${id}`, {
        status: 'won',
        ...(closeDate ? { closeDate } : {}),
      });
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: opportunityKeys.all });
      qc.invalidateQueries({ queryKey: opportunityKeys.detail(variables.id) });
    },
  });
}

export function useLoseOpportunity() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, lostReason }: { id: string; lostReason?: string }) => {
      const client = await getClient();
      await client.patch<DetailResponse<{ id: string }>>(`/opportunities/${id}`, {
        status: 'lost',
        ...(lostReason ? { lostReason } : {}),
      });
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: opportunityKeys.all });
      qc.invalidateQueries({ queryKey: opportunityKeys.detail(variables.id) });
    },
  });
}