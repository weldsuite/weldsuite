/**
 * WeldDesk webchat query hooks — apps/workers/app-api `/api/desk/*`.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

export type DeskConversationState = 'open' | 'closed';
export type DeskChannel = 'messenger' | 'email' | 'phone' | 'whatsapp' | 'sms' | 'api' | 'portal';
export type DeskConversationSort = 'newest' | 'oldest' | 'waiting_longest' | 'sla_due';
export type DeskMessageKind = 'message' | 'note' | 'event';
export type DeskAuthorType = 'visitor' | 'agent' | 'bot' | 'system';
export type DeskEventType =
  | 'closed'
  | 'reopened'
  | 'assigned'
  | 'unassigned'
  | 'rated'
  | 'attributes_changed'
  | 'sla_warning'
  | 'sla_breached';
export type DeskSlaMetric = 'first_response' | 'next_response' | 'resolution';
/** What the inbox shows for a conversation's SLA clocks; null when no policy applies. */
export type DeskSlaStatus = 'active' | 'warning' | 'breached' | 'paused' | 'achieved';
export type DeskPriority = 'low' | 'medium' | 'high' | 'urgent';
export const DESK_PRIORITIES: DeskPriority[] = ['urgent', 'high', 'medium', 'low'];

/** One ticket field an `attributes_changed` event changed (display values). */
export interface DeskAttributeChange {
  field: 'ticketType' | 'priority' | 'tags' | 'team' | 'customField';
  key?: string;
  label?: string;
  from: unknown;
  to: unknown;
}

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
  /** Ticket fields: the conversation is the ticket. */
  ticketTypeId?: string | null;
  priority?: DeskPriority | null;
  tags?: string[];
  /** The team (helpdesk department). */
  departmentId?: string | null;
  /** The type's custom field values by slug; only on the detail read. */
  customFields?: Record<string, unknown>;
  /** The key an integration, the AI or a workflow opened it with; repeats land here. */
  externalId?: string | null;
  /** SLA summary: the running clock that comes due first (desk_sla_clocks). */
  slaPolicyId?: string | null;
  slaStatus?: DeskSlaStatus | null;
  slaDueAt?: string | null;
  slaMetric?: DeskSlaMetric | null;
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
    changes?: DeskAttributeChange[];
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
  /** Refuse visitors without a valid identity token (needs an identity secret). */
  identityRequired: boolean;
}

/** GET / POST / DELETE /api/desk/widget/:widgetId/identity. A null secret = identity verification is off. */
export interface DeskWidgetIdentity {
  secret: string | null;
  required: boolean;
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
  attributeOptions: () => [...deskKeys.all, 'attribute-options'] as const,
  widget: () => [...deskKeys.all, 'widget'] as const,
  widgetDetail: (widgetId: string) => [...deskKeys.widget(), widgetId] as const,
  /** Outside `widget()` on purpose: invalidating the widget rows must not refetch the secret. */
  widgetIdentity: (widgetId: string) => [...deskKeys.all, 'widget-identity', widgetId] as const,
  assignment: () => [...deskKeys.all, 'assignment'] as const,
};

export type DeskAssignmentMode = 'off' | 'round_robin' | 'balanced';

export interface DeskAssignmentSettings {
  mode: DeskAssignmentMode;
  memberIds: string[];
  awayMemberIds: string[];
  maxOpenPerMember: number | null;
  /** The signed-in teammate's own place in the rotation. */
  me: { inRotation: boolean; away: boolean };
}

export type DeskAssignmentUpdate = Pick<DeskAssignmentSettings, 'mode' | 'memberIds' | 'maxOpenPerMember'>;

/** Auto-assignment rules (`/api/desk/assignment`). */
export function useDeskAssignment() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: deskKeys.assignment(),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: DeskAssignmentSettings }>('/desk/assignment');
      return res.data;
    },
    staleTime: 30_000,
  });
}

