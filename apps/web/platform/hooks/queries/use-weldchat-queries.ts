/**
 * WeldChat TanStack Query Hooks
 *
 * Query key factory and hooks for all chat operations.
 *
 * Every hook targets app-api (`useAppApiClient().getClient()`, raw paths with no
 * `/api` prefix — the client prepends it). The legacy api-worker client hook is
 * gone from this file: the behaviour its handlers
 * carried — creator auto-join, member fan-out, memberCount denorm, realtime
 * publishes, bookmark join hydration, read receipts, forwarding — now lives in
 * app-api's channel services, so the routes are real ports rather than
 * near-miss CRUD. See W5b of `.claude/open-source-plan.md`.
 */

import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient, useInfiniteQuery, type QueryClient } from '@tanstack/react-query';
import { useAuth, useUser } from '@clerk/clerk-react';
import { toast } from 'sonner';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { CreateChannelRequest, UpdateChannelRequest, SendMessageRequest, CreateDmRequest, SetUserStatusRequest } from '@/lib/api/domains/weldchat';

/** app-api list envelope — `{ data, pagination }` with an opaque cursor. */
interface ListEnvelope<T> {
  data: T[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

/** Max rows app-api will return for a single list request. */
const MAX_PAGE = 100;

// ============================================================================
// Query Key Factory
// ============================================================================

export const weldchatKeys = {
  all: ['weldchat'] as const,
  channels: () => [...weldchatKeys.all, 'channels'] as const,
  channelDetail: (id: string) => [...weldchatKeys.channels(), id] as const,
  messages: (channelId: string) => [...weldchatKeys.all, 'messages', channelId] as const,
  threadMessages: (channelId: string, parentId: string) => [...weldchatKeys.all, 'thread', channelId, parentId] as const,
  pinnedMessages: (channelId: string) => [...weldchatKeys.all, 'pinned', channelId] as const,
  members: (channelId: string) => [...weldchatKeys.all, 'members', channelId] as const,
  dms: () => [...weldchatKeys.all, 'dms'] as const,
  dmByUser: (userId: string) => [...weldchatKeys.all, 'dm-user', userId] as const,
  bookmarks: () => [...weldchatKeys.all, 'bookmarks'] as const,
  statuses: () => [...weldchatKeys.all, 'statuses'] as const,
  search: (query: string) => [...weldchatKeys.all, 'search', query] as const,
  workspaceMembers: () => [...weldchatKeys.all, 'workspace-members'] as const,
  readReceipts: (channelId: string) => [...weldchatKeys.all, 'read-receipts', channelId] as const,
  sections: () => [...weldchatKeys.all, 'sections'] as const,
  activeCall: (channelId: string) => [...weldchatKeys.all, 'active-call', channelId] as const,
  callDetail: (callId: string) => [...weldchatKeys.all, 'call', callId] as const,
  clipTranscript: (channelId: string, messageId: string) => [...weldchatKeys.all, 'clip-transcript', channelId, messageId] as const,
};

// ============================================================================
// Real-Time Cache Merge Utilities
// ============================================================================

/**
 * Insert a new real-time message into the infinite query cache.
 * Deduplicates by id (replaces optimistic messages).
 */
export function mergeMessageIntoCache(
  queryClient: QueryClient,
  channelId: string,
  message: Record<string, unknown>,
) {
  queryClient.setQueryData(weldchatKeys.messages(channelId), (old: any) => {
    if (!old?.pages) return old;

    // Check for duplicates across all pages
    for (const page of old.pages) {
      const messages = page?.data?.messages;
      if (messages?.some((m: any) => m.id === message.id)) {
        // Already exists — replace it (handles optimistic → real swap)
        return {
          ...old,
          pages: old.pages.map((p: any) => ({
            ...p,
            data: {
              ...p.data,
              messages: p.data?.messages?.map((m: any) =>
                m.id === message.id ? { ...m, ...message, _optimistic: undefined } : m,
              ),
            },
          })),
        };
      }
    }

    // Remove any optimistic message with matching content (best-effort dedup)
    const newPages = old.pages.map((p: any, idx: number) => {
      if (idx !== 0) return p;
      const messages = p.data?.messages?.filter(
        (m: any) => !m._optimistic || m.content !== message.content,
      ) ?? [];
      return {
        ...p,
        data: { ...p.data, messages: [message, ...messages] },
      };
    });

    return { ...old, pages: newPages };
  });
}

/**
 * Update a message's fields across all pages in the cache.
 */
export function updateMessageInCache(
  queryClient: QueryClient,
  channelId: string,
  messageId: string,
  updates: Record<string, unknown>,
) {
  queryClient.setQueryData(weldchatKeys.messages(channelId), (old: any) => {
    if (!old?.pages) return old;
    return {
      ...old,
      pages: old.pages.map((p: any) => ({
        ...p,
        data: {
          ...p.data,
          messages: p.data?.messages?.map((m: any) =>
            m.id === messageId ? { ...m, ...updates } : m,
          ),
        },
      })),
    };
  });
}

/**
 * Mark a message as deleted across all pages in the cache.
 */
export function removeMessageFromCache(
  queryClient: QueryClient,
  channelId: string,
  messageId: string,
) {
  queryClient.setQueryData(weldchatKeys.messages(channelId), (old: any) => {
    if (!old?.pages) return old;
    return {
      ...old,
      pages: old.pages.map((p: any) => ({
        ...p,
        data: {
          ...p.data,
          messages: p.data?.messages?.filter((m: any) => m.id !== messageId),
        },
      })),
    };
  });
}

// ============================================================================
// Channel Queries
// ============================================================================

export function useChannels() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldchatKeys.channels(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<any>('/channels');
    },
  });
}

