/**
 * WeldChat Real-time Hook — @weldsuite/realtime
 *
 * Connects to the ChatRoom Durable Object via RoomClient for live
 * message delivery and typing indicators.
 *
 * Uses a ref for getToken to avoid infinite re-render loops
 * (Clerk's getToken changes reference on every render).
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { AppState } from 'react-native';
import { useAuth } from '@clerk/expo';
import { RoomClient } from '@weldsuite/realtime/client';
import type { TypingUser } from '@weldsuite/realtime/types';
import { getRealtimeBaseUrl } from '@/services/realtime-client';

export function useChatRealtime(channelId: string | null, onUpdate: () => void) {
  const { getToken, userId } = useAuth();

  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  const clientRef = useRef<RoomClient | null>(null);
  const [client, setClient] = useState<RoomClient | null>(null);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);

  useEffect(() => {
    if (!channelId) return;

    let cancelled = false;
    const baseUrl = getRealtimeBaseUrl();

    const rc = new RoomClient({
      url: `${baseUrl}/ws/chat/${channelId}`,
      getToken: async () => (await getTokenRef.current()) || '',
    });
    clientRef.current = rc;

    // Subscribe to messages — call onUpdate so parent can refetch
    const unsubMessage = rc.on('message', () => {
      if (!cancelled) onUpdateRef.current();
    });

    // Catch up after a reconnect. The RoomClient relays live messages but does
    // not replay messages that arrived while the socket was down, so on every
    // reconnect (network blip, app foreground, token refresh) refetch the
    // channel once. We skip the very first 'connected' — the screen already
    // loaded its messages on mount.
    let hasConnected = false;
    const unsubConn = rc.onConnectionChange((state) => {
      if (state !== 'connected' || cancelled) return;
      if (hasConnected) {
        onUpdateRef.current();
      } else {
        hasConnected = true;
      }
    });

    // Subscribe to typing
    const unsubTyping = rc.onTyping((users: TypingUser[]) => {
      if (cancelled) return;
      const currentUserId = userIdRef.current;
      const filtered = users
        .filter((u) => u.userId !== currentUserId)
        .map((u) => u.userId);
      setTypingUsers(filtered);
    });

    rc.connect()
      .then(() => {
        if (!cancelled) setClient(rc);
      })
      .catch((err) => {
        console.warn('[ChatRealtime] Connect failed:', err instanceof Error ? err.message : err);
      });

    // Re-establish the channel socket when the app returns to the foreground —
    // it is suspended/killed in the background. reconnect() no-ops if still
    // OPEN; on an actual reconnect the onConnectionChange handler above refetches.
    const appStateSub = AppState.addEventListener('change', (next) => {
      if (next === 'active' && !cancelled) rc.reconnect();
    });

    return () => {
      cancelled = true;
      appStateSub.remove();
      unsubMessage();
      unsubTyping();
      unsubConn();
      rc.disconnect();
      clientRef.current = null;
      setClient(null);
      setTypingUsers([]);
    };
  }, [channelId]);

  const onKeystroke = useCallback(() => {
    clientRef.current?.startTyping();
  }, []);

  const onSend = useCallback(() => {
    clientRef.current?.stopTyping();
  }, []);

  return { typingUsers, onKeystroke, onSend, client };
}