export function useUpdateDeskAssignment() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: DeskAssignmentUpdate) => {
      const client = await getClient();
      const res = await client.put<{ data: DeskAssignmentSettings }>('/desk/assignment', data);
      return res.data;
    },
    onSuccess: (settings) => qc.setQueryData(deskKeys.assignment(), settings),
  });
}

/** The signed-in teammate stops (or resumes) taking new conversations. */
export function useSetDeskAway() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (away: boolean) => {
      const client = await getClient();
      const res = await client.post<{ data: DeskAssignmentSettings }>('/desk/assignment/away', { away });
      return res.data;
    },
    onSuccess: (settings) => qc.setQueryData(deskKeys.assignment(), settings),
  });
}

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
  /** A priority, or `none` for conversations without one. */
  priority?: DeskPriority | 'none';
  ticketTypeId?: string;
  departmentId?: string;
  tag?: string;
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
  if (filters.priority) params.set('priority', filters.priority);
  if (filters.ticketTypeId) params.set('ticketTypeId', filters.ticketTypeId);
  if (filters.departmentId) params.set('departmentId', filters.departmentId);
  if (filters.tag) params.set('tag', filters.tag);
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

export interface DeskTicketTypeOption {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
}

/** A ticket custom field; `ticketTypeId` null applies to every type. */
export interface DeskTicketField {
  id: string;
  ticketTypeId: string | null;
  slug: string;
  name: string;
  description: string | null;
  fieldType: string;
  options: { label: string; value: string; color?: string }[] | null;
  required: boolean;
  sortOrder: number;
}

export interface DeskAttributeOptions {
  ticketTypes: DeskTicketTypeOption[];
  teams: Array<{ id: string; name: string }>;
  fields: DeskTicketField[];
  tags: Array<{ tag: string; count: number }>;
}

/** What the details panel can pick: types, their fields, teams, tags in use. */
export function useDeskAttributeOptions() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: deskKeys.attributeOptions(),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: DeskAttributeOptions }>('/desk/conversations/attributes');
      return res.data;
    },
    staleTime: 60_000,
  });
}

export interface DeskAttributesUpdate {
  ticketTypeId?: string | null;
  priority?: DeskPriority | null;
  tags?: string[];
  departmentId?: string | null;
  customFields?: Record<string, unknown>;
}

const ATTRIBUTES_MUTATION = [...deskKeys.all, 'update-attributes'] as const;

function withAttributes<T extends DeskConversation>(conversation: T, data: DeskAttributesUpdate): T {
  const { customFields, ...columns } = data;
  return {
    ...conversation,
    ...columns,
    customFields: customFields ? { ...conversation.customFields, ...customFields } : conversation.customFields,
  };
}

/** Tags the agent just used go to the top of the suggestions without re-reading them. */
function rememberTags(qc: ReturnType<typeof useQueryClient>, tags: string[]) {
  qc.setQueryData<DeskAttributeOptions>(deskKeys.attributeOptions(), (old) => {
    if (!old) return old;
    const known = new Set(old.tags.map((entry) => entry.tag));
    const added = tags.filter((tag) => !known.has(tag)).map((tag) => ({ tag, count: 1 }));
    return added.length ? { ...old, tags: [...added, ...old.tags] } : old;
  });
}

/**
 * Set a conversation's type, priority, tags, team or custom fields. The
 * change shows at once, so the next edit (another option, another tag)
 * builds on it rather than on the value from before this request.
 */