export function useChannel(channelId: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldchatKeys.channelDetail(channelId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<any>(`/channels/${channelId}`);
    },
    enabled: !!channelId,
  });
}

/**
 * Create a channel.
 *
 * `POST /api/channels` is now service-backed: the creator is auto-joined as
 * owner, `memberIds` are honoured, a public channel fans out to every internal
 * workspace member, `memberCount` is denormalised and every member gets a
 * `channel_new` push. Returns the full channel row in `data`.
 */
export function useCreateChannel() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (data: CreateChannelRequest) => {
      const client = await getClient();
      return client.post<any>('/channels', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.channels() });
    },
  });
}

export function useUpdateChannel() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async ({ channelId, ...data }: UpdateChannelRequest & { channelId: string }) => {
      const client = await getClient();
      return client.patch<any>(`/channels/${channelId}`, data);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.channels() });
      queryClient.invalidateQueries({ queryKey: weldchatKeys.channelDetail(variables.channelId) });
    },
  });
}

// Removed with the api-worker phase-out: useChannelRoleLinks /
// useUpdateChannelRoleLinks. Both were unexported and unreferenced, and both
// pointed at the legacy `/chat/channels/:id/roles` surface. The channel↔role
// link model itself still lives server-side (chatChannelRoleLinks +
// services/weldchat-role-links on api-worker); if the UI ever wants it back it
// needs a real app-api port, not these stubs. See the W5b report.

export function useDeleteChannel() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (channelId: string) => {
      const client = await getClient();
      return client.delete<any>(`/channels/${channelId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.channels() });
    },
  });
}

// ============================================================================
// Read Receipt Queries
// ============================================================================

/**
 * Per-message read data, grouped `{ [messageId]: readers[] }`.
 *
 * Fed by the per-message `chat_message_reads` rows that `POST /channels/:id/read`
 * writes — both halves were ported together, since receipts are empty without
 * the write side.
 */
export function useReadReceipts(channelId: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldchatKeys.readReceipts(channelId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<any>(`/channels/${channelId}/read-receipts`);
    },
    enabled: !!channelId,
    staleTime: 30000,
  });
}

export function useMarkChannelAsRead() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (channelId: string) => {
      const client = await getClient();
      return client.post<any>(`/channels/${channelId}/read`);
    },
    onSuccess: (_data, channelId) => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.channels() });
      queryClient.invalidateQueries({ queryKey: weldchatKeys.readReceipts(channelId) });
    },
  });
}

// ============================================================================
// Message Queries
// ============================================================================

export function useMessages(channelId: string) {
  const { getClient } = useAppApiClient();
  return useInfiniteQuery({
    queryKey: weldchatKeys.messages(channelId),
    queryFn: async ({ pageParam }) => {
      const client = await getClient();
      const qs = new URLSearchParams();
      if (pageParam) qs.set('before', pageParam);
      qs.set('limit', '50');
      const query = qs.toString();
      return client.get<any>(`/channels/${channelId}/messages${query ? '?' + query : ''}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: any) => {
      const inner = lastPage?.data;
      if (!inner?.messages?.length || !inner.hasMore) return undefined;
      return inner.nextCursor ?? undefined;
    },
    enabled: !!channelId,
  });
}

