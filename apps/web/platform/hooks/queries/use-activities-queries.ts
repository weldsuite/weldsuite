import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTopic } from '@weldsuite/realtime/react';
import { useAppApiClient } from '@/lib/api/use-app-api';

;

interface ActivityFormData {
  type: 'call' | 'meeting' | 'email' | 'task' | 'note';
  subject: string;
  description?: string;
  contactId?: string;
  companyId?: string;
  customerId?: string;
  opportunityId?: string;
  leadId?: string;
  relatedTo?: string;
  relatedToId?: string;
  relatedToName?: string;
  assignedTo?: string;
  assignedToId?: string;
  status?: 'planned' | 'in_progress' | 'completed' | 'cancelled' | 'deferred';
  priority?: 'low' | 'medium' | 'high';
  dueDate?: string | Date;
  completedAt?: string | Date;
  followUpDate?: string | null;
  outcome?: string;
  customFields?: Record<string, unknown> | unknown;
  metadata?: any;
  createdBy?: string;
  userId?: string;
}

interface ListResponse<T> {
  data: T[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

interface DetailResponse<T> {
  data: T;
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

function toWirePayload(data: Partial<ActivityFormData>): Record<string, unknown> {
  const { companyId, dueDate, completedAt, assignedTo, userId, createdBy, ...rest } = data;
  const out: Record<string, unknown> = { ...rest };
  if (companyId && !rest.customerId) out.customerId = companyId;
  if (dueDate) out.dueDate = dueDate instanceof Date ? dueDate.toISOString() : dueDate;
  if (completedAt) out.completedAt = completedAt instanceof Date ? completedAt.toISOString() : completedAt;
  if (assignedTo && !rest.assignedToId) out.assignedToId = assignedTo;
  return out;
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
      return client.get<ListResponse<any>>(`/activities${buildQuery(wireFilters)}`);
    },
  });
}

function useActivity(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  useActivityLiveSync();
  return useQuery({
    queryKey: activityKeys.detail(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DetailResponse<any>>(`/activities/${id}`);
    },
    enabled: !!id && enabled,
  });
}

function useUpcomingActivities(filters?: { userId?: string; days?: number; limit?: number }) {
  const { getClient } = useAppApiClient();
  useActivityLiveSync();
  const limit = filters?.limit ?? 50;
  return useQuery({
    queryKey: activityKeys.upcoming(filters),
    queryFn: async () => {
      const client = await getClient();
      const params: Record<string, unknown> = { status: 'planned', limit };
      if (filters?.userId) params.assignedToId = filters.userId;
      return client.get<ListResponse<any>>(`/activities${buildQuery(params)}`);
    },
  });
}

function useOverdueActivities(filters?: { userId?: string; limit?: number }) {
  const { getClient } = useAppApiClient();
  useActivityLiveSync();
  const limit = filters?.limit ?? 50;
  return useQuery({
    queryKey: activityKeys.overdue(filters),
    queryFn: async () => {
      const client = await getClient();
      const params: Record<string, unknown> = { status: 'planned', limit };
      if (filters?.userId) params.assignedToId = filters.userId;
      const res = await client.get<ListResponse<any>>(`/activities${buildQuery(params)}`);
      const now = Date.now();
      const overdue = res.data.filter((a) => a.dueDate && new Date(a.dueDate).getTime() < now);
      return {
        ...res,
        data: overdue,
        pagination: { ...res.pagination, totalCount: overdue.length },
      };
    },
  });
}

function useActivitiesByType(
  type: string,
  filters?: { limit?: number; status?: string },
) {
  return useActivities({ type, ...filters });
}

function useActivityStats(filters?: { userId?: string; limit?: number }) {
  const { getClient } = useAppApiClient();
  useActivityLiveSync();
  const limit = filters?.limit ?? 200;
  return useQuery({
    queryKey: activityKeys.stats(filters),
    queryFn: async () => {
      const client = await getClient();
      const params: Record<string, unknown> = { limit };
      if (filters?.userId) params.assignedToId = filters.userId;
      const res = await client.get<ListResponse<any>>(`/activities${buildQuery(params)}`);
      const items = res.data;
      const now = Date.now();
      const byStatus: Record<string, number> = {};
      const byType: Record<string, number> = {};
      let overdue = 0;
      for (const a of items) {
        byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
        byType[a.type] = (byType[a.type] ?? 0) + 1;
        if (a.dueDate && a.status === 'planned' && new Date(a.dueDate).getTime() < now) {
          overdue++;
        }
      }
      return {
        data: {
          total: res.pagination.totalCount,
          loaded: items.length,
          byStatus,
          byType,
          overdue,
        },
      };
    },
  });
}

function useActivitiesTimeline(filters?: {
  entityType?: 'contact' | 'company' | 'opportunity';
  entityId?: string;
  limit?: number;
}) {
  const { getClient } = useAppApiClient();
  useActivityLiveSync();
  return useQuery({
    queryKey: activityKeys.timeline(filters),
    queryFn: async () => {
      const client = await getClient();
      const params: Record<string, unknown> = { limit: filters?.limit ?? 50 };
      if (filters?.entityId && filters.entityType === 'contact') params.contactId = filters.entityId;
      if (filters?.entityId && filters.entityType === 'company') params.customerId = filters.entityId;
      if (filters?.entityId && filters.entityType === 'opportunity')
        params.opportunityId = filters.entityId;
      return client.get<ListResponse<any>>(`/activities${buildQuery(params)}`);
    },
  });
}

