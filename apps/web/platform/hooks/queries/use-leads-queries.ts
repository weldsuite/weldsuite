import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTopic } from '@weldsuite/realtime/react';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { Lead, LeadFilters } from '@/lib/api/domains/weldcrm';

export type { Lead,  } from '@/lib/api/domains/weldcrm';

interface ListResponse<T> {
  data: T[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

interface DetailResponse<T> {
  data: T;
}

const leadKeys = {
  all: ['crm', 'leads'] as const,
  lists: () => [...leadKeys.all, 'list'] as const,
  list: (filters?: Record<string, unknown>) => [...leadKeys.lists(), filters] as const,
  details: () => [...leadKeys.all, 'detail'] as const,
  detail: (id: string) => [...leadKeys.details(), id] as const,
};

function buildQuery(filters: Record<string, unknown> | undefined): string {
  if (!filters) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const q = params.toString();
  return q ? `?${q}` : '';
}

type LeadRealtimePayload = { id: string };

function useLeadLiveSync(): void {
  const qc = useQueryClient();
  const handler = useCallback(
    (event: { event: string; data: LeadRealtimePayload }) => {
      const id = event.data?.id;
      qc.invalidateQueries({ queryKey: leadKeys.all });
      if (event.event === 'deleted' && id) {
        qc.removeQueries({ queryKey: leadKeys.detail(id) });
      }
    },
    [qc],
  );
  useTopic<LeadRealtimePayload>('lead', handler);
}

function useLeads(filters?: LeadFilters) {
  const { getClient } = useAppApiClient();
  useLeadLiveSync();
  return useQuery({
    queryKey: leadKeys.list(filters as Record<string, unknown> | undefined),
    queryFn: async () => {
      const client = await getClient();
      return client.get<ListResponse<Lead>>(`/leads${buildQuery(filters as Record<string, unknown> | undefined)}`);
    },
  });
}

export function useLead(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  useLeadLiveSync();
  return useQuery({
    queryKey: leadKeys.detail(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DetailResponse<Lead>>(`/leads/${id}`);
    },
    enabled: !!id && enabled,
  });
}

function useCreateLead() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Partial<Lead>) => {
      const client = await getClient();
      const res = await client.post<DetailResponse<{ id: string }>>('/leads', data);
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: leadKeys.all });
    },
  });
}

function useUpdateLead() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<Lead> }) => {
      const client = await getClient();
      const res = await client.patch<DetailResponse<{ id: string }>>(`/leads/${id}`, data);
      return res.data;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: leadKeys.all });
      qc.invalidateQueries({ queryKey: leadKeys.detail(variables.id) });
    },
  });
}

function useDeleteLead() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.delete<void>(`/leads/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: leadKeys.all });
    },
  });
}

function useQualifyLead() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.post<DetailResponse<{ id: string }>>(`/leads/${id}/qualify`, {});
    },
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: leadKeys.all });
      qc.invalidateQueries({ queryKey: leadKeys.detail(id) });
    },
  });
}

function useConvertLead() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      options,
    }: {
      id: string;
      options?: { createCustomer?: boolean; createOpportunity?: boolean };
    }) => {
      const client = await getClient();
      const res = await client.post<
        DetailResponse<{ leadId: string; customerId?: string; opportunityId?: string }>
      >(`/leads/${id}/convert`, options || {});
      return res.data;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: leadKeys.all });
      qc.invalidateQueries({ queryKey: leadKeys.detail(variables.id) });
    },
  });
}
