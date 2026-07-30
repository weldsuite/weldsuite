import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTopic } from '@weldsuite/realtime/react';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { Lead } from '@/lib/api/domains/weldcrm';

export type { Lead,  } from '@/lib/api/domains/weldcrm';
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