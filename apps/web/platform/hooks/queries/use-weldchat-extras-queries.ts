/**
 * WeldChat Extras — Activity, Drafts, and Directories query hooks.
 *
 * Uses useAppApiClient() (app-api worker) — /api/chat-activity,
 * /api/chat-drafts and /api/chat-directories.
 */

import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { ActivityItem, ListActivityQuery } from '@weldsuite/core-api-client/schemas/weldchat-activity';
import type { DraftItem, UpsertDraftInput } from '@weldsuite/core-api-client/schemas/weldchat-drafts';
import type { DirectoryChannelItem } from '@weldsuite/core-api-client/schemas/weldchat-directories';

// ============================================================================
// Response shapes (app-api envelopes)
// ============================================================================

interface ListEnvelope<T> {
  data: T[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

/** Raw chat_drafts row as returned by app-api (no channelName join). */
interface ChatDraftRow {
  id: string;
  channelId: string | null;
  threadParentMessageId: string | null;
  content: string;
  attachments: DraftItem['attachments'];
  updatedAt: string;
  createdAt: string;
}

// ============================================================================
// Query key factory
// ============================================================================

const weldchatExtrasKeys = {
  all: ['weldchat-extras'] as const,

  activity: () => [...weldchatExtrasKeys.all, 'activity'] as const,
  activityList: (filter: string) => [...weldchatExtrasKeys.activity(), 'list', filter] as const,
  activityUnread: () => [...weldchatExtrasKeys.activity(), 'unread-count'] as const,

  drafts: () => [...weldchatExtrasKeys.all, 'drafts'] as const,
  draftsList: () => [...weldchatExtrasKeys.drafts(), 'list'] as const,

  directories: () => [...weldchatExtrasKeys.all, 'directories'] as const,
  directoryChannels: (search?: string) =>
    [...weldchatExtrasKeys.directories(), 'channels', search ?? ''] as const,
};

// ============================================================================
// Activity hooks
// ============================================================================

export function useChatActivity(filter: ListActivityQuery['filter'] = 'all') {
  const { getClient } = useAppApiClient();

  return useInfiniteQuery({
    queryKey: weldchatExtrasKeys.activityList(filter),
    queryFn: async ({ pageParam }) => {
      const client = await getClient();
      const qs = new URLSearchParams({ filter, limit: '25' });
      if (pageParam) qs.set('cursor', pageParam);
      return client.get<ListEnvelope<ActivityItem>>(`/chat-activity?${qs.toString()}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => {
      const pagination = (lastPage as any)?.pagination;
      if (!pagination?.hasMore) return undefined;
      return pagination.cursor ?? undefined;
    },
  });
}

export function useChatActivityUnread() {
  const { getClient } = useAppApiClient();

  return useQuery({
    queryKey: weldchatExtrasKeys.activityUnread(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: { count: number } }>('/chat-activity/unread-count');
    },
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
  });
}

export function useMarkActivityRead() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();

  return useMutation({
    mutationFn: async (notificationId?: string) => {
      const client = await getClient();
      await client.post<void>('/chat-activity/read', { notificationId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: weldchatExtrasKeys.activity() });
    },
  });
}

// ============================================================================
// Drafts hooks
// ============================================================================

export function useChatDrafts() {
  const { getClient } = useAppApiClient();

  return useQuery({
    queryKey: weldchatExtrasKeys.draftsList(),
    queryFn: async (): Promise<{ data: DraftItem[] }> => {
      const client = await getClient();
      // app-api returns raw rows without the channelName join the old
      // core-api list had — enrich from the channel directory (public
      // channels + every channel the caller is a member of).
      const [draftsRes, channelsRes] = await Promise.all([
        client.get<ListEnvelope<ChatDraftRow>>('/chat-drafts?limit=100'),
        client.get<{ data: DirectoryChannelItem[] }>('/chat-directories/channels'),
      ]);
      const nameById = new Map((channelsRes.data ?? []).map((ch) => [ch.id, ch.name]));
      const data: DraftItem[] = (draftsRes.data ?? []).map((row) => ({
        id: row.id,
        channelId: row.channelId ?? null,
        threadParentMessageId: row.threadParentMessageId ?? null,
        content: row.content,
        attachments: row.attachments ?? null,
        channelName: (row.channelId ? nameById.get(row.channelId) : null) ?? null,
        updatedAt: row.updatedAt,
      }));
      return { data };
    },
  });
}

export function useUpsertDraft() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();

  return useMutation({
    // Emulates the old core-api PUT /weldchat/drafts upsert on top of the
    // app-api POST/PATCH/DELETE surface. Drafts are unique per
    // (user, channelId, threadParentMessageId); empty content + no
    // attachments means "delete the draft at this location".
    mutationFn: async (input: UpsertDraftInput) => {
      const client = await getClient();
      const channelId = input.channelId ?? null;
      const threadParentMessageId = input.threadParentMessageId ?? null;
      const isEmpty =
        !input.content.trim() && (!input.attachments || input.attachments.length === 0);

      const matchesLocation = (d: { channelId: string | null; threadParentMessageId: string | null }) =>
        (d.channelId ?? null) === channelId &&
        (d.threadParentMessageId ?? null) === threadParentMessageId;

      const findExistingId = async (skipCache = false): Promise<string | null> => {
        if (!skipCache) {
          const cached = queryClient.getQueryData<{ data: DraftItem[] }>(
            weldchatExtrasKeys.draftsList(),
          );
          const cachedMatch = cached?.data?.find(matchesLocation);
          if (cachedMatch) return cachedMatch.id;
        }
        const qs = new URLSearchParams({ limit: '100' });
        if (channelId) qs.set('channelId', channelId);
        const res = await client.get<ListEnvelope<ChatDraftRow>>(`/chat-drafts?${qs.toString()}`);
        return res.data?.find(matchesLocation)?.id ?? null;
      };

      const existingId = await findExistingId();

      if (isEmpty) {
        if (existingId) await client.delete<void>(`/chat-drafts/${existingId}`);
        return null;
      }

      const body = {
        content: input.content,
        attachments: input.attachments ?? null,
      };

      if (existingId) {
        try {
          return await client.patch<{ data: { id: string } }>(`/chat-drafts/${existingId}`, body);
        } catch (err) {
          // Stale cache: the draft was deleted elsewhere — fall through to create.
          if ((err as { status?: number })?.status !== 404) throw err;
        }
      }

      try {
        return await client.post<{ data: { id: string } }>('/chat-drafts', {
          ...body,
          channelId,
          threadParentMessageId,
        });
      } catch (err) {
        // A concurrent save may have created the draft first (unique per
        // user + channel + thread) — re-check server-side and update instead.
        const retryId = await findExistingId(true);
        if (!retryId) throw err;
        return client.patch<{ data: { id: string } }>(`/chat-drafts/${retryId}`, body);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: weldchatExtrasKeys.draftsList() });
    },
  });
}

export function useDeleteDraft() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.delete<void>(`/chat-drafts/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: weldchatExtrasKeys.draftsList() });
    },
  });
}

// ============================================================================
// Directory hooks
// ============================================================================

function useChannelDirectory(search?: string) {
  const { getClient } = useAppApiClient();

  return useQuery({
    queryKey: weldchatExtrasKeys.directoryChannels(search),
    queryFn: async () => {
      const client = await getClient();
      const qs = search ? `?search=${encodeURIComponent(search)}` : '';
      return client.get<{ data: DirectoryChannelItem[] }>(`/chat-directories/channels${qs}`);
    },
  });
}