export function useUpdateDeskConversationAttributes() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  const pendingFor = (id: string) =>
    qc.isMutating({
      mutationKey: ATTRIBUTES_MUTATION,
      predicate: (mutation) => (mutation.state.variables as { id?: string } | undefined)?.id === id,
    });
  return useMutation({
    mutationKey: ATTRIBUTES_MUTATION,
    mutationFn: async ({ id, data }: { id: string; data: DeskAttributesUpdate }) => {
      const client = await getClient();
      return client.patch<{ data: { conversation: DeskConversation; message: DeskMessage | null } }>(
        `/desk/conversations/${id}`,
        data,
      );
    },
    onMutate: async ({ id, data }) => {
      await qc.cancelQueries({ queryKey: deskKeys.conversationDetail(id) });
      qc.setQueryData<DeskDetailData>(deskKeys.conversationDetail(id), (old) =>
        old?.data ? { ...old, data: withAttributes(old.data, data) } : old,
      );
    },
    onSuccess: (result, variables) => {
      const { conversation, message } = result.data;
      // A later edit to this conversation is still on its way: keep its
      // values on screen and take only this request's timeline event.
      const newerPending = pendingFor(variables.id) > 1;
      qc.setQueryData<DeskDetailData>(deskKeys.conversationDetail(variables.id), (old) => {
        if (!old?.data) return old;
        const messages = (old.data.messages ?? []).filter((m) => m.id !== message?.id);
        const fields = newerPending ? {} : conversation;
        return { ...old, data: { ...old.data, ...fields, messages: message ? [...messages, message] : messages } };
      });
      qc.invalidateQueries({ queryKey: [...deskKeys.conversations(), 'list'] });
      if (conversation.tags) rememberTags(qc, conversation.tags);
    },
    // The optimistic value is wrong: read the conversation back.
    onError: (_err, variables) => {
      qc.invalidateQueries({ queryKey: deskKeys.conversationDetail(variables.id) });
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
        /** 400 when the widget has no identity secret yet. */
        identityRequired?: boolean;
      };
    }) => {
      const client = await getClient();
      return client.patch<{ data: DeskWidgetSettings }>(`/desk/widget/${widgetId}`, data);
    },
    onSuccess: (result, variables) => {
      qc.invalidateQueries({ queryKey: deskKeys.widget() });
      qc.invalidateQueries({ queryKey: deskKeys.widgetDetail(variables.widgetId) });
      if (variables.data.identityRequired !== undefined) {
        qc.setQueryData<DeskWidgetIdentity>(deskKeys.widgetIdentity(variables.widgetId), (prev) =>
          prev ? { ...prev, required: result.data.identityRequired } : prev,
        );
      }
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

/**
 * The widget's identity secret (settings:manage; 403 otherwise). It is a
 * credential: fetched only while the identity section is open, never
 * persisted to the offline cache, and dropped as soon as nothing shows it.
 */
export function useDeskWidgetIdentity(widgetId: string, enabled: boolean) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: deskKeys.widgetIdentity(widgetId),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: DeskWidgetIdentity }>(`/desk/widget/${widgetId}/identity`);
      return result.data;
    },
    enabled: !!widgetId && enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    meta: { persist: false },
  });
}

/** Set up or rotate the identity secret. Tokens signed with the old one stop working at once. */
export function useRotateDeskWidgetIdentity() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    // Keep the new secret out of the mutation cache once the call settles.
    gcTime: 0,
    mutationFn: async (widgetId: string) => {
      const client = await getClient();
      const result = await client.post<{ data: DeskWidgetIdentity }>(`/desk/widget/${widgetId}/identity`, {});
      return result.data;
    },
    onSuccess: (identity, widgetId) => {
      qc.setQueryData(deskKeys.widgetIdentity(widgetId), identity);
    },
  });
}

/** Turn identity verification off: the secret is deleted and nobody is required to sign in. */
export function useDisableDeskWidgetIdentity() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: async (widgetId: string) => {
      const client = await getClient();
      const result = await client.delete<{ data: DeskWidgetIdentity }>(`/desk/widget/${widgetId}/identity`);
      return result.data;
    },
    onSuccess: (identity, widgetId) => {
      qc.setQueryData(deskKeys.widgetIdentity(widgetId), identity);
      qc.invalidateQueries({ queryKey: deskKeys.widget() });
      qc.invalidateQueries({ queryKey: deskKeys.widgetDetail(widgetId) });
    },
  });
}
