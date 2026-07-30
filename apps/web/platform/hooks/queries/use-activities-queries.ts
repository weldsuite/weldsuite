import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTopic } from '@weldsuite/realtime/react';
import { useAppApiClient } from '@/lib/api/use-app-api';

;
interface ListResponse<T> {
  data: T[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}
export const activityKeys = {
  all: ['crm', 'activities'] as const,
  lists: () => [...activityKeys.all, 'list'] as const,
  list: (filters?: Record<string, unknown>) => [...activityKeys.lists(), filters] as const,
  details: () => [...activityKeys.all, 'detail'] as const,
  detail: (id: string) => [...activityKeys.details(), id] as const,
  upcoming: (filters?: Record<string, unknown>) => [...activityKeys.all, 'upcoming', filters] as const,
  overdue: (filters?: Record<string, unknown>) => [...activityKeys.all, 'overdue', filters] as const,
  byType: (type: string, filters?: Record<string, unknown>) =>
    [...activityKeys.all, 'byType', type, filters] as const,
  stats: (filters?: Record<string, unknown>) => [...activityKeys.all, 'stats', filters] as const,
  timeline: (filters?: Record<string, unknown>) =>
    [...activityKeys.all, 'timeline', filters] as const,
  calendar: (params?: Record<string, unknown>) =>
    [...activityKeys.all, 'calendar', params] as const,
  search: (query: string) => [...activityKeys.all, 'search', query] as const,
};

function buildQuery(filters: Record<string, unknown> | undefined): string {
  if (!filters) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const q = params.toString();
  return q ? `?${q}` : '';
}
type ActivityRealtimePayload = { id: string; type?: string };

function useActivityLiveSync(): void {
  const qc = useQueryClient();
  const handler = useCallback(
    (event: { event: string; data: ActivityRealtimePayload }) => {
      const id = event.data?.id;
      qc.invalidateQueries({ queryKey: activityKeys.all });
      if (event.event === 'deleted' && id) {
        qc.removeQueries({ queryKey: activityKeys.detail(id) });
      }
    },
    [qc],
  );
  useTopic<ActivityRealtimePayload>('activity', handler);
}

export function useActivities(filters?: {
  contactId?: string;
  opportunityId?: string;
  companyId?: string;
  customerId?: string;
  leadId?: string;
  assignedTo?: string;
  assignedToId?: string;
  type?: string;
  status?: string;
  priority?: string;
  search?: string;
  limit?: number;
  cursor?: string;
}) {
  const { getClient } = useAppApiClient();
  useActivityLiveSync();
  const wireFilters: Record<string, unknown> | undefined = filters
    ? {
        ...filters,
        customerId: filters.customerId ?? filters.companyId,
        assignedToId: filters.assignedToId ?? filters.assignedTo,
      }
    : undefined;
  if (wireFilters) {
    delete wireFilters.companyId;
    delete wireFilters.assignedTo;
  }
  return useQuery({
    queryKey: activityKeys.list(wireFilters),
    queryFn: async () => {
      const client = await getClient();
      return client.get<ListResponse<unknown>>(`/activities${buildQuery(wireFilters)}`);
    },
  });
}