
import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTopic } from '@weldsuite/realtime/react';
import { useAppApiClient } from '@/lib/api/use-app-api';

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
      return client.get<{ data: unknown[]; pagination?: { totalCount: number; hasMore: boolean; cursor: string | null } }>(
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
      return client.get<{ data: unknown[]; pagination?: { totalCount: number; hasMore: boolean; cursor: string | null } }>(
        `/opportunities?personId=${encodeURIComponent(personId)}`,
      );
    },
    enabled: !!personId && enabled,
  });
}