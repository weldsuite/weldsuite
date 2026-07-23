/**
 * Meeting Chat TanStack Query Hooks
 *
 * Query hooks for meeting-specific chat (decoupled from WeldChat).
 * Messages are stored in meeting_messages, not chat_messages.
 */

import { useQuery, useMutation, useQueryClient, useInfiniteQuery, type QueryClient } from '@tanstack/react-query';
import { useAuth, useUser } from '@clerk/clerk-react';
import { useAppApiClient } from '@/lib/api/use-app-api';

// ============================================================================
// Query Key Factory
// ============================================================================

export const meetingChatKeys = {
  all: ['meeting-chat'] as const,
  messages: (meetingId: string) => [...meetingChatKeys.all, 'messages', meetingId] as const,
  pinned: (meetingId: string) => [...meetingChatKeys.all, 'pinned', meetingId] as const,
};

// ============================================================================
// Real-Time Cache Merge Utilities
// ============================================================================

/**
 * Insert a new real-time message into the infinite query cache.
 * Deduplicates by id (replaces optimistic messages).
 */
export function mergeMeetingMessageIntoCache(
  queryClient: QueryClient,
  meetingId: string,
  message: Record<string, unknown>,
) {
  queryClient.setQueryData(meetingChatKeys.messages(meetingId), (old: any) => {
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
 * Remove a message from the infinite query cache.
 */
export function removeMeetingMessageFromCache(
  queryClient: QueryClient,
  meetingId: string,
  messageId: string,
) {
  queryClient.setQueryData(meetingChatKeys.messages(meetingId), (old: any) => {
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
// Message Queries
// ============================================================================

export function useMeetingMessages(meetingId: string) {
  const { getClient } = useAppApiClient();
  return useInfiniteQuery({
    queryKey: meetingChatKeys.messages(meetingId),
    queryFn: async ({ pageParam }) => {
      const client = await getClient();
      const qs = new URLSearchParams();
      qs.set('meetingId', meetingId);
      if (pageParam) qs.set('before', pageParam);
      qs.set('limit', '50');
      // app-api returns { data: { messages, hasMore, nextCursor } }
      return client.get<any>(`/meeting-messages?${qs.toString()}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: any) => {
      const inner = lastPage?.data;
      if (!inner?.messages?.length || !inner.hasMore) return undefined;
      return inner.nextCursor ?? undefined;
    },
    enabled: !!meetingId,
  });
}

// ============================================================================
// Mutations
// ============================================================================

interface SendMeetingMessageVars {
  meetingId: string;
  content: string;
  /** Sanitized rich-text HTML from the formatting toolbar (optional). */
  htmlContent?: string;
  attachments?: Array<{
    id: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    url: string;
  }>;
  _optimisticId?: string;
}

export function useSendMeetingMessage() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();
  const { userId } = useAuth();
  const { user } = useUser();

  return useMutation({
    mutationFn: async ({ meetingId, _optimisticId, ...data }: SendMeetingMessageVars) => {
      const client = await getClient();
      // app-api: POST /meeting-messages with body { meetingId, content, htmlContent?, attachments? }
      return client.post<any>('/meeting-messages', { meetingId, ...data });
    },
    onMutate: async (variables) => {
      const { meetingId, _optimisticId } = variables;
      if (!_optimisticId || !userId) return;

      await queryClient.cancelQueries({ queryKey: meetingChatKeys.messages(meetingId) });

      const optimisticMessage = {
        id: _optimisticId,
        meetingId,
        content: variables.content,
        htmlContent: variables.htmlContent,
        authorId: userId,
        authorName: user?.fullName || user?.firstName || 'You',
        authorAvatar: user?.imageUrl || null,
        type: 'message',
        attachments: variables.attachments,
        hasAttachments: !!(variables.attachments?.length),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        _optimistic: true,
      };

      queryClient.setQueryData(meetingChatKeys.messages(meetingId), (old: any) => {
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
    onError: (_error, variables) => {
      if (variables._optimisticId) {
        queryClient.setQueryData(meetingChatKeys.messages(variables.meetingId), (old: any) => {
          if (!old?.pages) return old;
          return {
            ...old,
            pages: old.pages.map((p: any) => ({
              ...p,
              data: {
                ...p.data,
                messages: p.data?.messages?.filter((m: any) => m.id !== variables._optimisticId),
              },
            })),
          };
        });
      }
    },
  });
}

// ============================================================================
// Pinned Messages
// ============================================================================

export function usePinnedMeetingMessages(meetingId: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: meetingChatKeys.pinned(meetingId),
    queryFn: async () => {
      const client = await getClient();
      // app-api returns { data: { messages: [...] } }
      return client.get<any>(`/meeting-messages/pinned?meetingId=${encodeURIComponent(meetingId)}`);
    },
    enabled: !!meetingId,
  });
}

export function usePinMeetingMessage() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();

  return useMutation({
    mutationFn: async ({ meetingId, messageId }: { meetingId: string; messageId: string }) => {
      const client = await getClient();
      return client.post<any>(`/meeting-messages/${messageId}/pin`, {});
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: meetingChatKeys.pinned(variables.meetingId) });
      queryClient.invalidateQueries({ queryKey: meetingChatKeys.messages(variables.meetingId) });
    },
  });
}

export function useUnpinMeetingMessage() {
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();

  return useMutation({
    mutationFn: async ({ meetingId, messageId }: { meetingId: string; messageId: string }) => {
      const client = await getClient();
      return client.delete<any>(`/meeting-messages/${messageId}/pin`);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: meetingChatKeys.pinned(variables.meetingId) });
      queryClient.invalidateQueries({ queryKey: meetingChatKeys.messages(variables.meetingId) });
    },
  });
}
