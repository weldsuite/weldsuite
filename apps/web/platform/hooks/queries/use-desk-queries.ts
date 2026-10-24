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
export type DeskEventType = 'closed' | 'reopened' | 'assigned' | 'unassigned' | 'rated';

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
  /** The visitor's CSAT answer (1–5) once they rated the closed conversation. */
  rating?: number | null;
  ratingComment?: string | null;
  ratedAt?: string | null;
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
  metadata: {
    eventType?: DeskEventType;
    assigneeId?: string | null;
    rating?: number;
    ratingComment?: string | null;
    event?: string;
    callId?: string;
    turnIndex?: number;
    role?: string;
    [key: string]: unknown;
  } | null;
  /** Client-only: optimistic send state (absent once the server confirms). */
  pending?: 'sending' | 'failed';
  /** Client-only: correlates an optimistic message with its server copy. */
  clientId?: string;
}

export interface DeskWidgetBranding {
  primaryColor?: string;
  backgroundColor?: string;
  position?: 'right' | 'left';
}

export type DeskWeekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type DeskExpectedReplyTime = 'few_minutes' | 'hour' | 'few_hours' | 'day';

/** Weekly office hours; a missing or null weekday is closed. Times are `HH:MM` in the widget timezone. */
export interface DeskOfficeHours {
  enabled: boolean;
  days: Partial<Record<DeskWeekday, { start: string; end: string } | null>>;
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
  officeHours: DeskOfficeHours | null;
  timezone: string | null;
  awayMessage: string | null;
  expectedReplyTime: DeskExpectedReplyTime | null;
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
  /** Server-side search over customer, subject, number and message text. */
  q?: string;
  /** A customer's conversations: by email, else by widget visitor. */
  email?: string;
  visitorId?: string;
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
  if (filters.q?.trim()) params.set('q', filters.q.trim());
  if (filters.email) params.set('email', filters.email);
  if (filters.visitorId) params.set('visitorId', filters.visitorId);
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

/**
 * The customer's other conversations (any state), for the details panel.
 * Matched by email when known, else by the widget visitor.
 */
export function useDeskCustomerConversations(conversation: DeskConversation | undefined) {
  const { getClient } = useAppApiClient();
  const filters: DeskConversationFilters = conversation?.email
    ? { email: conversation.email }
    : { visitorId: conversation?.visitorId ?? undefined };
  return useQuery({
    queryKey: [...deskKeys.conversations(), 'customer', filters] as const,
    queryFn: async () => {
      const client = await getClient();
      const query = buildConversationQuery(filters, 'newest');
      const res = await client.get<{ data: DeskConversation[]; pagination: DeskListPagination }>(
        `/desk/conversations${query}${query ? '&' : '?'}limit=10`,
      );
      return res.data;
    },
    enabled: Boolean(filters.email || filters.visitorId),
  });
}

/** Upload one file to a conversation; attach the result to the next reply. */
export function useUploadDeskAttachment() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async ({ conversationId, file }: { conversationId: string; file: File }) => {
      const client = await getClient();
      const form = new FormData();
      form.append('file', file);
      const res = await client.postForm<{ data: DeskMessageAttachment }>(
        `/desk/conversations/${conversationId}/attachments`,
        form,
      );
      return res.data;
    },
  });
}

export interface DeskSavedReply {
  id: string;
  name: string;
  content: string;
  shortcut: string | null;
  category: string | null;
}

/** Saved replies the agent may use (active; others' personal ones hidden). */
export function useDeskSavedReplies(search: string, enabled = true) {
  const { getClient } = useAppApiClient();
  const q = search.trim();
  return useQuery({
    queryKey: [...deskKeys.all, 'saved-replies', q] as const,
    queryFn: async () => {
      const client = await getClient();
      const params = new URLSearchParams({ q, limit: '20' });
      const res = await client.get<{ data: DeskSavedReply[] }>(`/canned-responses/search?${params.toString()}`);
      return res.data;
    },
    enabled,
    staleTime: 30_000,
  });
}

