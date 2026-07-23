/**
 * WeldChat Real-time Hook — @weldsuite/realtime
 *
 * Handles real-time events for reactions, pins, member changes,
 * channel updates, read receipts, clip transcripts, and call events
 * via the ChatRoom Durable Object.
 *
 * User-level events (mentions, new DMs, unread) are handled via
 * WorkspaceHub topic subscriptions.
 */

import { useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth, useUser } from '@clerk/clerk-react';
import { weldchatKeys, updateClipTranscriptInCache } from '../queries/use-weldchat-queries';
import { useTopic } from '@weldsuite/realtime/react';
import type { RoomClient } from '@weldsuite/realtime/client';

interface UseWeldChatRealtimeOptions {
  channelId?: string;
  onReactionChanged?: (data: unknown) => void;
}

export function useWeldChatRealtime(
  client: RoomClient | null,
  options: UseWeldChatRealtimeOptions = {},
) {
  const queryClient = useQueryClient();
  const { channelId, onReactionChanged } = options;

  useEffect(() => {
    if (!client || !channelId) return;

    const unsubs: Array<() => void> = [];

    // Reactions
    unsubs.push(
      client.on('reaction', (event) => {
        queryClient.invalidateQueries({ queryKey: weldchatKeys.messages(channelId) });
        onReactionChanged?.(event);
      }),
    );

    // Pins
    unsubs.push(
      client.on('pin', () => {
        queryClient.invalidateQueries({ queryKey: weldchatKeys.pinnedMessages(channelId) });
        queryClient.invalidateQueries({ queryKey: weldchatKeys.messages(channelId) });
      }),
    );

    // Members
    unsubs.push(
      client.on('member', () => {
        queryClient.invalidateQueries({ queryKey: weldchatKeys.members(channelId) });
        queryClient.invalidateQueries({ queryKey: weldchatKeys.channelDetail(channelId) });
      }),
    );

    // Channel metadata
    unsubs.push(
      client.on('channel:updated', () => {
        queryClient.invalidateQueries({ queryKey: weldchatKeys.channels() });
        queryClient.invalidateQueries({ queryKey: weldchatKeys.channelDetail(channelId) });
      }),
    );

    // Read receipts
    unsubs.push(
      client.on('read:updated', () => {
        queryClient.invalidateQueries({ queryKey: weldchatKeys.readReceipts(channelId) });
      }),
    );

    // Clip transcript updates
    unsubs.push(
      client.on('clip:transcript:updated', (event) => {
        updateClipTranscriptInCache(
          queryClient,
          channelId,
          event.messageId,
          event.attachmentId,
          event.transcript,
        );
      }),
    );

    // Call events
    unsubs.push(
      client.on('call', () => {
        queryClient.invalidateQueries({ queryKey: weldchatKeys.activeCall(channelId) });
        queryClient.invalidateQueries({ queryKey: weldchatKeys.messages(channelId) });
      }),
    );

    unsubs.push(
      client.on('call:participant', () => {
        queryClient.invalidateQueries({ queryKey: weldchatKeys.activeCall(channelId) });
      }),
    );

    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [client, channelId, queryClient, onReactionChanged]);
}

/**
 * Hook for user-level chat notifications (mentions, new DMs, unread updates).
 * Uses WorkspaceHub topic subscriptions via the RealtimeProvider.
 */
export function useWeldChatUserEvents() {
  const queryClient = useQueryClient();
  const { user } = useUser();
  const userId = user?.id;

  const handler = useCallback(
    (event: { event: string }) => {
      switch (event.event) {
        case 'channel_new':
          queryClient.invalidateQueries({ queryKey: weldchatKeys.channels() });
          break;
        case 'dm_new':
          queryClient.invalidateQueries({ queryKey: weldchatKeys.dms() });
          break;
        case 'mention':
          queryClient.invalidateQueries({ queryKey: weldchatKeys.channels() });
          break;
        case 'unread_update':
          queryClient.invalidateQueries({ queryKey: weldchatKeys.channels() });
          queryClient.invalidateQueries({ queryKey: weldchatKeys.dms() });
          break;
      }
    },
    [queryClient],
  );

  useTopic(userId ? `chat.user.${userId}` : '', handler);
}
