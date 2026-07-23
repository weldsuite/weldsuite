/**
 * WeldDesk v2 (Intercom-model) query hooks — apps/workers/app-api `/api/desk/*`.
 *
 * Mirrors the shape of use-knowledge-queries.ts: useAppApiClient() + getClient(),
 * a `deskKeys` factory, one hook per endpoint, mutations invalidate on settle
 * (+ optimistic updates for cheap conversation-row changes).
 *
 * Stage 1 (inbox shell) surface — see .claude/welddesk-intercom-plan.md §6
 * Phase 2. Consumed by apps/web/platform/app/welddesk/inbox2/*. Types mirror
 * packages/core/db/src/schema/desk-*.ts + packages/clients/core-api-client/src/schemas/desk-*.ts;
 * kept local (not imported) so this file doesn't drag server-only Drizzle
 * types into the client bundle — same rationale as use-knowledge-queries.ts.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

// =============================================================================
// Types — mirror packages/core/db/src/schema/desk-*.ts
// =============================================================================

export type DeskConversationState = 'open' | 'snoozed' | 'closed';
export type DeskChannel = 'messenger' | 'email' | 'phone' | 'whatsapp' | 'sms' | 'api';
export type DeskDeliveredAs = 'customer_initiated' | 'admin_initiated' | 'automated' | 'campaign_initiated';
export type DeskConversationSort = 'newest' | 'oldest' | 'waiting_longest' | 'priority_first';
export type DeskTicketCategory = 'customer' | 'back_office' | 'tracker';

export interface DeskConversationSource {
  type: DeskChannel;
  deliveredAs: DeskDeliveredAs;
  subject?: string;
  body?: string;
  authorType: 'user' | 'admin' | 'bot';
  authorId?: string;
  url?: string;
}

export interface DeskConversationStatistics {
  firstContactReplyAt?: string;
  firstAdminReplyAt?: string;
  firstAssignmentAt?: string;
  firstCloseAt?: string;
  lastContactReplyAt?: string;
  lastAdminReplyAt?: string;
  lastAssignmentAt?: string;
  lastCloseAt?: string;
  lastClosedById?: string;
  timeToAssignment?: number;
  timeToAdminReply?: number;
  timeToFirstClose?: number;
  timeToLastClose?: number;
  medianTimeToReply?: number;
  replyTimes?: number[];
  countReopens: number;
  countAssignments: number;
  countParts: number;
  handlingTime?: number;
}

export interface DeskConversationRating {
  rating: number;
  remark?: string;
  createdAt: string;
  teammateId?: string;
}

export interface DeskConversation {
  id: string;
  createdAt: string;
  updatedAt: string;
  conversationNumber: number;
  title: string | null;
  state: DeskConversationState;
  read: boolean;
  priority: boolean;
  waitingSince: string | null;
  snoozedUntil: string | null;
  adminAssigneeId: string | null;
  teamAssigneeId: string | null;
  contactId: string | null;
  counterpartyId: string | null;
  personId: string | null;
  channel: DeskChannel;
  source: DeskConversationSource;
  customAttributes: Record<string, unknown> | null;
  tags: string[] | null;
  conversationRating: DeskConversationRating | null;
  statistics: DeskConversationStatistics | null;
  aiAgentParticipated: boolean;
  ticketTypeId: string | null;
  ticketStateId: string | null;
  ticketCategory: DeskTicketCategory | null;
  ticketNumber: number | null;
  isShared: boolean | null;
}

export type DeskPartType =
  | 'comment'
  | 'note'
  | 'note_and_reopen'
  | 'quick_reply'
  | 'open'
  | 'close'
  | 'snoozed'
  | 'unsnoozed'
  | 'timer_unsnooze'
  | 'assignment'
  | 'assign_and_unsnooze'
  | 'away_mode_assignment'
  | 'default_assignment'
  | 'balanced_assignment'
  | 'participant_added'
  | 'participant_removed'
  | 'conversation_rating_changed'
  | 'conversation_rating_remark_added'
  | 'ticket_state_changed'
  | 'ticket_attribute_updated'
  | 'converted_to_ticket'
  | 'linked_object_added'
  | 'linked_object_removed'
  | 'workflow_started'
  | 'workflow_ended'
  | 'ai_answer'
  | 'ai_handover';

export type DeskPartAuthorType = 'admin' | 'user' | 'bot' | 'team';

export interface DeskPartAttachment {
  name: string;
  url: string;
  contentType: string;
  filesize: number;
  width?: number;
  height?: number;
}

export interface DeskConversationPart {
  id: string;
  createdAt: string;
  updatedAt: string;
  conversationId: string;
  partType: DeskPartType;
  body: string | null;
  blocks: Record<string, unknown>[] | null;
  blockResponses: Record<string, unknown> | null;
  authorType: DeskPartAuthorType;
  authorId: string | null;
  fromAiAgent: boolean;
  isAiAnswer: boolean;
  assignedToType: 'admin' | 'team' | null;
  assignedToId: string | null;
  attachments: DeskPartAttachment[] | null;
  emailMessageId: string | null;
  stateSnapshot: DeskConversationState;
  metadata: Record<string, unknown> | null;
}

export type DeskDistributionMethod = 'manual' | 'round_robin' | 'balanced';

export interface DeskTeam {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  icon: string | null;
  memberIds: string[];
  distributionMethod: DeskDistributionMethod;
  teamLimit: number | null;
  ignoreAwayStatus: boolean;
  officeHours: { timezone: string; hours: Record<string, { start: string; end: string }[]> } | null;
  expectedReplyTime: string | null;
  inboxRank: number;
  archived: boolean;
}

export type DeskTeammateStatus = 'active' | 'away' | 'away_reassign';

export interface DeskTeammateSettings {
  userId: string;
  status: DeskTeammateStatus;
  assignmentLimit: number | null;
  lastAssignedAt: string | null;
  notificationPreferences: Record<string, boolean> | null;
}

export type DeskViewSort = 'newest' | 'oldest' | 'waiting_longest' | 'priority_first' | 'next_sla_target';

export type DeskViewFilterOperator =
  | 'eq'
  | 'ne'
  | 'in'
  | 'nin'
  | 'contains'
  | 'gt'
  | 'lt'
  | 'exists'
  | 'not_exists';

export interface DeskViewFilterCondition {
  field: string;
  operator: DeskViewFilterOperator;
  value?: unknown;
}

export interface DeskViewFilter {
  groups: { conditions: DeskViewFilterCondition[] }[];
}

export interface DeskView {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  icon: string | null;
  folder: string | null;
  filters: DeskViewFilter;
  sort: DeskViewSort;
  shared: boolean;
  ownerId: string;
  order: number;
}

export type DeskMacroAction =
  | { type: 'add_tag'; tag: string }
  | { type: 'remove_tag'; tag: string }
  | { type: 'assign'; assigneeType: 'admin' | 'team'; assigneeId: string }
  | { type: 'close' }
  | { type: 'snooze'; durationMinutes: number }
  | { type: 'mark_priority'; priority: boolean }
  | { type: 'set_attribute'; attributeId: string; value: unknown }
  | { type: 'apply_sla'; slaId: string };

export interface DeskMacro {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  body: string | null;
  insertAs: 'reply' | 'note';
  actions: DeskMacroAction[];
  teamIds: string[] | null;
  createdBy: string | null;
  archived: boolean;
}

export interface DeskListPagination {
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

// =============================================================================
// Query Keys
// =============================================================================

export const deskKeys = {
  all: ['desk'] as const,

  conversations: () => [...deskKeys.all, 'conversations'] as const,
  conversationList: (filters: DeskConversationFilters, sort?: DeskConversationSort) =>
    [...deskKeys.conversations(), 'list', filters, sort ?? 'newest'] as const,
  conversationDetail: (id: string) => [...deskKeys.conversations(), 'detail', id] as const,

  teams: () => [...deskKeys.all, 'teams'] as const,
  views: () => [...deskKeys.all, 'views'] as const,
  macros: () => [...deskKeys.all, 'macros'] as const,
  teammateMe: () => [...deskKeys.all, 'teammates', 'me'] as const,
};

// =============================================================================
// Conversations — list (infinite) + detail
// =============================================================================

export interface DeskConversationFilters {
  state?: DeskConversationState;
  adminAssigneeId?: string;
  /** 'unassigned' is a sentinel meaning teamAssigneeId IS NULL. */
  teamAssigneeId?: string;
  channel?: DeskChannel;
  priority?: boolean;
  tag?: string;
  isTicket?: boolean;
  contactId?: string;
  createdById?: string;
  mentionedUserId?: string;
}