/**
 * Thread replies for a parent message.
 *
 * app-api serves these off the flat message list (`?parentId=`) and orders
 * newest-first; the legacy route ordered oldest-first and returned every reply.
 * Both deltas are normalised here so consumers see the exact shape they always
 * did: `{ data: replies }`, oldest reply first. Capped at app-api's 100-row
 * ceiling (the legacy route was unbounded) — threads longer than that truncate.
 */
export function useThreadMessages(channelId: string, parentId: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldchatKeys.threadMessages(channelId, parentId),
    queryFn: async () => {
      const client = await getClient();
      const qs = new URLSearchParams({
        channelId,
        parentId,
        limit: String(MAX_PAGE),
      });
      const res = await client.get<ListEnvelope<any>>(`/chat-messages?${qs.toString()}`);
      const replies = [...(res.data ?? [])].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
      return { data: replies };
    },
    enabled: !!channelId && !!parentId,
  });
}

export function usePinnedMessages(channelId: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldchatKeys.pinnedMessages(channelId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any[] }>(`/chat-messages/pinned?channelId=${encodeURIComponent(channelId)}`);
    },
    enabled: !!channelId,
  });
}

export function useSendMessage() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  const { userId } = useAuth();
  const { user } = useUser();
  return useMutation({
    mutationFn: async ({ channelId, _optimisticId, ...data }: SendMessageRequest & { channelId: string; _optimisticId?: string }) => {
      const client = await getClient();
      return client.post<any>(`/channels/${channelId}/messages`, data);
    },
    onMutate: async (variables) => {
      const { channelId, _optimisticId } = variables;
      if (!_optimisticId || !userId) return;

      await queryClient.cancelQueries({ queryKey: weldchatKeys.messages(channelId) });

      const optimisticMessage = {
        id: _optimisticId,
        channelId,
        content: variables.content,
        htmlContent: variables.htmlContent,
        authorId: userId,
        authorName: user?.fullName || user?.firstName || 'You',
        authorAvatar: user?.imageUrl || null,
        type: variables.type || 'message',
        parentId: variables.parentId,
        attachments: variables.attachments,
        mentions: variables.mentions,
        reactions: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        _optimistic: true,
      };

      queryClient.setQueryData(weldchatKeys.messages(channelId), (old: any) => {
        if (!old?.pages) return old;
        const newPages = [...old.pages];
        const firstPage = newPages[0];
        newPages[0] = {
          ...firstPage,
          data: {
            ...firstPage.data,
            messages: [optimisticMessage, ...(firstPage.data?.messages ?? [])],
          },
        };
        return { ...old, pages: newPages };
      });
    },
    onSuccess: (response, variables) => {
      // Reconcile the optimistic (greyed, _optimistic) message with the row the
      // server actually persisted. WeldChat used to lean on the realtime echo
      // to do this, but the sender can't depend on receiving its own message
      // back over the socket — when that echo doesn't arrive the optimistic
      // message stays grey forever. mergeMessageIntoCache swaps it in by
      // content (and dedupes by id if the echo does arrive later).
      const message = (response as any)?.data;
      if (message?.id) {
        mergeMessageIntoCache(queryClient, variables.channelId, message);
      }
    },
    onError: (_error, variables) => {
      if ((variables as any)._optimisticId) {
        queryClient.setQueryData(weldchatKeys.messages(variables.channelId), (old: any) => {
          if (!old?.pages) return old;
          return {
            ...old,
            pages: old.pages.map((p: any) => ({
              ...p,
              data: {
                ...p.data,
                messages: p.data?.messages?.filter((m: any) => m.id !== (variables as any)._optimisticId),
              },
            })),
          };
        });
      }
    },
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.channels() });
      if (variables.parentId) {
        queryClient.invalidateQueries({ queryKey: weldchatKeys.threadMessages(variables.channelId, variables.parentId) });
      }
    },
  });
}

