import { useEffect, useRef, useState, useCallback } from 'react';
import { RoomClient } from '../client/room-client';
import type {
  ConnectionState,
  PresenceMember,
  TypingUser,
  Attachment,
  RoomEvent,
} from '../types';

interface UseChatRoomConfig {
  /** Base URL for the realtime worker, e.g. wss://realtime.weldsuite.com */
  baseUrl: string;
  /** Returns Clerk JWT */
  getToken: () => Promise<string>;
  /** Presence data to send on connect (name, avatar, status) */
  presenceData?: Record<string, unknown>;
}

/**
 * Connect to a WeldChat ChatRoom.
 *
 * Connects when mounted, disconnects when unmounted or channelId changes.
 * Provides presence, typing, and publishing functions.
 *
 * Usage:
 *   const { presence, typingUsers, sendMessage, addReaction, on } = useChatRoom(
 *     channelId,
 *     { baseUrl: REALTIME_URL, getToken }
 *   );
 */
export function useChatRoom(channelId: string, config: UseChatRoomConfig) {
  const clientRef = useRef<RoomClient | null>(null);
  const [state, setState] = useState<ConnectionState>('disconnected');
  const [presence, setPresence] = useState<PresenceMember[]>([]);
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);

  useEffect(() => {
    const client = new RoomClient({
      url: `${config.baseUrl}/ws/chat/${channelId}`,
      getToken: config.getToken,
    });
    clientRef.current = client;

    client.onConnectionChange(setState);
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
      setPresence([]);
      setTypingUsers([]);
      setState('disconnected');
    };
  }, [channelId, config.baseUrl]);

  const sendMessage = useCallback(
    (content: string, opts?: { threadId?: string; attachments?: Attachment[] }) => {
      clientRef.current?.sendChatMessage(content, opts);
    },
    [],
  );

  const addReaction = useCallback(
    (messageId: string, emoji: string) => clientRef.current?.addReaction(messageId, emoji),
    [],
  );

  const removeReaction = useCallback(
    (messageId: string, emoji: string) => clientRef.current?.removeReaction(messageId, emoji),
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
    presence,
    typingUsers,
    sendMessage,
    addReaction,
    removeReaction,
    startTyping,
    stopTyping,
    on,
  };
}