function buildConversationQuery(filters: DeskConversationFilters, sort: DeskConversationSort | undefined, cursor?: string) {
  const params = new URLSearchParams();
  if (filters.state) params.set('state', filters.state);
  if (filters.adminAssigneeId) params.set('adminAssigneeId', filters.adminAssigneeId);
  if (filters.teamAssigneeId) params.set('teamAssigneeId', filters.teamAssigneeId);
  if (filters.channel) params.set('channel', filters.channel);
  if (filters.priority !== undefined) params.set('priority', String(filters.priority));
  if (filters.tag) params.set('tag', filters.tag);
  if (filters.isTicket !== undefined) params.set('isTicket', String(filters.isTicket));
  if (filters.contactId) params.set('contactId', filters.contactId);
  if (filters.createdById) params.set('createdById', filters.createdById);
  if (filters.mentionedUserId) params.set('mentionedUserId', filters.mentionedUserId);
  if (sort) params.set('sort', sort);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Infinite query over `/api/desk/conversations`. `fetchNextPage()` drives the
 * conversation-list sentinel scroll (see conversation-list.tsx).
 */
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
      return client.get<{ data: DeskConversation & { parts: DeskConversationPart[] } }>(
        `/desk/conversations/${id}?include=parts`,
      );
    },
    enabled: !!id && enabled,
  });
}