function useEditMessage() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async ({ messageId, content, htmlContent }: { channelId: string; messageId: string; content: string; htmlContent?: string }) => {
      const client = await getClient();
      return client.patch<any>(`/chat-messages/${messageId}`, { content, htmlContent });
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.messages(variables.channelId) });
    },
  });
}

export function useDeleteMessage() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async ({ messageId }: { channelId: string; messageId: string }) => {
      const client = await getClient();
      return client.delete<any>(`/chat-messages/${messageId}`);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.messages(variables.channelId) });
    },
  });
}

// ============================================================================
// Reaction Mutations
// ============================================================================

export function useToggleReaction() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  const { userId } = useAuth();
  return useMutation({
    mutationFn: async ({ messageId, emoji, hasReacted }: { channelId: string; messageId: string; emoji: string; hasReacted: boolean }) => {
      const client = await getClient();
      if (hasReacted) {
        return client.delete<any>(`/chat-messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
      }
      return client.post<any>(`/chat-messages/${messageId}/reactions`, { emoji });
    },
    onMutate: async (variables) => {
      const queryKey = weldchatKeys.messages(variables.channelId);
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (old: any) => {
        if (!old?.pages) return old;
        return {
          ...old,
          pages: old.pages.map((page: any) => {
            const messages = page?.data?.messages;
            if (!messages) return page;
            return {
              ...page,
              data: {
                ...page.data,
                messages: messages.map((msg: any) => {
                  if (msg.id !== variables.messageId) return msg;
                  const reactions = { ...(msg.reactions || {}) };
                  const users = reactions[variables.emoji] ? [...reactions[variables.emoji]] : [];
                  if (variables.hasReacted) {
                    reactions[variables.emoji] = users.filter((id: string) => id !== userId);
                    if (reactions[variables.emoji].length === 0) delete reactions[variables.emoji];
                  } else {
                    if (userId && !users.includes(userId)) users.push(userId);
                    reactions[variables.emoji] = users;
                  }
                  return { ...msg, reactions };
                }),
              },
            };
          }),
        };
      });
      return { previous };
    },
    onError: (_err, variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(weldchatKeys.messages(variables.channelId), context.previous);
      }
    },
    onSettled: (_data, _err, variables) => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.messages(variables.channelId) });
    },
  });
}

// ============================================================================
// Pin Mutations
// ============================================================================

export function usePinMessage() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async ({ messageId, expiresAt, notify }: { channelId: string; messageId: string; expiresAt?: string; notify?: boolean }) => {
      const client = await getClient();
      const body: any = {};
      if (expiresAt) body.expiresAt = expiresAt;
      if (notify !== undefined) body.notify = notify;
      return client.post<any>(`/chat-messages/${messageId}/pin`, Object.keys(body).length > 0 ? body : undefined);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.messages(variables.channelId) });
      queryClient.invalidateQueries({ queryKey: weldchatKeys.pinnedMessages(variables.channelId) });
    },
  });
}

export function useUnpinMessage() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async ({ messageId }: { channelId: string; messageId: string }) => {
      const client = await getClient();
      return client.delete<any>(`/chat-messages/${messageId}/pin`);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.messages(variables.channelId) });
      queryClient.invalidateQueries({ queryKey: weldchatKeys.pinnedMessages(variables.channelId) });
    },
  });
}

/**
 * Forward a message into one or more channels.
 *
 * Ported to app-api as `POST /channels/:channelId/messages/:messageId/forward`
 * — the same path shape the legacy route was mounted at. The server keeps the
 * copy semantics (forwardedFrom snapshot pointing at the ORIGINAL message,
 * all-or-nothing target validation, auto-join of public targets), which is why
 * this can't be composed from the flat message CRUD client-side.
 */
export function useForwardMessage() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async ({
      sourceChannelId,
      sourceMessageId,
      targetChannelIds,
      comment,
      htmlComment,
    }: {
      sourceChannelId: string;
      sourceMessageId: string;
      targetChannelIds: string[];
      comment?: string;
      htmlComment?: string;
    }) => {
      const client = await getClient();
      return client.post<{ data: { forwarded: Array<{ channelId: string; messageId: string }> } }>(
        `/channels/${sourceChannelId}/messages/${sourceMessageId}/forward`,
        { targetChannelIds, comment, htmlComment },
      );
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.channels() });
      for (const targetChannelId of variables.targetChannelIds) {
        queryClient.invalidateQueries({ queryKey: weldchatKeys.messages(targetChannelId) });
      }
    },
  });
}

/**
 * "Mark unread from here".
 *
 * Behaviour fix, not just a port: `beforeMessageId` is now honoured. The legacy
 * api-worker read handler accepted the body and never looked at it, so this
 * action has been marking the channel fully READ — the exact opposite of what
 * the user asked for. app-api drops the read records from that message onwards
 * and rewinds the cursor to the message before it.
 */
export function useMarkChannelUnread() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async ({ channelId, beforeMessageId }: { channelId: string; beforeMessageId: string }) => {
      const client = await getClient();
      return client.post<any>(`/channels/${channelId}/read`, { beforeMessageId });
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.channels() });
      queryClient.invalidateQueries({ queryKey: weldchatKeys.messages(variables.channelId) });
    },
  });
}

// ============================================================================
// Member Queries
// ============================================================================

export function useChannelMembers(channelId: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldchatKeys.members(channelId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<any>(`/channels/${channelId}/members`);
    },
    enabled: !!channelId,
  });
}

/**
 * Add members to a channel in one batch.
 *
 * `POST /api/channels/:channelId/members` is the real batch endpoint: it
 * honours `memberType` (agent invites stay agents and are id-validated), skips
 * existing members, keeps `chatChannels.memberCount` in step, and publishes
 * `member_joined` + `channel_new` so the channel appears in the invitee's
 * sidebar live. Batching the flat one-row-at-a-time CRUD route client-side
 * would leave the denormalised count drifting and other clients stale.
 */
export function useAddChannelMembers() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async ({
      channelId,
      userIds,
      memberType,
    }: {
      channelId: string;
      userIds: string[];
      memberType?: 'user' | 'agent';
    }) => {
      const client = await getClient();
      return client.post<any>(`/channels/${channelId}/members`, { userIds, memberType });
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.members(variables.channelId) });
      queryClient.invalidateQueries({ queryKey: weldchatKeys.channels() });
    },
  });
}

/**
 * Remove a member from a channel.
 *
 * Keyed by USER id — `DELETE /api/channel-members/:id` keys off the membership
 * ROW id, which this call site does not hold. The channel-scoped route also
 * decrements `chatChannels.memberCount` and publishes `member_left`.
 */
export function useRemoveChannelMember() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async ({ channelId, userId }: { channelId: string; userId: string }) => {
      const client = await getClient();
      return client.delete<any>(`/channels/${channelId}/members/${userId}`);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.members(variables.channelId) });
      queryClient.invalidateQueries({ queryKey: weldchatKeys.channels() });
    },
  });
}

// Removed with the api-worker phase-out: useJoinChannel / useLeaveChannel.
// Both were unexported and unreferenced. The endpoints they wrapped were ported
// and still exist — `POST /api/channels/:channelId/members/join` and
// `.../leave` — so re-adding a hook is a two-line job if the UI ever grows a
// browse-channels flow. See the W5b report.

/**
 * Mute/unmute the current user's membership.
 *
 * Bug fix, not just a port: the legacy path (`PATCH /chat/channels/:id/members/me`)
 * was never registered on api-worker's members router, so muting has been 404ing.
 * app-api's `PATCH /api/channels/:channelId/me` is the real implementation.
 */
export function useMuteChannel() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async ({ channelId, mute }: { channelId: string; mute: boolean }) => {
      const client = await getClient();
      return client.patch<any>(`/channels/${channelId}/me`, { isMuted: mute });
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.channels() });
      queryClient.invalidateQueries({ queryKey: weldchatKeys.dms() });
      queryClient.invalidateQueries({ queryKey: weldchatKeys.channelDetail(variables.channelId) });
    },
  });
}

export function useArchiveChannel() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (channelId: string) => {
      const client = await getClient();
      return client.patch<any>(`/channels/${channelId}`, { isArchived: true });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.channels() });
      queryClient.invalidateQueries({ queryKey: weldchatKeys.dms() });
    },
  });
}

// ============================================================================
// DM Queries
// ============================================================================

export function useDmChannels() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldchatKeys.dms(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<any>('/chat-dm');
    },
  });
}

export function useCreateDm() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (data: CreateDmRequest) => {
      const client = await getClient();
      return client.post<any>('/chat-dm', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.dms() });
    },
  });
}

/**
 * Resolve a target userId to a 1:1 DM channel (creates if needed).
 */
export function useDmByUser(targetUserId: string) {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: weldchatKeys.dmByUser(targetUserId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<any>(`/chat-dm/${targetUserId}`);
    },
    enabled: !!targetUserId,
  });

  // When the DM channel is resolved (possibly newly created), refresh the sidebar list
  const channelId = query.data?.data?.id;
  useEffect(() => {
    if (channelId) {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.dms() });
    }
  }, [channelId, queryClient]);

  return query;
}

// ============================================================================
// Bookmark Queries
// ============================================================================

/**
 * The current user's bookmarks, newest first.
 *
 * `GET /api/chat-bookmarks` now left-joins the message and channel, so the
 * `messageContent` / `messageAuthorName` / `channelName` / … fields the
 * bookmarks page, panel and popover render come back hydrated.
 *
 * Delta: app-api paginates where the legacy route returned every bookmark.
 * Pinned to app-api's 100-row ceiling — a user with more than 100 bookmarks
 * sees their most recent 100.
 */
export function useBookmarks() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldchatKeys.bookmarks(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<ListEnvelope<any>>(`/chat-bookmarks?limit=${MAX_PAGE}`);
    },
  });
}

export function useBookmarkMessage() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (data: { messageId: string; channelId: string; note?: string }) => {
      const client = await getClient();
      return client.post<any>('/chat-bookmarks', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.bookmarks() });
    },
  });
}

export function useDeleteBookmark() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (bookmarkId: string) => {
      const client = await getClient();
      return client.delete<any>(`/chat-bookmarks/${bookmarkId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.bookmarks() });
    },
  });
}

