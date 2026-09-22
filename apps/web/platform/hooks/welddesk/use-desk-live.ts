/**
 * Live WeldDesk inbox.
 *
 * - `useDeskInboxLive` listens to the WorkspaceHub `desk_conversation` and
 *   `desk_message` topics (published by helpdesk-widget-api and app-api) and
 *   patches the React Query caches in place, so the list re-sorts and the open
 *   thread grows without refetching on every event.
 * - `useDeskConversationRoom` joins the conversation's realtime room for the
 *   things that are only interesting while a thread is open: the visitor
 *   typing, whether the visitor is online, and our own typing signal.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { RoomClient } from '@weldsuite/realtime/client';
import { useTopic } from '@weldsuite/realtime/react';
import type { ConnectionState, PresenceMember, TypingUser } from '@weldsuite/realtime/types';
import { getRealtimeWsOrigin } from '@/lib/api/public-env';
import {
  deskKeys,
  type DeskConversation,
  type DeskListPagination,
  type DeskMessage,
} from '@/hooks/queries/use-desk-queries';

type DetailData = { data: DeskConversation & { messages: DeskMessage[] } };
type ListPage = { data: DeskConversation[]; pagination: DeskListPagination };

const LIST_REFRESH_DEBOUNCE_MS = 350;
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

function sortByCreatedAt(messages: DeskMessage[]): DeskMessage[] {
  return [...messages].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

/**
 * Merge a message into a thread. Replaces an optimistic twin (same clientId)
 * or an existing copy (same id); otherwise appends in time order.
 */
export function mergeDeskMessage(messages: DeskMessage[], incoming: DeskMessage): DeskMessage[] {
  const clientId =
    typeof incoming.metadata?.clientId === 'string' ? incoming.metadata.clientId : null;
  const index = messages.findIndex(
    (m) => m.id === incoming.id || (clientId !== null && m.clientId === clientId),
  );
  if (index >= 0) {
    const next = [...messages];
    next[index] = { ...incoming, pending: undefined, clientId: messages[index].clientId };
    return next;
  }
  return sortByCreatedAt([...messages, incoming]);
}

export function patchDeskConversationDetail(
  qc: QueryClient,
  conversationId: string,
  patch: (current: DetailData['data']) => DetailData['data'],
) {
  qc.setQueryData<DetailData>(deskKeys.conversationDetail(conversationId), (old) =>
    old?.data ? { ...old, data: patch(old.data) } : old,
  );
}

export function upsertDeskConversation(qc: QueryClient, conversation: DeskConversation) {
  patchDeskConversationDetail(qc, conversation.id, (current) => ({
    ...current,
    ...conversation,
    messages: current.messages,
  }));
  qc.setQueriesData<InfiniteData<ListPage>>(
    { queryKey: [...deskKeys.conversations(), 'list'] },
    (old) => {
      if (!old?.pages) return old;
      let changed = false;
      const pages = old.pages.map((page) => ({
        ...page,
        data: page.data.map((row) => {
          if (row.id !== conversation.id) return row;
          changed = true;
          return { ...row, ...conversation };
        }),
      }));
      return changed ? { ...old, pages } : old;
    },
  );
}

export function appendDeskMessage(qc: QueryClient, message: DeskMessage) {
  patchDeskConversationDetail(qc, message.conversationId, (current) => ({
    ...current,
    messages: mergeDeskMessage(current.messages ?? [], message),
  }));
}

/** Mount once per inbox. Keeps the list and the open thread live. */
export function useDeskInboxLive() {
  const qc = useQueryClient();
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Patching in place gives an instant preview update; a debounced refetch
  // then fixes ordering, filters (open/closed, mine, unassigned) and brand-new
  // conversations without us re-implementing server-side filtering here.
  const scheduleListRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void qc.invalidateQueries({ queryKey: [...deskKeys.conversations(), 'list'] });
    }, LIST_REFRESH_DEBOUNCE_MS);
  }, [qc]);

  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );

  useTopic('desk_conversation', (event) => {
    if (!isConversation(event.data)) return;
    upsertDeskConversation(qc, event.data);
    scheduleListRefresh();
  });

  useTopic('desk_message', (event) => {
    if (!isMessage(event.data)) return;
    appendDeskMessage(qc, event.data);
  });
}

export interface DeskConversationRoom {
  /** Names of visitors currently typing. */
  typing: string[];
  visitorOnline: boolean;
  connectionState: ConnectionState;
  /** Call on every keystroke; throttled internally. */
  notifyTyping: () => void;
  stopTyping: () => void;
}

function isVisitorId(userId: string): boolean {
  return userId.startsWith('visitor:');
}

export function useDeskConversationRoom(conversationId: string | undefined): DeskConversationRoom {
  const { getToken } = useAuth();
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  const clientRef = useRef<RoomClient | null>(null);
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);
  const [presence, setPresence] = useState<PresenceMember[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const lastTypingSent = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!conversationId) return;
    const client = new RoomClient({
      url: `${getRealtimeWsOrigin()}/ws/conversation/${conversationId}`,
      getToken: async () => (await getTokenRef.current()) || '',
    });
    clientRef.current = client;
    const offTyping = client.onTyping(setTypingUsers);
    const offPresence = client.onPresence(setPresence);
    const offState = client.onConnectionChange(setConnectionState);
    void client.connect().then(() => client.enterPresence({ role: 'agent' }));

    return () => {
      offTyping();
      offPresence();
      offState();
      client.disconnect();
      clientRef.current = null;
      lastTypingSent.current = 0;
      if (idleTimer.current) clearTimeout(idleTimer.current);
      setTypingUsers([]);
      setPresence([]);
      setConnectionState('disconnected');
    };
  }, [conversationId]);

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

  return { typing, visitorOnline, connectionState, notifyTyping, stopTyping };
}