// =============================================================================
// Conversations — mutations
// =============================================================================

export interface DeskReplyInput {
  messageType: 'comment' | 'note';
  body: string;
  blocks?: Record<string, unknown>[];
  attachments?: {
    name: string;
    url: string;
    contentType: string;
    filesize: number;
    width?: number;
    height?: number;
  }[];
  mentionUserIds?: string[];
}

/** Invalidates the conversation detail (fresh parts timeline) + the list (waiting/preview changed). */
export function useReplyToDeskConversation() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: DeskReplyInput }) => {
      const client = await getClient();
      return client.post<{ data: { conversation: DeskConversation; part: DeskConversationPart } }>(
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
  | { action: 'snooze'; snoozedUntil: string }
  | { action: 'assign'; assigneeType: 'admin' | 'team'; assigneeId?: string | null };

/**
 * Close/open/snooze/assign. Optimistically patches the cached list rows +
 * detail (cheap, single-field state changes) then invalidates on settle so
 * the statistics rollup / waitingSince maintained server-side lands.
 */
export function useManageDeskConversation() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: DeskManageAction }) => {
      const client = await getClient();
      return client.post<{ data: DeskConversation }>(`/desk/conversations/${id}/manage`, data);
    },
    onMutate: async ({ id, data }) => {
      await qc.cancelQueries({ queryKey: deskKeys.conversationDetail(id) });
      const previous = qc.getQueryData(deskKeys.conversationDetail(id));
      qc.setQueryData(deskKeys.conversationDetail(id), (old: unknown) => {
        if (!old || typeof old !== 'object') return old;
        const entry = old as { data: DeskConversation & { parts: DeskConversationPart[] } };
        const patch: Partial<DeskConversation> =
          data.action === 'close'
            ? { state: 'closed' }
            : data.action === 'open'
              ? { state: 'open' }
              : data.action === 'snooze'
                ? { state: 'snoozed', snoozedUntil: data.snoozedUntil }
                : data.action === 'assign'
                  ? data.assigneeType === 'admin'
                    ? { adminAssigneeId: data.assigneeId ?? null }
                    : { teamAssigneeId: data.assigneeId ?? null }
                  : {};
        return { ...entry, data: { ...entry.data, ...patch } };
      });
      return { previous };
    },
    onError: (_err, variables, context) => {
      if (context?.previous !== undefined) {
        qc.setQueryData(deskKeys.conversationDetail(variables.id), context.previous);
      }
    },
    onSettled: (_result, _err, variables) => {
      qc.invalidateQueries({ queryKey: deskKeys.conversationDetail(variables.id) });
      qc.invalidateQueries({ queryKey: deskKeys.conversations() });
    },
  });
}