// ============================================================================
// Status Queries
// ============================================================================

function useUserStatuses() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldchatKeys.statuses(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<any>('/chat-status');
    },
  });
}

function useSetUserStatus() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (data: SetUserStatusRequest) => {
      const client = await getClient();
      return client.put<any>('/chat-status', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.statuses() });
    },
  });
}

// ============================================================================
// Search
// ============================================================================

function useSearchMessages(query: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldchatKeys.search(query),
    queryFn: async () => {
      const client = await getClient();
      const qs = new URLSearchParams();
      if (query) qs.set('q', query);
      return client.get<any>(`/chat-search?${qs.toString()}`);
    },
    enabled: query.length >= 2,
  });
}

// ============================================================================
// Section Queries
// ============================================================================

/**
 * Chat sections, position-ordered.
 *
 * app-api's list orders by `createdAt DESC` and paginates; the sidebar needs
 * them in `position` order, so we pull a full page and sort here to keep the
 * legacy `{ data: sections }` contract. Behaviour delta worth knowing: the
 * legacy route auto-seeded a default "Channels" section on first read — app-api
 * does not, so a brand-new workspace now starts with zero sections.
 */
export function useSections() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldchatKeys.sections(),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<ListEnvelope<any>>(`/chat-sections?limit=${MAX_PAGE}`);
      const sections = [...(res.data ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      return { data: sections };
    },
  });
}

