/**
 * React Hook for Whiteboard Collaboration
 *
 * Delegates to the Cloudflare Durable Object-based WhiteboardRoom
 * via @weldsuite/realtime.
 */

import { useCallback, useMemo } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useWhiteboardRoom } from '@weldsuite/realtime/react';
import type { WhiteboardPresence, BatchChange } from '@/lib/realtime/whiteboard/types';
import { PRESENCE_COLORS } from '@/lib/realtime/whiteboard/types';

const REALTIME_URL = import.meta.env.VITE_REALTIME_URL?.replace(/\/ws$/, '') || 'ws://localhost:8790';

export interface UseWhiteboardCollaborationOptions {
  projectId: string;
  whiteboardId?: string;
  userId: string;
  userName: string;
  userAvatar?: string;
  enabled?: boolean;
}

export interface UseWhiteboardCollaborationReturn {
  isConnected: boolean;
  connectionState: string;
  userColor: string;

  remotePresence: WhiteboardPresence[];
  remoteCursors: Array<WhiteboardPresence & { cursor: { x: number; y: number } }>;

  broadcastElementAdd: (element: any) => Promise<void>;
  broadcastElementUpdate: (elementId: string, changes: Partial<any>) => Promise<void>;
  broadcastElementDelete: (elementId: string) => Promise<void>;
  broadcastBatchChange: (batch: Omit<BatchChange, 'timestamp' | 'userId'>) => Promise<void>;
  broadcastCursor: (x: number, y: number, tool?: string) => void;
  broadcastSelectionChange: (elementIds: string[]) => Promise<void>;

  onElementAdd: (handler: (element: any, userId: string) => void) => () => void;
  onElementUpdate: (handler: (elementId: string, changes: Partial<any>, userId: string) => void) => () => void;
  onElementDelete: (handler: (elementId: string, userId: string) => void) => () => void;
  onBatchChange: (handler: (batch: BatchChange) => void) => () => void;

  disconnect: () => void;
}

export function useWhiteboardCollaboration({
  projectId,
  whiteboardId,
  userId,
  userName,
  userAvatar,
  enabled = true,
}: UseWhiteboardCollaborationOptions): UseWhiteboardCollaborationReturn {
  const { getToken } = useAuth();
  const stableGetToken = useCallback(async () => (await getToken()) || '', [getToken]);

  const roomId = whiteboardId ? `${projectId}:${whiteboardId}` : projectId;

  const wb = useWhiteboardRoom(roomId, {
    baseUrl: REALTIME_URL,
    getToken: stableGetToken,
    userId,
    userName,
    userAvatar,
    enabled,
  });

  const remotePresence: WhiteboardPresence[] = useMemo(() =>
    wb.remotePresence.map((m) => ({
      id: m.userId,
      sessionId: m.sessionId,
      name: m.name,
      avatar: m.avatar,
      color: m.color,
      lastActivity: Date.now(),
    })),
    [wb.remotePresence],
  );

  const remoteCursors = useMemo(() =>
    wb.remoteCursors.map((cursor) => {
      const member = wb.remotePresence.find((m) => m.userId === cursor.userId);
      return {
        id: cursor.userId,
        sessionId: member?.sessionId,
        name: member?.name || 'Unknown',
        avatar: member?.avatar,
        color: member?.color || '#999',
        tool: cursor.tool,
        lastActivity: Date.now(),
        cursor: { x: cursor.x, y: cursor.y },
      };
    }) as Array<WhiteboardPresence & { cursor: { x: number; y: number } }>,
    [wb.remoteCursors, wb.remotePresence],
  );

  return {
    isConnected: wb.isConnected,
    connectionState: wb.connectionState,
    userColor: wb.userColor,
    remotePresence,
    remoteCursors,
    broadcastElementAdd: wb.broadcastElementAdd,
    broadcastElementUpdate: wb.broadcastElementUpdate,
    broadcastElementDelete: wb.broadcastElementDelete,
    broadcastBatchChange: wb.broadcastBatchChange,
    broadcastCursor: wb.broadcastCursor,
    broadcastSelectionChange: wb.broadcastSelectionChange,
    onElementAdd: wb.onElementAdd,
    onElementUpdate: wb.onElementUpdate,
    onElementDelete: wb.onElementDelete,
    onBatchChange: (handler: (batch: BatchChange) => void) => {
      return wb.onBatchChange((batch) => {
        handler({ ...batch, timestamp: Date.now() });
      });
    },
    disconnect: wb.disconnect,
  };
}

;
