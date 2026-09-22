/**
 * Live open thread — mobile twin of the platform's `use-desk-live.ts`.
 *
 * - WorkspaceHub `desk_message` / `desk_conversation` (published by app-api and
 *   helpdesk-widget-api with the full records) grow the thread and update its
 *   state in place. Notes arrive here too; they never reach the visitor room.
 * - The conversation's ConversationRoom is joined only for what matters while
 *   the thread is open: the visitor typing, visitor presence, and our own
 *   typing signal.
 * - Coming back from the background reconnects the room and calls `onResume`
 *   so the screen can refetch whatever the hub delivered while we were away.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { RoomClient } from '@weldsuite/realtime/client';
import { useTopic } from '@weldsuite/realtime/react';
import type { PresenceMember, TypingUser } from '@weldsuite/realtime/types';

import type { DeskConversation, DeskMessage } from '@/types/desk';

const REALTIME_URL = process.env.EXPO_PUBLIC_REALTIME_URL || 'ws://localhost:8790';

const TYPING_REPEAT_MS = 3_000;
const TYPING_IDLE_MS = 4_000;

function isConversation(value: unknown): value is DeskConversation {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { conversationNumber?: unknown }).conversationNumber === 'number'
  );
}

function isMessage(value: unknown): value is DeskMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { conversationId?: unknown }).conversationId === 'string' &&
    typeof (value as { kind?: unknown }).kind === 'string'
  );
}

function isVisitorId(userId: string): boolean {
  return userId.startsWith('visitor:');
}

/** Insert or replace a message by id, keeping the thread in time order. */
export function mergeDeskMessage(messages: DeskMessage[], incoming: DeskMessage): DeskMessage[] {
  const index = messages.findIndex((m) => m.id === incoming.id);
  if (index >= 0) {
    const next = [...messages];
    next[index] = incoming;
    return next;
  }
  return [...messages, incoming].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

interface UseDeskConversationLiveOptions {
  conversationId: string | undefined;
  onMessage: (message: DeskMessage) => void;
  onConversation: (conversation: DeskConversation) => void;
  onResume: () => void;
}

export interface DeskConversationLive {
  /** Names of visitors currently typing. */
  typing: string[];
  visitorOnline: boolean;
  /** Call on every keystroke; throttled internally. */
  notifyTyping: () => void;
  stopTyping: () => void;
}

export function useDeskConversationLive({
  conversationId,
  onMessage,
  onConversation,
  onResume,
}: UseDeskConversationLiveOptions): DeskConversationLive {
  const { getToken } = useClerkAuth();
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const handlersRef = useRef({ onMessage, onConversation, onResume });
  handlersRef.current = { onMessage, onConversation, onResume };

  const clientRef = useRef<RoomClient | null>(null);
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);
  const [presence, setPresence] = useState<PresenceMember[]>([]);
  const lastTypingSent = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useTopic('desk_message', (event) => {
    if (!isMessage(event.data) || event.data.conversationId !== conversationId) return;
    handlersRef.current.onMessage(event.data);
  });

  useTopic('desk_conversation', (event) => {
    if (!isConversation(event.data) || event.data.id !== conversationId) return;
    handlersRef.current.onConversation(event.data);
  });

  useEffect(() => {
    if (!conversationId) return;
    const client = new RoomClient({
      url: `${REALTIME_URL}/ws/conversation/${conversationId}`,
      getToken: async () => (await getTokenRef.current()) || '',
    });
    clientRef.current = client;
    const offTyping = client.onTyping(setTypingUsers);
    const offPresence = client.onPresence(setPresence);
    client
      .connect()
      .then(() => client.enterPresence({ role: 'agent' }))
      .catch(() => {
        // Typing/presence are a nicety; the hub still keeps the thread live.
      });

    return () => {
      offTyping();
      offPresence();
      client.disconnect();
      clientRef.current = null;
      lastTypingSent.current = 0;
      if (idleTimer.current) clearTimeout(idleTimer.current);
      setTypingUsers([]);
      setPresence([]);
    };
  }, [conversationId]);

  // Sockets die in the background; catch up when the agent comes back.
  useEffect(() => {
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', (next) => {
      if (previous !== 'active' && next === 'active') {
        clientRef.current?.reconnect();
        handlersRef.current.onResume();
      }
      previous = next;
    });
    return () => subscription.remove();
  }, []);

  const stopTyping = useCallback(() => {
    if (idleTimer.current) {
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
    if (lastTypingSent.current === 0) return;
    lastTypingSent.current = 0;
    clientRef.current?.stopTyping();
  }, []);

  const notifyTyping = useCallback(() => {
    const client = clientRef.current;
    if (!client?.isConnected) return;
    const now = Date.now();
    if (now - lastTypingSent.current > TYPING_REPEAT_MS) {
      lastTypingSent.current = now;
      client.startTyping();
    }
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(stopTyping, TYPING_IDLE_MS);
  }, [stopTyping]);

  const typing = useMemo(
    () => typingUsers.filter((u) => isVisitorId(u.userId)).map((u) => u.userName),
    [typingUsers],
  );
  const visitorOnline = presence.some((m) => isVisitorId(m.userId));

  return { typing, visitorOnline, notifyTyping, stopTyping };
}
