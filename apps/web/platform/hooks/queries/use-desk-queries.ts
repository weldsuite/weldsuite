/**
 * WeldDesk webchat query hooks — apps/workers/app-api `/api/desk/*`.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

export type DeskConversationState = 'open' | 'closed';
export type DeskChannel = 'messenger' | 'email' | 'phone' | 'whatsapp' | 'sms' | 'api';
export type DeskConversationSort = 'newest' | 'oldest' | 'waiting_longest';
export type DeskMessageKind = 'message' | 'note' | 'event';
export type DeskAuthorType = 'visitor' | 'agent' | 'bot' | 'system';
export type DeskEventType = 'closed' | 'reopened' | 'assigned' | 'unassigned';

export interface DeskConversation {
  id: string;
  createdAt: string;
  updatedAt: string;
  conversationNumber: number;
  title: string | null;
  state: DeskConversationState;
  channel: DeskChannel;
  visitorId: string | null;
  name: string | null;
  email: string | null;
  contactId: string | null;
  assigneeId: string | null;
  waitingSince: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
}

export interface DeskMessageAttachment {
  name: string;
  url: string;
  contentType: string;
  filesize: number;
  width?: number;
  height?: number;
}

export interface DeskMessage {
  id: string;
  createdAt: string;
  conversationId: string;
  kind: DeskMessageKind;
  body: string | null;
  authorType: DeskAuthorType;
  authorId: string | null;
  attachments: DeskMessageAttachment[] | null;
  metadata: { eventType?: DeskEventType; assigneeId?: string | null } | null;
}

export interface DeskWidgetBranding {
  primaryColor?: string;
  backgroundColor?: string;
  position?: 'right' | 'left';
}

export interface DeskWidgetSettings {
  id: string;
  createdAt: string;
  updatedAt: string;
  widgetId: string;
  widgetName: string | null;
  enabled: boolean;
  greeting: string | null;
  branding: DeskWidgetBranding | null;
  allowedDomains: string[] | null;
}

export interface DeskListPagination {
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

export const deskKeys = {
  all: ['desk'] as const,
  conversations: () => [...deskKeys.all, 'conversations'] as const,
  conversationList: (filters: DeskConversationFilters, sort?: DeskConversationSort) =>
    [...deskKeys.conversations(), 'list', filters, sort ?? 'newest'] as const,
  conversationDetail: (id: string) => [...deskKeys.conversations(), 'detail', id] as const,
  widget: () => [...deskKeys.all, 'widget'] as const,
  widgetDetail: (widgetId: string) => [...deskKeys.widget(), widgetId] as const,
};

export interface DeskConversationFilters {
  state?: DeskConversationState;
  assigneeId?: string;
  unassigned?: boolean;
  channel?: DeskChannel;
}

function buildConversationQuery(
  filters: DeskConversationFilters,
  sort: DeskConversationSort | undefined,
  cursor?: string,
) {
  const params = new URLSearchParams();
  if (filters.state) params.set('state', filters.state);
  if (filters.assigneeId) params.set('assigneeId', filters.assigneeId);
  if (filters.unassigned) params.set('unassigned', 'true');
  if (filters.channel) params.set('channel', filters.channel);
  if (sort) params.set('sort', sort);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function useDeskConversations(filters: DeskConversationFilters, sort?: DeskConversationSort) {
  const { getClient } = useAppApiClient();
  return useInfiniteQuery({
    queryKey: deskKeys.conversationList(filters, sort),
    queryFn: async ({ pageParam }: { pageParam?: string }) => {
      const client = await getClient();
      const query = buildConversationQuery(filters, sort, pageParam);
      return client.get<{ data: DeskConversation[]; pagination: DeskListPagination }>(
        `/desk/conversations${query}`,
      );
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => (lastPage.pagination.hasMore ? lastPage.pagination.cursor ?? undefined : undefined),
  });
}

export function useDeskConversation(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: deskKeys.conversationDetail(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: DeskConversation & { messages: DeskMessage[] } }>(
        `/desk/conversations/${id}?include=messages`,
      );
    },
    enabled: !!id && enabled,
  });
}

export interface DeskReplyInput {
  kind: 'message' | 'note';
  body: string;
  attachments?: DeskMessageAttachment[];
}

export function useReplyToDeskConversation() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: DeskReplyInput }) => {
      const client = await getClient();
      return client.post<{ data: { conversation: DeskConversation; message: DeskMessage } }>(
        `/desk/conversations/${id}/reply`,
        data,
      );
    },
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: deskKeys.conversationDetail(variables.id) });
      qc.invalidateQueries({ queryKey: deskKeys.conversations() });
    },
  });
}

export type DeskManageAction =
  | { action: 'close' }
  | { action: 'open' }
  | { action: 'assign'; assigneeId?: string | null };

export function useManageDeskConversation() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: DeskManageAction }) => {
      const client = await getClient();
      return client.post<{ data: { conversation: DeskConversation; message: DeskMessage } }>(
        `/desk/conversations/${id}/manage`,
        data,
      );
    },
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: deskKeys.conversationDetail(variables.id) });
      qc.invalidateQueries({ queryKey: deskKeys.conversations() });
    },
  });
}

export function useDeskWidgets() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: deskKeys.widget(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: DeskWidgetSettings[] }>('/desk/widget');
    },
  });
}

export function useDeskWidget(widgetId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: deskKeys.widgetDetail(widgetId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: DeskWidgetSettings }>(`/desk/widget/${widgetId}`);
    },
    enabled: !!widgetId && enabled,
  });
}

export function useCreateDeskWidget() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { widgetName?: string; greeting?: string }) => {
      const client = await getClient();
      return client.post<{ success: boolean; data: DeskWidgetSettings }>('/desk/widget', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: deskKeys.widget() });
    },
  });
}

export function useUpdateDeskWidget() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      widgetId,
      data,
    }: {
      widgetId: string;
      data: {
        widgetName?: string;
        enabled?: boolean;
        greeting?: string | null;
        branding?: DeskWidgetBranding;
        allowedDomains?: string[];
      };
    }) => {
      const client = await getClient();
      return client.patch<{ data: DeskWidgetSettings }>(`/desk/widget/${widgetId}`, data);
    },
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: deskKeys.widget() });
      qc.invalidateQueries({ queryKey: deskKeys.widgetDetail(variables.widgetId) });
    },
  });
}

export function useDeleteDeskWidget() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (widgetId: string) => {
      const client = await getClient();
      return client.delete<{ data: { id: string; widgetId: string } }>(`/desk/widget/${widgetId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: deskKeys.widget() });
    },
  });
}
