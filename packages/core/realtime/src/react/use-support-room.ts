import { useEffect, useRef, useState, useCallback } from 'react';
import { RoomClient } from '../client/room-client';
import type {
  ConnectionState,
  PresenceMember,
  TypingUser,
  RoomEvent,
} from '../types';

interface UseSupportRoomConfig {
  /** Base URL for the realtime worker, e.g. wss://realtime.weldsuite.com */
  baseUrl: string;
  /** Returns auth JWT (Clerk token from either platform or admin instance) */
  getToken: () => Promise<string>;
  /** User's display name (passed as query param since Clerk JWTs don't include name by default) */
  userName?: string;
  /** Presence data to send on connect */
  presenceData?: Record<string, unknown>;
}

/**
 * Connect to an enterprise SupportRoom.
 *
 * Used by both the customer's /contact page (platform app)
 * and the admin support inbox (admin app). Both connect to
 * the same room keyed by workspaceId (clerkOrgId).
 *
 * Usage:
 *   const { presence, typingUsers, sendMessage, on } = useSupportRoom(
 *     workspaceId,
 *     { baseUrl: REALTIME_URL, getToken }
 *   );
 */
export function useSupportRoom(workspaceId: string, config: UseSupportRoomConfig) {
  const clientRef = useRef<RoomClient | null>(null);
  const [state, setState] = useState<ConnectionState>('disconnected');
  const [presence, setPresence] = useState<PresenceMember[]>([]);
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);

  useEffect(() => {
    if (!workspaceId) return;

    const wsUrl = new URL(`${config.baseUrl}/ws/support/${workspaceId}`);
    if (config.userName) wsUrl.searchParams.set('userName', config.userName);
    const client = new RoomClient({
      url: wsUrl.toString(),
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
  }, [workspaceId, config.baseUrl]);

  const sendMessage = useCallback(
    (content: string, opts?: { senderAvatar?: string }) => {
      clientRef.current?.sendSupportMessage(content, opts);
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
    presence,
    typingUsers,
    sendMessage,
    startTyping,
    stopTyping,
    on,
  };
}