export function useAddDeskConversationTag() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, tag }: { id: string; tag: string }) => {
      const client = await getClient();
      return client.post<{ data: DeskConversation }>(`/desk/conversations/${id}/tags`, { tag });
    },
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: deskKeys.conversationDetail(variables.id) });
      qc.invalidateQueries({ queryKey: deskKeys.conversations() });
    },
  });
}

export function useRemoveDeskConversationTag() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, tag }: { id: string; tag: string }) => {
      const client = await getClient();
      return client.delete<void>(`/desk/conversations/${id}/tags/${encodeURIComponent(tag)}`);
    },
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: deskKeys.conversationDetail(variables.id) });
      qc.invalidateQueries({ queryKey: deskKeys.conversations() });
    },
  });
}

export interface DeskUpdateAttributesInput {
  title?: string | null;
  priority?: boolean;
  read?: boolean;
  customAttributes?: Record<string, unknown>;
}

/** Optimistic — `read`/`priority` toggles are the hot path (list row checkbox/flag). */
export function useUpdateDeskConversationAttributes() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: DeskUpdateAttributesInput }) => {
      const client = await getClient();
      return client.patch<{ data: DeskConversation }>(`/desk/conversations/${id}/attributes`, data);
    },
    onMutate: async ({ id, data }) => {
      await qc.cancelQueries({ queryKey: deskKeys.conversationDetail(id) });
      const previous = qc.getQueryData(deskKeys.conversationDetail(id));
      qc.setQueryData(deskKeys.conversationDetail(id), (old: unknown) => {
        if (!old || typeof old !== 'object') return old;
        const entry = old as { data: DeskConversation & { parts: DeskConversationPart[] } };
        return { ...entry, data: { ...entry.data, ...data } };
      });
      return { previous };
    },
    onError: (_err, variables, context) => {
      if (context?.previous !== undefined) {
        qc.setQueryData(deskKeys.conversationDetail(variables.id), context.previous);
      }
    },
    onSettled: (_result, _err, variables) => {
      qc.invalidateQueries({ queryKey: deskKeys.conversationDetail(variables.id) });
      qc.invalidateQueries({ queryKey: deskKeys.conversations() });
    },
  });
}

export function useRateDeskConversation() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, rating, remark }: { id: string; rating: number; remark?: string }) => {
      const client = await getClient();
      return client.post<{ data: DeskConversation }>(`/desk/conversations/${id}/rating`, { rating, remark });
    },
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: deskKeys.conversationDetail(variables.id) });
      qc.invalidateQueries({ queryKey: deskKeys.conversations() });
    },
  });
}

export function useApplyDeskMacro() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, macroId }: { id: string; macroId: string }) => {
      const client = await getClient();
      return client.post<{
        data: { conversation: DeskConversation; composerPrefill?: string; skipped: string[] };
      }>(`/desk/conversations/${id}/apply-macro`, { macroId });
    },
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: deskKeys.conversationDetail(variables.id) });
      qc.invalidateQueries({ queryKey: deskKeys.conversations() });
    },
  });
}

// =============================================================================
// Teams
// =============================================================================

export function useDeskTeams(archived = false) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...deskKeys.teams(), { archived }],
    queryFn: async () => {
      const client = await getClient();
      const qs = archived ? '?archived=true' : '';
      return client.get<{ data: DeskTeam[] }>(`/desk/teams${qs}`);
    },
  });
}

