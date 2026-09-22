/**
 * useInboxRealtime — workspace-hub inbox events for the agent list.
 *
 * Dual-listens:
 * 1. Legacy topic `helpdesk` with underscore event names (`conversation_new`,
 *    `message_new`, …) still published by mail-inbound / workflows via
 *    `RealtimePublisher.helpdeskEvent`.
 * 2. Hub entity topics from `publishEntityEvent` / `publishDeskInbound`:
 *    `desk_conversation`, `desk_message`, `helpdesk_conversation`,
 *    `helpdesk_conversation_message`.
 *
 * Matches platform `useHelpdeskWebSocket` (subscribe to topic, branch on
 * `event.event`) — never `client.on('helpdesk.conversation_new')`, which
 * does not match hub topic `helpdesk`.
 *
 * The open thread is kept live by `useDeskConversationLive`.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useWorkspaceClientMaybe } from '@weldsuite/realtime/react';
import type { ConnectionState as RTConnectionState, WorkspaceEvent } from '@weldsuite/realtime/types';
import {
  INBOX_HUB_TOPICS,
  dispatchInboxRealtimeEvent,
  type InboxConversation,
  type InboxNewMessageEvent,
  type InboxRealtimeHandlers,
} from './inbox-realtime-dispatch';

export type ConnectionState = RTConnectionState;
export type { InboxConversation, InboxNewMessageEvent };
export { dispatchInboxRealtimeEvent, INBOX_HUB_TOPICS };

interface UseInboxRealtimeOptions extends InboxRealtimeHandlers {
  agentId: string;
  agentName: string;
  agentEmail?: string;
  agentAvatar?: string;
  onConnectionStateChange?: (state: ConnectionState) => void;
  autoConnect?: boolean;
}

interface UseInboxRealtimeReturn {
  isConnected: boolean;
  connectionState: ConnectionState;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  error: Error | null;
}

export function useInboxRealtime(options: UseInboxRealtimeOptions): UseInboxRealtimeReturn {
  const { autoConnect = true } = options;
  const client = useWorkspaceClientMaybe();
  const [isConnected, setIsConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [error, setError] = useState<Error | null>(null);

  const handlersRef = useRef<InboxRealtimeHandlers>(options);
  const onConnChangeRef = useRef(options.onConnectionStateChange);
  useEffect(() => {
    handlersRef.current = options;
    onConnChangeRef.current = options.onConnectionStateChange;
  });

  useEffect(() => {
    if (!client || !autoConnect) return;

    const offs = INBOX_HUB_TOPICS.map((topic) =>
      client.on(topic, (event: WorkspaceEvent) => {
        dispatchInboxRealtimeEvent(
          event.topic || topic,
          event.event,
          event.data,
          handlersRef.current,
        );
      }),
    );

    const offConn = client.onConnectionChange((state) => {
      setConnectionState(state);
      setIsConnected(state === 'connected');
      onConnChangeRef.current?.(state);
    });

    setIsConnected(true);

    return () => {
      for (const off of offs) off();
      offConn();
    };
  }, [client, autoConnect]);

  const connect = useCallback(async () => {
    setError(null);
  }, []);

  const disconnect = useCallback(async () => {}, []);

  return { isConnected, connectionState, connect, disconnect, error };
}