export function useCreateSection() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (data: { name: string; position?: number }) => {
      const client = await getClient();
      // The legacy route defaulted `position` to "end of list" server-side;
      // app-api's create is a plain insert, so resolve it here. Read from the
      // server rather than the query cache — onMutate has already written an
      // optimistic row into that cache by the time this runs.
      let position = data.position;
      if (position === undefined) {
        const current = await client.get<ListEnvelope<any>>(`/chat-sections?limit=${MAX_PAGE}`);
        const positions = (current.data ?? []).map((s: any) => s.position ?? 0);
        position = positions.length > 0 ? Math.max(...positions) + 1 : 0;
      }
      return client.post<any>('/chat-sections', { ...data, position });
    },
    onMutate: async (data) => {
      await queryClient.cancelQueries({ queryKey: weldchatKeys.sections() });
      const previous = queryClient.getQueryData<any>(weldchatKeys.sections());
      const existing = previous?.data ?? [];
      const nextPosition =
        data.position ??
        (existing.length > 0
          ? Math.max(...existing.map((s: any) => s.position ?? 0)) + 1
          : 0);
      const optimisticId = `optimistic_csec_${Date.now()}`;
      const now = new Date().toISOString();
      const optimistic = {
        id: optimisticId,
        name: data.name,
        position: nextPosition,
        createdAt: now,
        updatedAt: now,
      };
      queryClient.setQueryData(weldchatKeys.sections(), {
        ...(previous ?? { success: true }),
        data: [...existing, optimistic],
      });
      return { previous, optimisticId };
    },
    onError: (_err, _data, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(weldchatKeys.sections(), context.previous);
      }
      toast.error('Could not create section. Please try again.');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.sections() });
    },
  });
}

