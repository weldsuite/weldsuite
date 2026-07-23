/**
 * useWeldDeskMessages — TanStack Query for message list + send mutation with optimistic updates.
 */

import { useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ClientApi } from '@weldsuite/api-client/types';
import type { WeldDeskMessage, SendMessageParams } from './types';
import { weldDeskKeys } from './keys';
import * as api from './api';

interface UseWeldDeskMessagesOptions {
  conversationId: string;
  role: 'agent' | 'customer';
  userId: string;
  userName?: string;
  getClient: () => Promise<ClientApi>;
}

export function useWeldDeskMessages({
  conversationId,
  role,
  userId,
  userName,
  getClient,
}: UseWeldDeskMessagesOptions) {
  const queryClient = useQueryClient();

  // Fetch messages
  const messagesQuery = useQuery({
    queryKey: weldDeskKeys.messages(conversationId),
    queryFn: async () => {
      const client = await getClient();
      return api.fetchMessages(client, conversationId);
    },
    staleTime: 30_000,
    enabled: !!conversationId,
  });

  // Send message mutation with optimistic update
  const sendMutation = useMutation({
    mutationFn: async (params: SendMessageParams & { isInternal?: boolean }) => {
      const client = await getClient();
      return api.sendMessage(client, conversationId, {
        ...params,
        authorName: userName,
      });
    },
    onMutate: async (params) => {
      await queryClient.cancelQueries({ queryKey: weldDeskKeys.messages(conversationId) });

      const previous = queryClient.getQueryData(weldDeskKeys.messages(conversationId));

      const optimistic: WeldDeskMessage = {
        id: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        conversationId,
        content: params.content,
        htmlContent: params.htmlContent,
        authorType: role === 'agent' ? 'agent' : 'customer',
        authorId: userId,
        authorName: userName,
        type: params.isInternal ? 'note' : 'message',
        isInternal: params.isInternal ?? false,
        isPublic: !params.isInternal,
        isRead: true,
        attachments: params.attachments,
        blocks: params.blocks,
        createdAt: new Date().toISOString(),
        isPending: true,
      };

      queryClient.setQueryData(
        weldDeskKeys.messages(conversationId),
        (old: { data: WeldDeskMessage[]; hasMore: boolean } | undefined) => ({
          data: [...(old?.data || []), optimistic],
          hasMore: old?.hasMore ?? false,
        }),
      );

      return { previous, optimisticId: optimistic.id };
    },
    onSuccess: (real, _params, context) => {
      // Replace optimistic with real message
      queryClient.setQueryData(
        weldDeskKeys.messages(conversationId),
        (old: { data: WeldDeskMessage[]; hasMore: boolean } | undefined) => ({
          data: (old?.data || []).map((m) =>
            m.id === context?.optimisticId ? { ...real, isPending: false } : m,
          ),
          hasMore: old?.hasMore ?? false,
        }),
      );
    },
    onError: (_err, _params, context) => {
      if (context?.previous) {
        queryClient.setQueryData(weldDeskKeys.messages(conversationId), context.previous);
      }
    },
  });

  // Merge an incoming real-time message into the query cache
  const mergeMessage = useCallback(
    (message: WeldDeskMessage) => {
      queryClient.setQueryData(
        weldDeskKeys.messages(conversationId),
        (old: { data: WeldDeskMessage[]; hasMore: boolean } | undefined) => {
          const existing = old?.data || [];
          // Skip if already in cache (our own message or duplicate)
          if (existing.some((m) => m.id === message.id)) return old ?? { data: [], hasMore: false };
          return {
            data: [...existing, message],
            hasMore: old?.hasMore ?? false,
          };
        },
      );
    },
    [conversationId, queryClient],
  );

  // Update a message in cache (e.g., after block response)
  const updateMessageInCache = useCallback(
    (messageId: string, updates: Partial<WeldDeskMessage>) => {
      queryClient.setQueryData(
        weldDeskKeys.messages(conversationId),
        (old: { data: WeldDeskMessage[]; hasMore: boolean } | undefined) => {
          if (!old) return old;
          return {
            ...old,
            data: old.data.map((m) => (m.id === messageId ? { ...m, ...updates } : m)),
          };
        },
      );
    },
    [conversationId, queryClient],
  );

  return {
    messages: messagesQuery.data?.data ?? [],
    isLoadingMessages: messagesQuery.isLoading,
    hasMoreMessages: messagesQuery.data?.hasMore ?? false,
    sendMutation,
    mergeMessage,
    updateMessageInCache,
  };
}
