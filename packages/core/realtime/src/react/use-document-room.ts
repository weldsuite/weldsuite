import { useEffect, useRef, useState, useCallback } from 'react';
import {
  DocumentClient,
  type DocumentPresenceMember,
} from '../client/document-client';
import type { ConnectionState } from '../types';

export interface UseDocumentRoomConfig {
  baseUrl: string;
  getToken: () => Promise<string>;
  userId: string;
  userName: string;
  userAvatar?: string;
  enabled?: boolean;
}

export interface UseDocumentRoomReturn {
  isConnected: boolean;
  connectionState: ConnectionState;
  userColor: string;

  remotePresence: DocumentPresenceMember[];

  broadcastContentUpdate: (content: string) => void;
  broadcastTitleUpdate: (title: string) => void;

  onContentUpdate: (handler: (content: string, userId: string) => void) => () => void;
  onTitleUpdate: (handler: (title: string, userId: string) => void) => () => void;

  disconnect: () => void;
}

/**
 * Connect to a DocumentRoom Durable Object.
 *
 * Connects on mount, disconnects on unmount or documentId change.
 * Provides real-time content sync, title sync, and presence.
 */
export function useDocumentRoom(
  documentId: string,
  config: UseDocumentRoomConfig,
): UseDocumentRoomReturn {
  const { enabled = true } = config;
  const clientRef = useRef<DocumentClient | null>(null);
  const [state, setState] = useState<ConnectionState>('disconnected');
  const [presence, setPresence] = useState<DocumentPresenceMember[]>([]);
  const [userColor, setUserColor] = useState('#FF6B6B');

  useEffect(() => {
    if (!enabled || !documentId || !config.userId || !config.userName) return;

    const client = new DocumentClient(documentId, {
      baseUrl: config.baseUrl,
      getToken: config.getToken,
      userId: config.userId,
      userName: config.userName,
      userAvatar: config.userAvatar,
    });
    clientRef.current = client;
    setUserColor(client.userColor);

    client.onConnectionChange(setState);
    client.onPresence(setPresence);
    client.connect();

    return () => {
      client.disconnect();
      clientRef.current = null;
      setPresence([]);
      setState('disconnected');
    };
  }, [documentId, config.baseUrl, config.userId, enabled]);

  const broadcastContentUpdate = useCallback(
    (content: string) => clientRef.current?.broadcastContentUpdate(content),
    [],
  );

  const broadcastTitleUpdate = useCallback(
    (title: string) => clientRef.current?.broadcastTitleUpdate(title),
    [],
  );

  const onContentUpdate = useCallback(
    (handler: (content: string, userId: string) => void) => {
      return clientRef.current?.onContentUpdate(handler) ?? (() => {});
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state],
  );

  const onTitleUpdate = useCallback(
    (handler: (title: string, userId: string) => void) => {
      return clientRef.current?.onTitleUpdate(handler) ?? (() => {});
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state],
  );

  const disconnect = useCallback(() => clientRef.current?.disconnect(), []);

  return {
    isConnected: state === 'connected',
    connectionState: state,
    userColor,
    remotePresence: presence,
    broadcastContentUpdate,
    broadcastTitleUpdate,
    onContentUpdate,
    onTitleUpdate,
    disconnect,
  };
}
