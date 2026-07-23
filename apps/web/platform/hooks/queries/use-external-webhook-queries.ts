import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

// =============================================================================
// Query Keys
// =============================================================================

const externalWebhookKeys = {
  all: ['external-webhooks'] as const,
  events: () => [...externalWebhookKeys.all, 'events'] as const,
  list: (filters?: ExternalWebhookFilters) => [...externalWebhookKeys.all, 'list', filters] as const,
  detail: (id: string) => [...externalWebhookKeys.all, 'detail', id] as const,
  deliveries: (id: string, filters?: DeliveriesFilters) =>
    [...externalWebhookKeys.all, 'deliveries', id, filters] as const,
};

// =============================================================================
// Types
// =============================================================================

export type ExternalWebhookStatus = 'active' | 'paused' | 'disabled';
export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'retrying';

export interface ExternalWebhook {
  id: string;
  name: string;
  description: string | null;
  url: string;
  events: string[];
  headers: Record<string, string> | null;
  status: ExternalWebhookStatus;
  consecutiveFailures: number | null;
  lastFailedAt: string | null;
  lastFailureReason: string | null;
  lastDeliveredAt: string | null;
  totalDeliveries: number | null;
  totalFailures: number | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalWebhookWithSecret extends ExternalWebhook {
  secret: string;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventType: string;
  eventId: string;
  payload: Record<string, unknown>;
  status: WebhookDeliveryStatus;
  responseStatus: number | null;
  responseBody: string | null;
  responseTimeMs: number | null;
  attemptNumber: number;
  nextRetryAt: string | null;
  maxRetries: number | null;
  errorMessage: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface CatalogEvent {
  event: string;
  entity: string;
  action: string;
}

export interface ExternalWebhookFilters {
  status?: ExternalWebhookStatus;
  cursor?: string;
  limit?: number;
}

export interface DeliveriesFilters {
  cursor?: string;
  limit?: number;
}

interface Pagination {
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

interface ListResponse<T> {
  data: T[];
  pagination: Pagination;
}

export interface CreateWebhookInput {
  name: string;
  description?: string;
  url: string;
  events: string[];
  headers?: Record<string, string>;
}

export type UpdateWebhookInput = Partial<CreateWebhookInput> & { status?: ExternalWebhookStatus };

// =============================================================================
// Queries
// =============================================================================

export function useExternalWebhookEvents() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: externalWebhookKeys.events(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: CatalogEvent[] }>('/external-webhooks/events');
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useExternalWebhooks(filters?: ExternalWebhookFilters) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: externalWebhookKeys.list(filters),
    queryFn: async () => {
      const client = await getClient();
      const params = new URLSearchParams();
      if (filters?.status) params.set('status', filters.status);
      if (filters?.cursor) params.set('cursor', filters.cursor);
      if (filters?.limit) params.set('limit', String(filters.limit));
      const qs = params.toString();
      return client.get<ListResponse<ExternalWebhook>>(`/external-webhooks${qs ? `?${qs}` : ''}`);
    },
  });
}

export function useExternalWebhookDeliveries(webhookId: string, filters?: DeliveriesFilters) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: externalWebhookKeys.deliveries(webhookId, filters),
    queryFn: async () => {
      const client = await getClient();
      const params = new URLSearchParams();
      if (filters?.cursor) params.set('cursor', filters.cursor);
      if (filters?.limit) params.set('limit', String(filters.limit));
      const qs = params.toString();
      return client.get<ListResponse<WebhookDelivery>>(
        `/external-webhooks/${webhookId}/deliveries${qs ? `?${qs}` : ''}`,
      );
    },
    enabled: !!webhookId,
  });
}

// =============================================================================
// Mutations
// =============================================================================

export function useCreateExternalWebhook() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateWebhookInput) => {
      const client = await getClient();
      return client.post<{ data: ExternalWebhookWithSecret }>('/external-webhooks', input);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: externalWebhookKeys.list() });
    },
  });
}

export function useUpdateExternalWebhook() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateWebhookInput }) => {
      const client = await getClient();
      return client.patch<{ data: ExternalWebhook }>(`/external-webhooks/${id}`, data);
    },
    onSuccess: (_result, { id }) => {
      qc.invalidateQueries({ queryKey: externalWebhookKeys.list() });
      qc.invalidateQueries({ queryKey: externalWebhookKeys.detail(id) });
    },
  });
}

export function useDeleteExternalWebhook() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<void>(`/external-webhooks/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: externalWebhookKeys.list() });
    },
  });
}

export function useRotateExternalWebhookSecret() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.post<{ data: ExternalWebhookWithSecret }>(`/external-webhooks/${id}/rotate-secret`, {});
    },
    onSuccess: (_result, id) => {
      qc.invalidateQueries({ queryKey: externalWebhookKeys.detail(id) });
    },
  });
}

export function useSendTestWebhook() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.post<{
        data: { delivered: boolean; responseStatus: number | null; responseBody: string | null; errorMessage: string | null };
      }>(`/external-webhooks/${id}/test`, {});
    },
  });
}
