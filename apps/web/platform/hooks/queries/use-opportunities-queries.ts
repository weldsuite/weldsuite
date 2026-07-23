import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTopic } from '@weldsuite/realtime/react';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { Opportunity, OpportunityFilters } from '@/lib/api/domains/weldcrm';

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
    search.set(k, String(v));
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

function useSearchOpportunities(query: string, enabled = true) {
  return useOpportunities({ search: query, ...(enabled ? {} : {}) } as OpportunityFilters);
}

export function useOpportunityActivities(opportunityId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  useOpportunityLiveSync();
  return useQuery({
    queryKey: opportunityKeys.activities(opportunityId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<ListResponse<any>>(
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
}

function useContactOpportunities(contactId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  useOpportunityLiveSync();
  return useQuery({
    queryKey: opportunityKeys.byContact(contactId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<ListResponse<Opportunity>>(
        `/opportunities?contactId=${encodeURIComponent(contactId)}`,
      );
    },
    enabled: !!contactId && enabled,
  });
}

function useCompanyOpportunities(companyId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  useOpportunityLiveSync();
  return useQuery({
    queryKey: opportunityKeys.byCompany(companyId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<ListResponse<Opportunity>>(
        `/opportunities?customerId=${encodeURIComponent(companyId)}`,
      );
    },
    enabled: !!companyId && enabled,
  });
}

export function useCreateOpportunity() {
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

export function useUpdateOpportunity() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<Opportunity> }) => {
      const client = await getClient();
      const res = await client.patch<DetailResponse<{ id: string }>>(`/opportunities/${id}`, data);
      return res.data;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: opportunityKeys.all });
      qc.invalidateQueries({ queryKey: opportunityKeys.detail(variables.id) });
    },
  });
}

export function useUpdateOpportunityStage() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, stage, stageId }: { id: string; stage: string; stageId?: string }) => {
      const client = await getClient();
      await client.patch<DetailResponse<{ id: string }>>(`/opportunities/${id}`, { stage, stageId });
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: opportunityKeys.all });
      qc.invalidateQueries({ queryKey: opportunityKeys.detail(variables.id) });
    },
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

function useCloneOpportunity() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, overrides }: { id: string; overrides?: Partial<Opportunity> }) => {
      const client = await getClient();
      const existing = await client.get<DetailResponse<Opportunity>>(`/opportunities/${id}`);
      if (!existing?.data) throw new Error('Opportunity not found');
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = existing.data;
      const res = await client.post<DetailResponse<{ id: string }>>('/opportunities', {
        ...rest,
        name: `${rest.name} (Copy)`,
        ...overrides,
      });
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: opportunityKeys.all });
    },
  });
}

function useAddOpportunityActivity() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      opportunityId,
      data,
    }: {
      opportunityId: string;
      data: { type: string; subject: string; description?: string; dueDate?: string };
    }) => {
      const client = await getClient();
      const res = await client.post<DetailResponse<{ id: string }>>('/activities', {
        ...data,
        opportunityId,
      });
      return res.data;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: opportunityKeys.activities(variables.opportunityId) });
      qc.invalidateQueries({ queryKey: ['crm', 'activities'] });
    },
  });
}

function useBulkUpdateOpportunities() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ids, data }: { ids: string[]; data: Partial<Opportunity> }) => {
      const client = await getClient();
      let succeeded = 0;
      let failed = 0;
      for (const id of ids) {
        try {
          await client.patch(`/opportunities/${id}`, data);
          succeeded++;
        } catch {
          failed++;
        }
      }
      return { success: true, succeeded, failed, total: ids.length };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: opportunityKeys.all });
    },
  });
}

function useBulkDeleteOpportunities() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const client = await getClient();
      let succeeded = 0;
      let failed = 0;
      for (const id of ids) {
        try {
          await client.delete(`/opportunities/${id}`);
          succeeded++;
        } catch {
          failed++;
        }
      }
      return { success: true, succeeded, failed, total: ids.length };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: opportunityKeys.all });
    },
  });
}