export function useUpdateSection() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async ({ sectionId, ...data }: { sectionId: string; name?: string; position?: number }) => {
      const client = await getClient();
      return client.patch<any>(`/chat-sections/${sectionId}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.sections() });
    },
  });
}

/**
 * Delete a section.
 *
 * `chatChannels.sectionId` carries a foreign key to `chatSections.id` with no
 * ON DELETE rule, so deleting a section that still has channels in it raises an
 * FK violation. The legacy handler nulled the assigned channels out server-side
 * first; app-api's `DELETE /api/chat-sections/:id` is a plain delete, so the
 * unassign step is done here — the same client-side composition
 * useAssignChannelToSection already relies on (`PATCH /channels/:id`).
 *
 * Non-atomic: if the delete fails after the unassign, the channels are left
 * section-less rather than wrongly parented. That is the safe direction, and
 * the legacy loop was equally non-atomic. Owning this properly means a cascade
 * (or ON DELETE SET NULL) on the app-api section delete — flagged in the W5b
 * report as the follow-up for whoever owns routes/chat-sections.
 */
export function useDeleteSection() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (sectionId: string) => {
      const client = await getClient();
      // Unassign every channel still pointing at this section, or the delete
      // below trips the FK.
      const channels = await client.get<ListEnvelope<any>>(`/channels?limit=${MAX_PAGE}`);
      const assigned = (channels.data ?? []).filter((ch: any) => ch.sectionId === sectionId);
      for (const ch of assigned) {
        await client.patch<any>(`/channels/${ch.id}`, { sectionId: null });
      }
      return client.delete<any>(`/chat-sections/${sectionId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.sections() });
      queryClient.invalidateQueries({ queryKey: weldchatKeys.channels() });
    },
  });
}

/**
 * Section assignment is a column on the channel, not a join table — the legacy
 * `PUT /chat/sections/:sectionId/channels/:channelId` did nothing but
 * `UPDATE chat_channels SET section_id = ?`. Expressed directly against
 * app-api's channel PATCH. The `sectionId` param is kept in the signature so
 * callers and the invalidation set are unchanged.
 */
export function useAssignChannelToSection() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async ({ sectionId, channelId }: { sectionId: string; channelId: string }) => {
      const client = await getClient();
      return client.patch<any>(`/channels/${channelId}`, { sectionId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.sections() });
      queryClient.invalidateQueries({ queryKey: weldchatKeys.channels() });
    },
  });
}

/** Mirror of useAssignChannelToSection — clears the channel's `sectionId`. */
export function useRemoveChannelFromSection() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async ({ channelId }: { sectionId: string; channelId: string }) => {
      const client = await getClient();
      return client.patch<any>(`/channels/${channelId}`, { sectionId: null });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.sections() });
      queryClient.invalidateQueries({ queryKey: weldchatKeys.channels() });
    },
  });
}

