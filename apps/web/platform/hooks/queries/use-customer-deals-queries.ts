
import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTopic } from '@weldsuite/realtime/react';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { companyKeys } from '@/components/objects/company/use-company-data';
import { opportunityKeys } from './use-opportunities-queries';

const customerDealKeys = {
  all: ['crm', 'customer-deals'] as const,
  list: (customerId: string) => [...customerDealKeys.all, customerId] as const,
  personList: (personId: string) => [...customerDealKeys.all, 'person', personId] as const,
};

function useCustomerDealLiveSync(): void {
  const qc = useQueryClient();
  const handler = useCallback(
    (_event: { event: string; data: { id: string } }) => {
      qc.invalidateQueries({ queryKey: customerDealKeys.all });
    },
    [qc],
  );
  useTopic<{ id: string }>('opportunity', handler);
}

export function useCustomerDeals(customerId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  useCustomerDealLiveSync();
  return useQuery({
    queryKey: customerDealKeys.list(customerId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any[]; pagination?: { totalCount: number; hasMore: boolean; cursor: string | null } }>(
        `/opportunities?customerId=${encodeURIComponent(customerId)}`,
      );
    },
    enabled: !!customerId && enabled,
  });
}

/**
 * List deals linked to a Person via the `personIds` JSONB array on
 * opportunities. Backed by a `personId` filter on the `/opportunities`
 * route which OR's against `contactIds` for migration overlap.
 */
export function usePersonDeals(personId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  useCustomerDealLiveSync();
  return useQuery({
    queryKey: customerDealKeys.personList(personId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any[]; pagination?: { totalCount: number; hasMore: boolean; cursor: string | null } }>(
        `/opportunities?personId=${encodeURIComponent(personId)}`,
      );
    },
    enabled: !!personId && enabled,
  });
}

interface DealFormData {
  name: string;
  amount?: number | string;
  currency?: string;
  stage?: string;
  stageId?: string;
  status?: string;
  probability?: number;
  closeDate?: string;
  ownerId?: string;
  pipeline?: string;
  description?: string;
  type?: string;
  leadSource?: string;
  nextStep?: string;
}

function useCreateCustomerDeal() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ customerId, data }: { customerId: string; data: DealFormData }) => {
      const client = await getClient();
      const res = await client.post<{ data: { id: string } }>('/opportunities', {
        ...data,
        customerId,
      });
      return res.data;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: companyKeys.detail(variables.customerId) });
      qc.invalidateQueries({ queryKey: opportunityKeys.all });
    },
  });
}

function useUpdateCustomerDeal() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      dealId,
      data,
    }: {
      dealId: string;
      customerId: string;
      data: Partial<DealFormData>;
    }) => {
      const client = await getClient();
      const res = await client.patch<{ data: { id: string } }>(`/opportunities/${dealId}`, data);
      return res.data;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: companyKeys.detail(variables.customerId) });
      qc.invalidateQueries({ queryKey: opportunityKeys.all });
      qc.invalidateQueries({ queryKey: opportunityKeys.detail(variables.dealId) });
    },
  });
}

function useDeleteCustomerDeal() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ dealId }: { dealId: string; customerId: string }) => {
      const client = await getClient();
      await client.delete<void>(`/opportunities/${dealId}`);
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: companyKeys.detail(variables.customerId) });
      qc.invalidateQueries({ queryKey: opportunityKeys.all });
    },
  });
}
