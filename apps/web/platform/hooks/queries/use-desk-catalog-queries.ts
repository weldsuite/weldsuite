/**
 * WeldDesk service catalogue (desk-api).
 *
 * - `/api/desk/catalog`: the items (settings) and the pending approvals.
 * - `/api/desk/conversations/:id/{request,catalog-item,approval}`: the service
 *   request a conversation is, making it one, deciding its steps.
 *
 * The rules live in `@weldsuite/db/lib/desk-catalog`; a refusal answers 409
 * with `details.reason`, a field problem 400 with `details.field`.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '@weldsuite/api-client';
import type {
  CreateDeskCatalogItemInput,
  DeskApprovalDecision,
  DeskCatalogItem,
  DeskConversationRequest,
  DeskPendingApproval,
  UpdateDeskCatalogItemInput,
} from '@weldsuite/core-api-client/schemas/desk-catalog';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { deskKeys } from './use-desk-queries';
import { ticketTaskKeys } from './use-ticket-tasks-queries';

export type {
  CreateDeskCatalogItemInput,
  DeskApprovalDecision,
  DeskCatalogItem,
  DeskConversationRequest,
  DeskPendingApproval,
  UpdateDeskCatalogItemInput,
};

export type DeskApprovalScope = 'mine' | 'all';

export const deskCatalogKeys = {
  all: ['desk', 'catalog'] as const,
  items: (all: boolean) => [...deskCatalogKeys.all, 'items', all ? 'all' : 'active'] as const,
  approvals: (scope: DeskApprovalScope) => [...deskCatalogKeys.all, 'approvals', scope] as const,
  request: (conversationId: string) => [...deskCatalogKeys.all, 'request', conversationId] as const,
};

/** Why the server refused a request change (`details.reason`), or null. */
export function deskCatalogRefusal(err: unknown): string | null {
  if (!isApiError(err) || err.status !== 409) return null;
  const body = err.body as { error?: { details?: { reason?: unknown } } } | undefined;
  const reason = body?.error?.details?.reason;
  return typeof reason === 'string' ? reason : 'conflict';
}

/** The server's message for a failure, when it sent one (a form problem names its field). */
export function deskCatalogErrorMessage(err: unknown): string | null {
  if (!isApiError(err)) return null;
  const body = err.body as { error?: { message?: unknown } } | undefined;
  return typeof body?.error?.message === 'string' ? body.error.message : null;
}

/** The catalogue in the settings' order. `all` adds switched-off items (needs settings access). */
export function useDeskCatalogItems(opts: { all?: boolean; enabled?: boolean } = {}) {
  const { getClient } = useAppApiClient();
  const all = opts.all === true;
  return useQuery({
    queryKey: deskCatalogKeys.items(all),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: DeskCatalogItem[] }>(`/desk/catalog${all ? '?all=1' : ''}`);
      return res.data ?? [];
    },
    enabled: opts.enabled ?? true,
  });
}

function useRefreshItems() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: [...deskCatalogKeys.all, 'items'] });
}

export function useCreateDeskCatalogItem() {
  const { getClient } = useAppApiClient();
  const refresh = useRefreshItems();
  return useMutation({
    mutationFn: async (data: CreateDeskCatalogItemInput) => {
      const client = await getClient();
      const res = await client.post<{ data: DeskCatalogItem }>('/desk/catalog', data);
      return res.data;
    },
    onSuccess: () => refresh(),
  });
}

export function useUpdateDeskCatalogItem() {
  const { getClient } = useAppApiClient();
  const refresh = useRefreshItems();
  return useMutation({
    mutationFn: async ({ id, ...data }: UpdateDeskCatalogItemInput & { id: string }) => {
      const client = await getClient();
      const res = await client.patch<{ data: DeskCatalogItem }>(`/desk/catalog/${id}`, data);
      return res.data;
    },
    onSuccess: () => refresh(),
  });
}

export function useDeleteDeskCatalogItem() {
  const { getClient } = useAppApiClient();
  const refresh = useRefreshItems();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<void>(`/desk/catalog/${id}`);
    },
    onSuccess: () => refresh(),
  });
}

/** The pending approval steps: the caller's own, or everyone's (needs settings access). */
export function useDeskPendingApprovals(scope: DeskApprovalScope) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: deskCatalogKeys.approvals(scope),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: DeskPendingApproval[] }>(`/desk/catalog/approvals?scope=${scope}`);
      return res.data ?? [];
    },
    refetchInterval: 60_000,
  });
}

/** The service request a conversation is; `null` data when it is not one. */
export function useDeskConversationRequest(conversationId: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: deskCatalogKeys.request(conversationId),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: DeskConversationRequest | null }>(`/desk/conversations/${conversationId}/request`);
      return res.data ?? null;
    },
    enabled: !!conversationId,
  });
}

/** Every query a request change can move: the request, the approvals lists, the threads and the inbox lists. */
function useRefreshAfterRequestChange() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: [...deskCatalogKeys.all, 'request'] });
    void qc.invalidateQueries({ queryKey: [...deskCatalogKeys.all, 'approvals'] });
    void qc.invalidateQueries({ queryKey: deskKeys.conversations() });
    // Fulfilment tasks are created right after the answer.
    void qc.invalidateQueries({ queryKey: ticketTaskKeys.all });
  };
}

export function useAttachDeskCatalogItem() {
  const { getClient } = useAppApiClient();
  const refresh = useRefreshAfterRequestChange();
  return useMutation({
    mutationFn: async ({ conversationId, catalogItemId }: { conversationId: string; catalogItemId: string }) => {
      const client = await getClient();
      return client.put<{ data: { request: DeskConversationRequest } }>(`/desk/conversations/${conversationId}/catalog-item`, {
        catalogItemId,
      });
    },
    onSuccess: refresh,
  });
}

export function useDecideDeskApproval() {
  const { getClient } = useAppApiClient();
  const refresh = useRefreshAfterRequestChange();
  return useMutation({
    mutationFn: async ({
      conversationId,
      decision,
      comment,
    }: {
      conversationId: string;
      decision: DeskApprovalDecision;
      comment?: string;
    }) => {
      const client = await getClient();
      return client.post<{ data: { request: DeskConversationRequest } }>(`/desk/conversations/${conversationId}/approval`, {
        decision,
        ...(comment?.trim() ? { comment: comment.trim() } : {}),
      });
    },
    onSuccess: refresh,
  });
}