/** Render a saved reply with the conversation's variables; counts the use. */
export function useApplyDeskSavedReply() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async ({ id, variables }: { id: string; variables: Record<string, unknown> }) => {
      const client = await getClient();
      const res = await client.post<{ data: { content: string } }>(`/canned-responses/${id}/use`, { variables });
      return res.data.content;
    },
  });
}

export interface DeskReplyInput {
  kind: 'message' | 'note';
  body: string;
  attachments?: DeskMessageAttachment[];
}

type DeskDetailData = { data: DeskConversation & { messages: DeskMessage[] } };

function patchDetailMessages(
  qc: ReturnType<typeof useQueryClient>,
  conversationId: string,
  patch: (messages: DeskMessage[]) => DeskMessage[],
) {
  qc.setQueryData<DeskDetailData>(deskKeys.conversationDetail(conversationId), (old) =>
    old?.data ? { ...old, data: { ...old.data, messages: patch(old.data.messages ?? []) } } : old,
  );
}

/**
 * Send a reply or note. The message shows up in the thread immediately with a
 * `sending` state and is swapped for the server copy on success (or marked
 * `failed` so the agent can retry) — no refetch round-trip.
 */
export function useReplyToDeskConversation() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: DeskReplyInput; authorId?: string; clientId?: string }) => {
      const client = await getClient();
      return client.post<{ data: { conversation: DeskConversation; message: DeskMessage } }>(
        `/desk/conversations/${id}/reply`,
        data,
      );
    },
    onMutate: ({ id, data, authorId, clientId }) => {
      if (!clientId) return;
      const optimistic: DeskMessage = {
        id: clientId,
        clientId,
        createdAt: new Date().toISOString(),
        conversationId: id,
        kind: data.kind,
        body: data.body,
        authorType: 'agent',
        authorId: authorId ?? null,
        attachments: data.attachments ?? null,
        metadata: null,
        pending: 'sending',
      };
      patchDetailMessages(qc, id, (messages) => [
        ...messages.filter((m) => m.clientId !== clientId),
        optimistic,
      ]);
    },
    onSuccess: (result, { id, clientId }) => {
      const { conversation, message } = result.data;
      qc.setQueryData<DeskDetailData>(deskKeys.conversationDetail(id), (old) => {
        if (!old?.data) return old;
        const messages = old.data.messages ?? [];
        const withoutDupes = messages.filter((m) => m.id !== message.id);
        const index = clientId ? withoutDupes.findIndex((m) => m.clientId === clientId) : -1;
        const confirmed: DeskMessage = { ...message, clientId };
        const next =
          index >= 0
            ? withoutDupes.map((m, i) => (i === index ? confirmed : m))
            : [...withoutDupes, confirmed];
        return { ...old, data: { ...old.data, ...conversation, messages: next } };
      });
      qc.invalidateQueries({ queryKey: [...deskKeys.conversations(), 'list'] });
    },
    onError: (_err, { id, clientId }) => {
      if (!clientId) return;
      patchDetailMessages(qc, id, (messages) =>
        messages.map((m) => (m.clientId === clientId ? { ...m, pending: 'failed' as const } : m)),
      );
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
    onSuccess: (result, variables) => {
      const { conversation, message } = result.data;
      qc.setQueryData<DeskDetailData>(deskKeys.conversationDetail(variables.id), (old) => {
        if (!old?.data) return old;
        const messages = (old.data.messages ?? []).filter((m) => m.id !== message.id);
        return { ...old, data: { ...old.data, ...conversation, messages: [...messages, message] } };
      });
      qc.invalidateQueries({ queryKey: [...deskKeys.conversations(), 'list'] });
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
        officeHours?: DeskOfficeHours | null;
        timezone?: string | null;
        awayMessage?: string | null;
        expectedReplyTime?: DeskExpectedReplyTime | null;
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
