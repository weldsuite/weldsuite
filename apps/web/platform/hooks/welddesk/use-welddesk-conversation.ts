/**
 * useWeldDeskConversation — TanStack Query for conversation metadata.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { ClientApi } from '@weldsuite/api-client/types';
import { weldDeskKeys } from './keys';
import * as api from './api';
import type { WeldDeskConversation, ConversationUpdate } from './api';

interface UseWeldDeskConversationOptions {
  conversationId: string;
  getClient: () => Promise<ClientApi>;
}

export function useWeldDeskConversation({
  conversationId,
  getClient,
}: UseWeldDeskConversationOptions) {
  const queryClient = useQueryClient();

  const conversationQuery = useQuery({
    queryKey: weldDeskKeys.conversation(conversationId),
    queryFn: async () => {
      const client = await getClient();
      return api.fetchConversation(client, conversationId);
    },
    staleTime: 30_000,
    enabled: !!conversationId,
  });

  const updateConversation = useCallback(
    async (fields: Partial<ConversationUpdate>) => {
      const client = await getClient();
      await api.updateConversation(client, conversationId, fields);
      queryClient.invalidateQueries({ queryKey: weldDeskKeys.conversation(conversationId) });
    },
    [conversationId, getClient, queryClient],
  );

  const closeConversation = useCallback(
    async (reason?: string) => {
      const client = await getClient();
      await api.closeConversation(client, conversationId, reason);
      queryClient.setQueryData(
        weldDeskKeys.conversation(conversationId),
        (old: WeldDeskConversation | undefined) =>
          old ? { ...old, status: 'closed' } : old,
      );
    },
    [conversationId, getClient, queryClient],
  );

  const reopenConversation = useCallback(
    async () => {
      const client = await getClient();
      await api.reopenConversation(client, conversationId);
      queryClient.setQueryData(
        weldDeskKeys.conversation(conversationId),
        (old: WeldDeskConversation | undefined) =>
          old ? { ...old, status: 'active' } : old,
      );
    },
    [conversationId, getClient, queryClient],
  );

  // Allow real-time events to update conversation cache
  const patchConversation = useCallback(
    (patch: Partial<WeldDeskConversation>) => {
      queryClient.setQueryData(
        weldDeskKeys.conversation(conversationId),
        (old: WeldDeskConversation | undefined) =>
          old ? { ...old, ...patch } : old,
      );
    },
    [conversationId, queryClient],
  );

  const invalidateConversation = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: weldDeskKeys.conversation(conversationId) });
  }, [conversationId, queryClient]);

  return {
    conversation: conversationQuery.data ?? null,
    isLoadingConversation: conversationQuery.isLoading,
    updateConversation,
    closeConversation,
    reopenConversation,
    patchConversation,
    invalidateConversation,
  };
}