/**
 * Bulk reorder. app-api has no `/reorder` route, but the legacy handler was
 * itself just a sequential `UPDATE ... SET position` loop, so the same loop from
 * the client is behaviourally identical (non-atomic in both cases).
 */
function useReorderSections() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (order: Array<{ id: string; position: number }>) => {
      const client = await getClient();
      for (const item of order) {
        await client.patch<any>(`/chat-sections/${item.id}`, { position: item.position });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.sections() });
    },
  });
}

// ============================================================================
// Clip Mutations
// ============================================================================

export function useTranscribeClip() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async ({ channelId, messageId, attachmentId }: { channelId: string; messageId: string; attachmentId: string }) => {
      const client = await getClient();
      return client.post<any>(`/chat-clips/${channelId}`, { messageId, attachmentId });
    },
  });
}

/**
 * Update a clip attachment's transcript in the message cache.
 * Called when a real-time CLIP_TRANSCRIPT_UPDATED event is received.
 */
export function updateClipTranscriptInCache(
  queryClient: QueryClient,
  channelId: string,
  messageId: string,
  attachmentId: string,
  transcript: Record<string, unknown>,
) {
  queryClient.setQueryData(weldchatKeys.messages(channelId), (old: any) => {
    if (!old?.pages) return old;
    return {
      ...old,
      pages: old.pages.map((p: any) => ({
        ...p,
        data: {
          ...p.data,
          messages: p.data?.messages?.map((m: any) => {
            if (m.id !== messageId) return m;
            return {
              ...m,
              attachments: m.attachments?.map((att: any) =>
                att.id === attachmentId ? { ...att, transcript } : att,
              ),
            };
          }),
        },
      })),
    };
  });
}

// ============================================================================
// Workspace Members (for DM user picker)
// ============================================================================

/** Raw `workspaceMembers` row as app-api's `/team-members` projects it. */
interface TeamMemberRow {
  id: string;
  userId: string;
  name: string | null;
  email?: string | null;
  picture: string | null;
  role: string | null;
  status: string | null;
  memberType?: string | null;
  permissions?: unknown;
  roleId?: string | null;
  createdAt?: string;
}

/**
 * Every workspace member, for the DM picker / channel invite / @mention
 * autocomplete.
 *
 * `?memberType=all` is required: app-api defaults the team directory to
 * INTERNAL only, whereas the legacy `/settings/members` returned guests too and
 * the chat pickers depend on that. `limit` is pushed to app-api's 100 ceiling —
 * legacy silently defaulted to a page size of 20, which quietly truncated the
 * mention list in any workspace with more than 20 people.
 *
 * The response is re-shaped into the legacy transform (`auth0Id`,
 * uppercase `role`/`workspaceRole`, `name` fallback) so all ~20 consumers —
 * including `fromTeamMember()` — keep working untouched. The rows stay `any`
 * on the way out, exactly as the legacy `client.get<any>` contract did:
 * consumers reach for fields across several different shapes (`firstName`,
 * `workspaceRoleId`, `hoursPerWeek`) and typing the array here would break them
 * at compile time without making any of them more correct.
 *
 * Field delta to be aware of: app-api projects member rows by visibility and
 * `hoursPerWeek` is in none of its field sets, so it no longer comes back here
 * (it fed `fromTeamMember` → the chat profile panel). `email` is only included
 * for callers holding `team:read`; everyone else now gets the public projection
 * instead of the blanket 403 the legacy route returned.
 */
export function useWorkspaceMembers() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldchatKeys.workspaceMembers(),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<ListEnvelope<TeamMemberRow>>(
        `/team-members?memberType=all&limit=${MAX_PAGE}`,
      );
      const data: any[] = (res.data ?? []).map((m) => {
        const role = (m.role ?? 'member').toUpperCase();
        return {
          id: m.id,
          auth0Id: m.userId,
          email: m.email ?? '',
          name: m.name || m.email || 'Unknown',
          picture: m.picture,
          role,
          workspaceRole: role,
          status: m.status || 'ACTIVE',
          userId: m.userId,
          memberType: m.memberType,
          permissions: m.permissions ?? [],
          roleId: m.roleId,
          createdAt: m.createdAt,
        };
      });
      return { ...res, data };
    },
  });
}
