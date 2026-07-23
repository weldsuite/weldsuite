/**
 * WeldChat Messages Real-time Hook — @weldsuite/realtime
 *
 * Subscribes to RoomClient events for live message delivery.
 * Handles new messages, updates, and deletes.
 *
 * Implements gap reconciliation: buffers WS messages received before
 * the initial REST fetch completes, then flushes them into the cache.
 * On reconnection, compares lastSeq to detect missed messages and
 * triggers a catch-up fetch via the `after` cursor.
 */

import { useEffect, useRef, useCallback } from 'react';
import type { RoomClient } from '@weldsuite/realtime/client';
import type { RoomEvent } from '@weldsuite/realtime/types';

export interface WeldChatRealtimeMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  /** 'user' (default) or 'agent' — so the UI can render agent avatar + badge */
  authorType?: string;
  content: string;
  htmlContent?: string;
  type: string;
  parentId?: string;
  attachments?: Array<{
    id: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    url: string;
  }>;
  mentions?: string[];
  mentionsEveryone?: boolean;
  reactions: Record<string, string[]>;
  createdAt: string;
  isEdited?: boolean;
  forwardedFrom?: unknown;
}

interface UseWeldChatMessagesRealtimeOptions {
  onMessageCreated?: (message: WeldChatRealtimeMessage) => void;
  onMessageUpdated?: (message: WeldChatRealtimeMessage) => void;
  onMessageDeleted?: (messageId: string) => void;
  /** Called when a gap is detected after reconnection. Caller should fetch missed messages. */
  onGapDetected?: (lastKnownMessageId: string | null) => void;
  /** Set to true once the initial REST fetch has completed */
  initialFetchDone?: boolean;
}

/**
 * Transform a RoomEvent 'message' into our WeldChat domain model.
 * The realtime protocol sends structured data directly (no metadata wrapping).
 */
function roomEventToMessage(
  event: Extract<RoomEvent, { type: 'message' }>,
  channelId: string,
): WeldChatRealtimeMessage {
  return {
    id: event.id,
    channelId,
    authorId: event.senderId,
    authorName: event.senderName,
    authorAvatar: event.senderAvatar,
    authorType: event.authorType,
    content: event.content,
    htmlContent: event.htmlContent,
    type: 'message',
    parentId: event.threadId,
    attachments: event.attachments?.map((a) => ({
      id: a.id,
      fileName: a.name,
      fileSize: a.size,
      mimeType: a.type,
      url: a.url,
    })),
    reactions: {},
    createdAt: new Date(event.ts).toISOString(),
    forwardedFrom: event.forwardedFrom,
  };
}

export function useWeldChatMessagesRealtime(
  client: RoomClient | null,
  channelId: string | null,
  options: UseWeldChatMessagesRealtimeOptions = {},
) {
  const onCreatedRef = useRef(options.onMessageCreated);
  const onUpdatedRef = useRef(options.onMessageUpdated);
  const onDeletedRef = useRef(options.onMessageDeleted);
  const onGapDetectedRef = useRef(options.onGapDetected);
  const initialFetchDoneRef = useRef(options.initialFetchDone ?? true);

  // Buffer for WS messages received before initial REST fetch completes
  const pendingBuffer = useRef<WeldChatRealtimeMessage[]>([]);
  const lastSeenSeq = useRef(0);

  onCreatedRef.current = options.onMessageCreated;
  onUpdatedRef.current = options.onMessageUpdated;
  onDeletedRef.current = options.onMessageDeleted;
  onGapDetectedRef.current = options.onGapDetected;
  initialFetchDoneRef.current = options.initialFetchDone ?? true;

  // Flush buffered messages when initial fetch completes
  const flushBuffer = useCallback(() => {
    for (const msg of pendingBuffer.current) {
      onCreatedRef.current?.(msg);
    }
    pendingBuffer.current = [];
  }, []);

  useEffect(() => {
    if (options.initialFetchDone && pendingBuffer.current.length > 0) {
      flushBuffer();
    }
  }, [options.initialFetchDone, flushBuffer]);

  useEffect(() => {
    if (!client || !channelId) return;

    // Reset buffer on channel change
    pendingBuffer.current = [];
    lastSeenSeq.current = 0;

    // Subscribe to new messages
    const unsubMessage = client.on('message', (event) => {
      const msg = roomEventToMessage(event, channelId);

      // Track sequence for gap detection
      if (event.seq !== undefined) {
        lastSeenSeq.current = event.seq;
      }

      if (!initialFetchDoneRef.current) {
        // Buffer until REST fetch completes
        pendingBuffer.current.push(msg);
      } else if (msg.id) {
        onCreatedRef.current?.(msg);
      }
    });

    // Subscribe to message updates
    const unsubUpdated = client.on('message:updated', (event) => {
      const data = event.data as Record<string, unknown>;
      const msg: WeldChatRealtimeMessage = {
        id: event.id,
        channelId: (data.channelId as string) || channelId,
        authorId: (data.authorId as string) || '',
        authorName: (data.authorName as string) || '',
        authorAvatar: data.authorAvatar as string | undefined,
        authorType: data.authorType as string | undefined,
        content: (data.content as string) || '',
        htmlContent: data.htmlContent as string | undefined,
        type: (data.type as string) || 'message',
        parentId: data.parentId as string | undefined,
        attachments: data.attachments as WeldChatRealtimeMessage['attachments'],
        mentions: data.mentions as string[] | undefined,
        mentionsEveryone: data.mentionsEveryone as boolean | undefined,
        reactions: {},
        createdAt: (data.createdAt as string) || '',
        isEdited: true,
      };
      onUpdatedRef.current?.(msg);
    });

    // Subscribe to message deletions
    const unsubDeleted = client.on('message:deleted', (event) => {
      onDeletedRef.current?.(event.id);
    });

    // Gap detection on connection
    const unsubConnection = client.onConnectionChange((state) => {
      if (state === 'connected' && initialFetchDoneRef.current) {
        // On reconnection, check if we missed messages
        const serverSeq = client.lastSeq;
        if (serverSeq > lastSeenSeq.current && lastSeenSeq.current > 0) {
          onGapDetectedRef.current?.(null);
        }
        lastSeenSeq.current = serverSeq;
      }
    });

    return () => {
      unsubMessage();
      unsubUpdated();
      unsubDeleted();
      unsubConnection();
    };
  }, [client, channelId]);
}