export interface CreateDeskTeamInput {
  name: string;
  icon?: string;
  memberIds?: string[];
  distributionMethod?: DeskDistributionMethod;
  teamLimit?: number | null;
  ignoreAwayStatus?: boolean;
  officeHours?: { timezone: string; hours: Record<string, { start: string; end: string }[]> } | null;
  expectedReplyTime?: string;
  inboxRank?: number;
}

export function useCreateDeskTeam() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateDeskTeamInput) => {
      const client = await getClient();
      return client.post<{ data: DeskTeam }>('/desk/teams', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: deskKeys.teams() });
    },
  });
}

export function useUpdateDeskTeam() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<CreateDeskTeamInput> }) => {
      const client = await getClient();
      return client.patch<{ data: DeskTeam }>(`/desk/teams/${id}`, data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: deskKeys.teams() });
    },
  });
}

export function useDeleteDeskTeam() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<void>(`/desk/teams/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: deskKeys.teams() });
    },
  });
}

// =============================================================================
// Teammate settings ("me")
// =============================================================================

export function useDeskTeammateMe() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: deskKeys.teammateMe(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: DeskTeammateSettings }>('/desk/teammates/me');
    },
  });
}

export interface UpdateDeskTeammateSettingsInput {
  status?: DeskTeammateStatus;
  assignmentLimit?: number | null;
  notificationPreferences?: Record<string, boolean>;
}

export function useUpdateDeskTeammateSettings() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: UpdateDeskTeammateSettingsInput) => {
      const client = await getClient();
      return client.put<{ data: DeskTeammateSettings }>('/desk/teammates/me', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: deskKeys.teammateMe() });
    },
  });
}

// =============================================================================
// Views
// =============================================================================

export function useDeskViews(folder?: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...deskKeys.views(), { folder: folder ?? null }],
    queryFn: async () => {
      const client = await getClient();
      const qs = folder ? `?folder=${encodeURIComponent(folder)}` : '';
      return client.get<{ data: DeskView[] }>(`/desk/views${qs}`);
    },
  });
}

export interface CreateDeskViewInput {
  name: string;
  icon?: string;
  folder?: string;
  filters: DeskViewFilter;
  sort?: DeskViewSort;
  shared?: boolean;
  order?: number;
}

export function useCreateDeskView() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateDeskViewInput) => {
      const client = await getClient();
      return client.post<{ data: DeskView }>('/desk/views', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: deskKeys.views() });
    },
  });
}

export function useUpdateDeskView() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<CreateDeskViewInput> }) => {
      const client = await getClient();
      return client.patch<{ data: DeskView }>(`/desk/views/${id}`, data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: deskKeys.views() });
    },
  });
}

export function useDeleteDeskView() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<void>(`/desk/views/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: deskKeys.views() });
    },
  });
}

// =============================================================================
// Macros
// =============================================================================

export function useDeskMacros(teamId?: string, archived = false) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...deskKeys.macros(), { teamId: teamId ?? null, archived }],
    queryFn: async () => {
      const client = await getClient();
      const params = new URLSearchParams();
      if (teamId) params.set('teamId', teamId);
      if (archived) params.set('archived', 'true');
      const qs = params.toString();
      return client.get<{ data: DeskMacro[] }>(`/desk/macros${qs ? `?${qs}` : ''}`);
    },
  });
}

export interface CreateDeskMacroInput {
  name: string;
  body?: string;
  insertAs?: 'reply' | 'note';
  actions?: DeskMacroAction[];
  teamIds?: string[] | null;
}

export function useCreateDeskMacro() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateDeskMacroInput) => {
      const client = await getClient();
      return client.post<{ data: DeskMacro }>('/desk/macros', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: deskKeys.macros() });
    },
  });
}

export function useUpdateDeskMacro() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<CreateDeskMacroInput> }) => {
      const client = await getClient();
      return client.patch<{ data: DeskMacro }>(`/desk/macros/${id}`, data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: deskKeys.macros() });
    },
  });
}

export function useDeleteDeskMacro() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<void>(`/desk/macros/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: deskKeys.macros() });
    },
  });
}
