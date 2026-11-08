/**
 * WeldDesk linked tickets (desk-api `/api/desk/conversations/:id/*`): the
 * parent and children of a conversation, major incidents with an update to
 * every linked customer, and merging duplicates. The rules live in
 * `@weldsuite/db/lib/desk-links`; a refusal answers 409 with `details.reason`.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '@weldsuite/api-client';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { deskKeys, type DeskConversation, type DeskConversationState, type DeskChannel, type DeskMessage } from './use-desk-queries';

/** A linked conversation as the details panel lists it. */
export interface DeskLinkSummary {
  id: string;
  conversationNumber: number;
  title: string | null;
  state: DeskConversationState;
  channel: DeskChannel;
  name: string | null;
  email: string | null;
  assigneeId: string | null;
  isMajorIncident: boolean;
}

export interface DeskConversationLinks {
  parent: DeskLinkSummary | null;
  children: DeskLinkSummary[];
  mergedInto: DeskLinkSummary | null;
  mergedFrom: DeskLinkSummary[];
}

export const deskLinkKeys = {
  all: [...deskKeys.all, 'links'] as const,
  forConversation: (id: string) => [...deskLinkKeys.all, id] as const,
  search: (q: string) => [...deskLinkKeys.all, 'search', q] as const,
};

/** Why the server refused a link change (`details.reason`), or null. */
export function deskLinkRefusal(err: unknown): string | null {
  if (!isApiError(err) || err.status !== 409) return null;
  const body = err.body as { error?: { details?: { reason?: unknown } } } | undefined;
  const reason = body?.error?.details?.reason;
  return typeof reason === 'string' ? reason : 'conflict';
}

/** The server's message for a refusal, when it sent one. */
export function deskLinkErrorMessage(err: unknown): string | null {
  if (!isApiError(err)) return null;
  const body = err.body as { error?: { message?: unknown } } | undefined;
  return typeof body?.error?.message === 'string' ? body.error.message : null;
}

export function useDeskConversationLinks(id: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: deskLinkKeys.forConversation(id),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: DeskConversationLinks }>(`/desk/conversations/${id}/links`);
      return res.data;
    },
    enabled: !!id,
  });
}

/** Conversations to link to or merge into: the inbox search, a page of them. */
export function useDeskConversationSearch(q: string, enabled = true) {
  const { getClient } = useAppApiClient();
  const term = q.trim();
  return useQuery({
    queryKey: deskLinkKeys.search(term),
    queryFn: async () => {
      const client = await getClient();
      const params = new URLSearchParams({ limit: '20' });
      if (term) params.set('q', term);
      const res = await client.get<{ data: DeskConversation[] }>(`/desk/conversations?${params.toString()}`);
      return res.data;
    },
    enabled,
    staleTime: 10_000,
  });
}

type LinkChange = { data: { conversation: DeskConversation; messages: DeskMessage[] } };

/** Every query a link change can move: the threads, their links and the inbox lists. */
function useRefreshAfterLinkChange() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: deskLinkKeys.all });
    void qc.invalidateQueries({ queryKey: deskKeys.conversations() });
  };
}

export function useSetDeskConversationParent() {
  const { getClient } = useAppApiClient();
  const refresh = useRefreshAfterLinkChange();
  return useMutation({
    mutationFn: async ({ id, parentId }: { id: string; parentId: string | null }) => {
      const client = await getClient();
      return client.put<LinkChange>(`/desk/conversations/${id}/parent`, { parentId });
    },
    onSuccess: refresh,
  });
}

export function useSetDeskMajorIncident() {
  const { getClient } = useAppApiClient();
  const refresh = useRefreshAfterLinkChange();
  return useMutation({
    mutationFn: async ({ id, isMajorIncident }: { id: string; isMajorIncident: boolean }) => {
      const client = await getClient();
      return client.put<LinkChange>(`/desk/conversations/${id}/major-incident`, { isMajorIncident });
    },
    onSuccess: refresh,
  });
}

export function useMergeDeskConversation() {
  const { getClient } = useAppApiClient();
  const refresh = useRefreshAfterLinkChange();
  return useMutation({
    mutationFn: async ({ id, targetId }: { id: string; targetId: string }) => {
      const client = await getClient();
      return client.post<LinkChange & { data: { target: DeskConversation } }>(`/desk/conversations/${id}/merge`, {
        targetId,
      });
    },
    onSuccess: refresh,
  });
}

export function usePostDeskIncidentUpdate() {
  const { getClient } = useAppApiClient();
  const refresh = useRefreshAfterLinkChange();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: string }) => {
      const client = await getClient();
      return client.post<{ data: { conversation: DeskConversation; message: DeskMessage; delivered: number } }>(
        `/desk/conversations/${id}/incident-update`,
        { body },
      );
    },
    onSuccess: refresh,
  });
}

/** Close a major incident, and its open linked tickets with it when asked. */
export function useCloseDeskIncident() {
  const { getClient } = useAppApiClient();
  const refresh = useRefreshAfterLinkChange();
  return useMutation({
    mutationFn: async ({ id, closeChildren }: { id: string; closeChildren: boolean }) => {
      const client = await getClient();
      return client.post<{ data: { conversation: DeskConversation; message: DeskMessage } }>(
        `/desk/conversations/${id}/manage`,
        { action: 'close', closeChildren },
      );
    },
    onSuccess: refresh,
  });
}
