'use client';

/**
 * Guest Chat Panel — meeting-portal data wrapper
 *
 * Handles all guest-specific data fetching (unauthenticated HTTP + WebSocket
 * reconnect loop) and renders the shared <SharedMeetingChatPanel> from
 * @weldsuite/weldmeet-ui so both apps show an identical chat UI.
 *
 * Data layer: fetch + native WebSocket (no Clerk, no realtime SDK, no TanStack Query).
 * Visual layer: fully delegated to SharedMeetingChatPanel.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  SharedMeetingChatPanel,
  MeetingChatNotification,
  type ChatMessage,
  type ChatMessageAttachment,
  type ChatParticipant,
} from '@weldsuite/weldmeet-ui';

// ============================================================================
// Types
// ============================================================================

interface GuestChatPanelProps {
  meetingId: string;
  orgId: string;
  guestName: string;
  guestEmail: string;
  guestUserId: string;
  isOpen: boolean;
  onClose: () => void;
  onOpen?: () => void;
  notificationHost?: HTMLElement | null;
  /** Meeting participants offered in the composer's @-mention picker. */
  participants?: ChatParticipant[];
}

const REALTIME_PUBLIC_URL =
  process.env.NEXT_PUBLIC_REALTIME_URL?.replace(/\/$/, '') ?? '';

// ============================================================================
// Component
// ============================================================================

