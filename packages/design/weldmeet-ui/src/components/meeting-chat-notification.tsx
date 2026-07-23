/**
 * Meeting Chat Notification — Google-Meet-style incoming-message popup.
 *
 * Pure presentational + self-contained detection logic, shared by both the
 * platform (apps/web/platform) and the meeting-portal (apps/web/meeting-portal). When a
 * new message arrives from another participant *while the chat panel is closed*,
 * a small toast slides up in the bottom-left corner of the meeting view. It
 * auto-dismisses after a few seconds, can be dismissed manually, and opens the
 * chat panel when clicked.
 *
 * Data flows in as props — each host app feeds its own live `messages` array
 * (TanStack Query cache on platform, local WebSocket state in the portal).
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import type { ChatMessage } from './meeting-chat-panel';

// How long each popup stays before auto-dismissing.
const AUTO_DISMISS_MS = 6000;
// Cap the visible stack so a burst of messages doesn't fill the screen.
const MAX_VISIBLE = 3;

interface ActiveNote {
  id: string;
  authorName: string;
  authorAvatar?: string | null;
  content: string;
}

export interface MeetingChatNotificationProps {
  /** Live, chronological message list from the host app's data layer. */
  messages: ChatMessage[];
  /** Viewer identity — messages authored by this id never notify. */
  currentUserId: string;
  /** Whether the chat panel is currently open (popups suppress when open). */
  isChatOpen: boolean;
  /** Open the chat panel — fired when the viewer clicks a popup. */
  onOpenChat?: () => void;
  /**
   * Positioned host element (provided by MeetingRoomView, anchored in the video
   * area exactly like the "Your meeting's ready" card). When present the toasts
   * are portaled into it so they share that card's corner distance. Falls back
   * to a self-positioned container when absent.
   */
  host?: HTMLElement | null;
}

export function MeetingChatNotification({
  messages,
  currentUserId,
  isChatOpen,
  onOpenChat,
  host,
}: MeetingChatNotificationProps) {
  const [notes, setNotes] = useState<ActiveNote[]>([]);

  // Message ids already processed — guards against re-firing on re-render and
  // against the initial history ever producing popups.
  const seenRef = useRef<Set<string>>(new Set());
  const initializedRef = useRef(false);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Seed "seen" with whatever exists at mount so the pre-existing history never
  // pops. Only messages that arrive AFTER mount can notify.
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    for (const m of messages) seenRef.current.add(m.id);
  }, [messages]);

  // Detect freshly-arrived incoming messages.
  useEffect(() => {
    if (!initializedRef.current) return;

    const fresh: ActiveNote[] = [];
    for (const m of messages) {
      if (seenRef.current.has(m.id)) continue;
      seenRef.current.add(m.id);
      if (m._optimistic) continue; // our own in-flight send
      if (m.type !== 'message') continue; // skip system / join-leave notices
      if (m.authorId === currentUserId) continue; // skip self
      fresh.push({
        id: m.id,
        authorName: m.authorName,
        authorAvatar: m.authorAvatar,
        content: m.content,
      });
    }

    // Chat open → the viewer already sees the message; just mark seen above.
    if (fresh.length === 0 || isChatOpen) return;
    setNotes((prev) => [...prev, ...fresh].slice(-MAX_VISIBLE));
  }, [messages, currentUserId, isChatOpen]);

  // Opening the chat clears any pending popups.
  useEffect(() => {
    if (isChatOpen) setNotes([]);
  }, [isChatOpen]);

  // Per-note auto-dismiss timers.
  useEffect(() => {
    for (const note of notes) {
      if (timersRef.current.has(note.id)) continue;
      const timer = setTimeout(() => {
        setNotes((prev) => prev.filter((n) => n.id !== note.id));
        timersRef.current.delete(note.id);
      }, AUTO_DISMISS_MS);
      timersRef.current.set(note.id, timer);
    }
    // Clear timers for notes that are gone.
    for (const [id, timer] of timersRef.current) {
      if (!notes.some((n) => n.id === id)) {
        clearTimeout(timer);
        timersRef.current.delete(id);
      }
    }
  }, [notes]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  if (isChatOpen || notes.length === 0) return null;

  const dismiss = (id: string) => setNotes((prev) => prev.filter((n) => n.id !== id));

  const stack = (
    <>
      <style>{`
        @keyframes meet-chat-note-in {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      {notes.map((note) => (
        <div
          key={note.id}
          role="button"
          tabIndex={0}
          onClick={() => {
            onOpenChat?.();
            setNotes([]);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onOpenChat?.();
              setNotes([]);
            }
          }}
          style={{ animation: 'meet-chat-note-in 200ms ease-out' }}
          className="group pointer-events-auto flex w-[300px] cursor-pointer items-start gap-2.5 rounded-2xl border border-border bg-background/95 px-3 py-2.5 text-left shadow-lg backdrop-blur transition-colors hover:bg-muted/60"
        >
          <Avatar className="h-8 w-8 flex-shrink-0 !rounded-[10px]">
            {note.authorAvatar && (
              <AvatarImage src={note.authorAvatar} className="!rounded-[10px]" />
            )}
            <AvatarFallback className="text-[10px] !rounded-[10px]">
              {(note.authorName || '?')[0]?.toUpperCase() ?? '?'}
            </AvatarFallback>
          </Avatar>

          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-foreground">
              {note.authorName}
            </div>
            <div className="line-clamp-2 break-words text-[13px] text-muted-foreground">
              {note.content}
            </div>
          </div>

          <span
            role="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              dismiss(note.id);
            }}
            className="flex-shrink-0 rounded-md p-1 text-muted-foreground/60 opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover:opacity-100"
            aria-label="Dismiss notification"
          >
            <X className="h-3.5 w-3.5" />
          </span>
        </div>
      ))}
    </>
  );

  // Preferred: portal into the MeetingRoomView-owned host so the stack sits at
  // the exact same corner distance as the "Your meeting's ready" card.
  if (host) return createPortal(stack, host);

  // Fallback: self-position in the bottom-right when no host is provided.
  return (
    <div className="absolute bottom-6 right-6 z-10 flex flex-col items-end gap-2 pointer-events-none">
      {stack}
    </div>
  );
}
