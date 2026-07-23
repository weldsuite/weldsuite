import { useEffect, useRef, useState, useCallback } from 'react';
import {
  WhiteboardClient,
  type WhiteboardPresenceMember,
  type WhiteboardCursor,
  type WhiteboardBatchChange,
} from '../client/whiteboard-client';
import type { ConnectionState } from '../types';

export interface UseWhiteboardRoomConfig {
  baseUrl: string;
  getToken: () => Promise<string>;
  userId: string;
  userName: string;
  userAvatar?: string;
  enabled?: boolean;
}

export interface UseWhiteboardRoomReturn {
  isConnected: boolean;
  connectionState: ConnectionState;
  userColor: string;

  remotePresence: WhiteboardPresenceMember[];
  remoteCursors: WhiteboardCursor[];

  broadcastElementAdd: (element: any) => Promise<void>;
  broadcastElementUpdate: (elementId: string, changes: any) => Promise<void>;
  broadcastElementDelete: (elementId: string) => Promise<void>;
  broadcastBatchChange: (batch: WhiteboardBatchChange) => Promise<void>;
  broadcastCursor: (x: number, y: number, tool?: string) => void;
  broadcastSelectionChange: (elementIds: string[]) => Promise<void>;

  onElementAdd: (handler: (element: any, userId: string) => void) => () => void;
  onElementUpdate: (handler: (elementId: string, changes: any, userId: string) => void) => () => void;
  onElementDelete: (handler: (elementId: string, userId: string) => void) => () => void;
  onBatchChange: (handler: (batch: WhiteboardBatchChange & { userId: string }) => void) => () => void;

  disconnect: () => void;
}

/**
 * Connect to a WhiteboardRoom Durable Object.
 *
 * Connects on mount, disconnects on unmount or whiteboardId change.
 * Provides the same interface as the old useWhiteboardCollaboration hook.
 */
export function useWhiteboardRoom(
  whiteboardId: string,
  config: UseWhiteboardRoomConfig,
): UseWhiteboardRoomReturn {
  const { enabled = true } = config;
  const clientRef = useRef<WhiteboardClient | null>(null);
  const [state, setState] = useState<ConnectionState>('disconnected');
  const [presence, setPresence] = useState<WhiteboardPresenceMember[]>([]);
  const [cursors, setCursors] = useState<WhiteboardCursor[]>([]);
  const [userColor, setUserColor] = useState('#FF6B6B');

  useEffect(() => {
    if (!enabled || !whiteboardId || !config.userId || !config.userName) return;

    const client = new WhiteboardClient(whiteboardId, {
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
    client.onCursors(setCursors);
    client.connect();

    return () => {
      client.disconnect();
      clientRef.current = null;
      setPresence([]);
      setCursors([]);
      setState('disconnected');
    };
  }, [whiteboardId, config.baseUrl, config.userId, enabled]);

  // Broadcast methods — these are fine with clientRef since they fire on user actions
  // (the client is always connected by the time the user draws)
  const broadcastElementAdd = useCallback(
    (element: any) => clientRef.current?.broadcastElementAdd(element) ?? Promise.resolve(),
    [],
  );
  const broadcastElementUpdate = useCallback(
    (elementId: string, changes: any) => clientRef.current?.broadcastElementUpdate(elementId, changes) ?? Promise.resolve(),
    [],
  );
  const broadcastElementDelete = useCallback(
    (elementId: string) => clientRef.current?.broadcastElementDelete(elementId) ?? Promise.resolve(),
    [],
  );
  const broadcastBatchChange = useCallback(
    (batch: WhiteboardBatchChange) => clientRef.current?.broadcastBatchChange(batch) ?? Promise.resolve(),
    [],
  );
  const broadcastCursor = useCallback(
    (x: number, y: number, tool?: string) => clientRef.current?.broadcastCursor(x, y, tool),
    [],
  );
  const broadcastSelectionChange = useCallback(
    (elementIds: string[]) => clientRef.current?.broadcastSelectionChange(elementIds) ?? Promise.resolve(),
    [],
  );

  // Event handlers — these need to register on the CURRENT client, not a stale ref.
  // We return a function that lazily registers on clientRef.current so it works
  // even when called before the client connects (the consumer's useEffect
  // re-runs when isConnected changes, at which point clientRef.current is set).
  const onElementAdd = useCallback(
    (handler: (element: any, userId: string) => void) => {
      return clientRef.current?.onElementAdd(handler) ?? (() => {});
    },
    // Re-create when state changes to 'connected' so consumers re-register
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state],
  );
  const onElementUpdate = useCallback(
    (handler: (elementId: string, changes: any, userId: string) => void) => {
      return clientRef.current?.onElementUpdate(handler) ?? (() => {});
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state],
  );
  const onElementDelete = useCallback(
    (handler: (elementId: string, userId: string) => void) => {
      return clientRef.current?.onElementDelete(handler) ?? (() => {});
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state],
  );
  const onBatchChange = useCallback(
    (handler: (batch: WhiteboardBatchChange & { userId: string }) => void) => {
      return clientRef.current?.onBatchChange(handler) ?? (() => {});
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
    remoteCursors: cursors,
    broadcastElementAdd,
    broadcastElementUpdate,
    broadcastElementDelete,
    broadcastBatchChange,
    broadcastCursor,
    broadcastSelectionChange,
    onElementAdd,
    onElementUpdate,
    onElementDelete,
    onBatchChange,
    disconnect,
  };
}
