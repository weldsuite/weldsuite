import { useEffect, useRef, useState, useCallback } from 'react';
import { RoomClient } from '../client/room-client';
import type {
  ConnectionState,
  RoomMessage,
  PresenceMember,
  TypingUser,
  Attachment,
  RoomEvent,
} from '../types';

interface UseConversationConfig {
  /** Base URL for the realtime worker, e.g. wss://realtime.weldsuite.com */
  baseUrl: string;
  /** Returns auth token (Clerk JWT or widget token) */
  getToken: () => Promise<string>;
  /** Presence data to send on connect (name, role, avatar) */
  presenceData?: Record<string, unknown>;
}

/**
 * Connect to a helpdesk ConversationRoom.
 *
 * Connects when mounted, disconnects when unmounted or conversationId changes.
 * Provides messages, presence, typing, and send functions.
 *
 * Usage:
 *   const { messages, presence, typingUsers, sendMessage, on } = useConversation(
 *     conversationId,
 *     { baseUrl: REALTIME_URL, getToken }
 *   );
 */
export function useConversation(conversationId: string, config: UseConversationConfig) {
  const clientRef = useRef<RoomClient | null>(null);
  const [state, setState] = useState<ConnectionState>('disconnected');
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [presence, setPresence] = useState<PresenceMember[]>([]);
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);

  useEffect(() => {
    const client = new RoomClient({
      url: `${config.baseUrl}/ws/conversation/${conversationId}`,
      getToken: config.getToken,
    });
    clientRef.current = client;

    client.onConnectionChange(setState);
    client.on('message', (msg) => {
      setMessages((prev) => [...prev, msg as RoomMessage]);
    });
    client.onPresence(setPresence);
    client.onTyping(setTypingUsers);

    client.connect().then(() => {
      if (config.presenceData) {
        client.enterPresence(config.presenceData);
      }
    });

    return () => {
      client.disconnect();
      clientRef.current = null;
      setMessages([]);
      setPresence([]);
      setTypingUsers([]);
      setState('disconnected');
    };
  }, [conversationId, config.baseUrl]);

  const sendMessage = useCallback(
    (content: string, attachments?: Attachment[]) => {
      clientRef.current?.sendMessage(content, attachments);
    },
    [],
  );

  const startTyping = useCallback(() => clientRef.current?.startTyping(), []);
  const stopTyping = useCallback(() => clientRef.current?.stopTyping(), []);

  const on = useCallback(
    <T extends RoomEvent['type']>(
      type: T,
      handler: (event: Extract<RoomEvent, { type: T }>) => void,
    ) => {
      return clientRef.current?.on(type, handler) ?? (() => {});
    },
    [],
  );

  return {
    state,
    isConnected: state === 'connected',
    messages,
    presence,
    typingUsers,
    sendMessage,
    startTyping,
    stopTyping,
    on,
  };
}