function useActivityCalendar(params: {
  userId?: string;
  startDate: string;
  endDate: string;
}) {
  const { getClient } = useAppApiClient();
  useActivityLiveSync();
  return useQuery({
    queryKey: activityKeys.calendar(params),
    queryFn: async () => {
      const client = await getClient();
      const query: Record<string, unknown> = { limit: 200 };
      if (params.userId) query.assignedToId = params.userId;
      const res = await client.get<ListResponse<any>>(`/activities${buildQuery(query)}`);
      const start = new Date(params.startDate).getTime();
      const end = new Date(params.endDate).getTime();
      const inRange = res.data.filter((a) => {
        if (!a.dueDate) return false;
        const t = new Date(a.dueDate).getTime();
        return t >= start && t <= end;
      });
      return { data: inRange };
    },
    enabled: !!params.startDate && !!params.endDate,
  });
}

function useSearchActivities(query: string, enabled = true) {
  const { getClient } = useAppApiClient();
  useActivityLiveSync();
  return useQuery({
    queryKey: activityKeys.search(query),
    queryFn: async () => {
      const client = await getClient();
      return client.get<ListResponse<any>>(
        `/activities${buildQuery({ search: query, limit: 50 })}`,
      );
    },
    enabled: !!query && enabled,
  });
}

function useCreateActivity() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Partial<ActivityFormData>) => {
      const client = await getClient();
      const res = await client.post<DetailResponse<{ id: string }>>(
        '/activities',
        toWirePayload(data),
      );
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: activityKeys.all });
    },
  });
}

function useUpdateActivity() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<ActivityFormData> }) => {
      const client = await getClient();
      const res = await client.patch<DetailResponse<{ id: string }>>(
        `/activities/${id}`,
        toWirePayload(data),
      );
      return res.data;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: activityKeys.all });
      qc.invalidateQueries({ queryKey: activityKeys.detail(variables.id) });
    },
  });
}

function useDeleteActivity() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.delete<void>(`/activities/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: activityKeys.all });
    },
  });
}

function useCompleteActivity() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, outcome }: { id: string; outcome?: string }) => {
      const client = await getClient();
      await client.patch<DetailResponse<{ id: string }>>(`/activities/${id}`, {
        status: 'completed',
        ...(outcome ? { outcome } : {}),
      });
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: activityKeys.all });
      qc.invalidateQueries({ queryKey: activityKeys.detail(variables.id) });
    },
  });
}

function useCancelActivity() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason?: string }) => {
      const client = await getClient();
      await client.patch<DetailResponse<{ id: string }>>(`/activities/${id}`, {
        status: 'cancelled',
        ...(reason ? { outcome: reason } : {}),
      });
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: activityKeys.all });
      qc.invalidateQueries({ queryKey: activityKeys.detail(variables.id) });
    },
  });
}

function useReopenActivity() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.patch<DetailResponse<{ id: string }>>(`/activities/${id}`, {
        status: 'planned',
      });
    },
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: activityKeys.all });
      qc.invalidateQueries({ queryKey: activityKeys.detail(id) });
    },
  });
}

function useAssignActivity() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, userId }: { id: string; userId: string }) => {
      const client = await getClient();
      await client.patch<DetailResponse<{ id: string }>>(`/activities/${id}`, {
        assignedToId: userId,
      });
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: activityKeys.all });
      qc.invalidateQueries({ queryKey: activityKeys.detail(variables.id) });
    },
  });
}

function useUnassignActivity() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.patch<DetailResponse<{ id: string }>>(`/activities/${id}`, {
        assignedToId: null,
      });
    },
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: activityKeys.all });
      qc.invalidateQueries({ queryKey: activityKeys.detail(id) });
    },
  });
}

function useCloneActivity() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data?: Partial<ActivityFormData> }) => {
      const client = await getClient();
      const existing = await client.get<DetailResponse<any>>(`/activities/${id}`);
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = existing.data;
      const res = await client.post<DetailResponse<{ id: string }>>('/activities', {
        ...rest,
        ...(data ? toWirePayload(data) : {}),
      });
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: activityKeys.all });
    },
  });
}

function useSnoozeActivity() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, snoozeUntil }: { id: string; snoozeUntil: string }) => {
      const client = await getClient();
      await client.patch<DetailResponse<{ id: string }>>(`/activities/${id}`, {
        followUpDate: snoozeUntil,
      });
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: activityKeys.all });
      qc.invalidateQueries({ queryKey: activityKeys.detail(variables.id) });
    },
  });
}

function useUnsnoozeActivity() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.patch<DetailResponse<{ id: string }>>(`/activities/${id}`, {
        followUpDate: null,
      });
    },
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: activityKeys.all });
      qc.invalidateQueries({ queryKey: activityKeys.detail(id) });
    },
  });
}

function useBulkUpdateActivities() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      activityIds,
      updates,
    }: {
      activityIds: string[];
      updates: Partial<ActivityFormData>;
    }) => {
      const client = await getClient();
      let succeeded = 0;
      let failed = 0;
      const payload = toWirePayload(updates);
      for (const id of activityIds) {
        try {
          await client.patch(`/activities/${id}`, payload);
          succeeded++;
        } catch {
          failed++;
        }
      }
      return { success: true, succeeded, failed, total: activityIds.length };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: activityKeys.all });
    },
  });
}

function useBulkCompleteActivities() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      activityIds,
      outcome,
    }: {
      activityIds: string[];
      outcome?: string;
    }) => {
      const client = await getClient();
      let succeeded = 0;
      let failed = 0;
      const payload = { status: 'completed', ...(outcome ? { outcome } : {}) };
      for (const id of activityIds) {
        try {
          await client.patch(`/activities/${id}`, payload);
          succeeded++;
        } catch {
          failed++;
        }
      }
      return { success: true, succeeded, failed, total: activityIds.length };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: activityKeys.all });
    },
  });
}