export function GuestChatPanel({
  meetingId,
  orgId,
  guestName,
  guestEmail,
  guestUserId,
  isOpen,
  onClose,
  onOpen,
  notificationHost,
  participants,
}: GuestChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // ── Initial fetch ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setIsLoading(true);

    (async () => {
      try {
        const params = new URLSearchParams({ orgId, email: guestEmail });
        const res = await fetch(`/api/meeting/${meetingId}/messages?${params.toString()}`);
        if (!res.ok) throw new Error(`Failed to load (${res.status})`);
        const json = await res.json();
        if (cancelled) return;
        // API returns newest-first; reverse to chronological
        const list: ChatMessage[] = (json.data?.messages ?? [])
          .slice()
          .reverse()
          .map((m: any) => ({
            id: m.id,
            authorId: m.authorId,
            authorName: m.authorName,
            authorAvatar: m.authorAvatar ?? null,
            content: m.content,
            htmlContent: m.htmlContent ?? null,
            type: m.type ?? 'message',
            createdAt: m.createdAt,
            attachments: m.attachments ?? [],
            pinnedAt: m.pinnedAt ?? null,
          }));
        setMessages(list);
      } catch (err) {
        console.error('[GuestChat] Failed to load messages:', err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, meetingId, orgId, guestEmail]);

  // ── Realtime WebSocket subscription ──────────────────────────────────────
  // Stays connected for the whole meeting (not gated on `isOpen`) so incoming
  // messages can raise a Google-Meet-style notification popup even while the
  // chat panel is closed.
  useEffect(() => {
    if (!REALTIME_PUBLIC_URL) {
      console.warn(
        '[weldmeet-chat] GuestChat: NEXT_PUBLIC_REALTIME_URL env var is not set — realtime WebSocket disabled. Guest will not receive live messages.',
      );
      return;
    }

    const params = new URLSearchParams({ guestUserId, guestName });
    const wsBase = REALTIME_PUBLIC_URL.replace(/^http/, 'ws');
    const url = `${wsBase}/ws/chat/meet_${meetingId}?${params.toString()}`;

    let ws: WebSocket | null = null;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(url);

      ws.addEventListener('open', () => {
        attempt = 0;
        console.info(`[weldmeet-chat] GuestChat WebSocket connected: url=${url}`);
      });

      ws.addEventListener('error', (ev) => {
        console.error(`[weldmeet-chat] GuestChat WebSocket error: url=${url}`, ev);
      });

      ws.addEventListener('close', (ev) => {
        if (closed) return;
        console.warn(
          `[weldmeet-chat] GuestChat WebSocket closed: url=${url} code=${ev.code} reason=${ev.reason || '(none)'} wasClean=${ev.wasClean}`,
        );
        attempt += 1;
        const delay = Math.min(1000 * 2 ** Math.min(attempt, 5), 15000);
        reconnectTimer = setTimeout(connect, delay);
      });

      ws.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');

          if (msg.type === 'message' && msg.id && msg.senderId !== guestUserId) {
            const incoming: ChatMessage = {
              id: msg.id,
              authorId: msg.senderId,
              authorName: msg.senderName,
              authorAvatar: msg.senderAvatar ?? null,
              content: msg.content,
              htmlContent: msg.htmlContent ?? null,
              type: 'message',
              createdAt: new Date(msg.ts ?? Date.now()).toISOString(),
              // Realtime payloads carry attachments in {id,name,size,type,url}
              // shape (host + portal publishers agree on this); map to the
              // shared ChatMessageAttachment shape the panel renders.
              attachments: Array.isArray(msg.attachments)
                ? msg.attachments.map((a: any) => ({
                    id: a.id,
                    fileName: a.name ?? a.fileName,
                    fileSize: a.size ?? a.fileSize,
                    mimeType: a.type ?? a.mimeType,
                    url: a.url,
                  }))
                : undefined,
            };
            setMessages((prev) =>
              prev.some((m) => m.id === incoming.id) ? prev : [...prev, incoming],
            );
          } else if (msg.type === 'message:deleted' && msg.id) {
            setMessages((prev) => prev.filter((m) => m.id !== msg.id));
          }
        } catch {
          // ignore malformed frames
        }
      });
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
    };
  }, [meetingId, guestUserId, guestName]);

  // ── Upload handler ───────────────────────────────────────────────────────
  // POST the file (multipart) to the guest upload route, which streams it to
  // R2 and returns a persisted attachment with a real, shareable URL.
  const onUploadFile = useCallback(
    async (file: File): Promise<ChatMessageAttachment | null> => {
      try {
        const fd = new FormData();
        fd.append('orgId', orgId);
        fd.append('email', guestEmail);
        fd.append('file', file);
        const res = await fetch(`/api/meeting/${meetingId}/upload`, {
          method: 'POST',
          body: fd,
        });
        if (!res.ok) throw new Error(`Upload failed (${res.status})`);
        const json = await res.json();
        const d = json.data;
        if (!d?.url) return null;
        return {
          id: d.id,
          fileName: d.fileName,
          fileSize: d.fileSize,
          mimeType: d.mimeType,
          url: d.url,
        };
      } catch (err) {
        console.error('[GuestChat] File upload failed:', err);
        return null;
      }
    },
    [meetingId, orgId, guestEmail],
  );

  // ── Send handler ─────────────────────────────────────────────────────────
  const handleSend = useCallback(
    async (content: string, attachments?: ChatMessageAttachment[], html?: string) => {
      const ready = (attachments ?? []).filter((a) => !a._uploading && a.url);
      if (!content.trim() && ready.length === 0) return;

      // Optimistic append
      const optimisticId = `opt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const optimistic: ChatMessage = {
        id: optimisticId,
        authorId: guestUserId,
        authorName: guestName,
        authorAvatar: null,
        content,
        htmlContent: html ?? null,
        type: 'message',
        createdAt: new Date().toISOString(),
        attachments: ready.length > 0 ? ready : undefined,
        _optimistic: true,
      };
      setMessages((prev) => [...prev, optimistic]);

      try {
        const res = await fetch(`/api/meeting/${meetingId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orgId,
            email: guestEmail,
            name: guestName,
            content,
            htmlContent: html,
            attachments:
              ready.length > 0
                ? ready.map((a) => ({
                    id: a.id ?? `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    fileName: a.fileName,
                    fileSize: a.fileSize ?? 0,
                    mimeType: a.mimeType ?? 'application/octet-stream',
                    url: a.url,
                  }))
                : undefined,
          }),
        });
        if (!res.ok) throw new Error(`Send failed (${res.status})`);
        const json = await res.json();
        const saved: ChatMessage = {
          id: json.data.id,
          authorId: json.data.authorId,
          authorName: json.data.authorName,
          authorAvatar: json.data.authorAvatar ?? null,
          content: json.data.content,
          htmlContent: json.data.htmlContent ?? null,
          type: json.data.type ?? 'message',
          createdAt: json.data.createdAt,
          attachments: json.data.attachments ?? undefined,
        };
        setMessages((prev) => prev.map((m) => (m.id === optimisticId ? saved : m)));
      } catch (err) {
        console.error('[GuestChat] Failed to send:', err);
        // Roll back optimistic message
        setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
        // Re-throw so SharedMeetingChatPanel's input can restore the draft
        throw err;
      }
    },
    [meetingId, orgId, guestEmail, guestName, guestUserId],
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <SharedMeetingChatPanel
        isOpen={isOpen}
        onClose={onClose}
        messages={messages}
        isLoading={isLoading}
        currentUserId={guestUserId}
        currentUserName={guestName}
        participants={participants}
        onSendMessage={handleSend}
        onUploadFile={onUploadFile}
        // Guests have no moderation rights: suppress the action toolbar.
        // Copy-text still works via the keyboard (no toast needed in the portal).
        readOnlyActions={true}
      />
      <MeetingChatNotification
        messages={messages}
        currentUserId={guestUserId}
        isChatOpen={isOpen}
        onOpenChat={onOpen}
        host={notificationHost}
      />
    </>
  );
}
