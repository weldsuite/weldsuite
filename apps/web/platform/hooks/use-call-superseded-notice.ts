/**
 * Explains an unexpected exit from a call.
 *
 * A user is in at most one live call. When they join another one, or the same
 * one again from another tab or device, the server drops the older connection
 * and publishes `call_superseded` on `chat.user.<userId>` just BEFORE the
 * RealtimeKit kick. The evicted tab then sees `roomLeft { state: 'kicked' }`,
 * which looks exactly like a host removing someone, so this hook pairs the two:
 *
 *   - event first, kick second: the event is remembered for a few seconds and
 *     the kick is explained when it arrives;
 *   - kick first, event second: the kick waits a short grace period for the
 *     event, and falls back to the caller's own message when none comes.
 *
 * The event also fires for a tab that is STILL in the call (the newer of two
 * tabs on the same meeting), so an event only counts when it names this tab's
 * own RealtimeKit participant.
 */

import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useTopic } from '@weldsuite/realtime/react';
import type { CallSupersededEvent, WorkspaceEvent } from '@weldsuite/realtime';
import type RealtimeKitClient from '@cloudflare/realtimekit';

/** How long a kick waits for the explaining event before using its fallback. */
export const KICK_GRACE_MS = 1_500;
/** How long an event waits for the kick it announces. */
export const EVENT_TTL_MS = 10_000;

/** The connection that was just dropped: what the server's event is matched against. */
export interface SupersedeTarget {
  /** Chat call id, or meeting session id. */
  sessionId: string | null;
  /** This tab's RealtimeKit participant ids (`self.id`, `self.userId`). */
  participantIds: string[];
}

/** The RealtimeKit participant ids of this tab, whichever one the server stored. */
export function rtkParticipantIds(client: RealtimeKitClient | null | undefined): string[] {
  try {
    const self = client?.self;
    return [self?.id, self?.userId].filter((id): id is string => typeof id === 'string' && id !== '');
  } catch {
    return [];
  }
}

/** Whether `event` is about the connection described by `target`. */
function isAbout(event: CallSupersededEvent, target: SupersedeTarget): boolean {
  if (event.cfSessionId) {
    // The evicted connection's own id: a tab still in the same call has another.
    return target.participantIds.includes(event.cfSessionId);
  }
  return target.sessionId !== null && target.sessionId === event.id;
}

interface UseCallSupersededNoticeOptions {
  kind: CallSupersededEvent['kind'];
  /** Whose `chat.user.<id>` topic to listen on; nothing is subscribed without it. */
  userId: string | undefined;
  /** The explanation, read when it is shown so a language change is picked up. */
  message: () => string;
}

interface RecentEvent {
  event: CallSupersededEvent;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingExit {
  target: SupersedeTarget;
  fallback?: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export function useCallSupersededNotice({ kind, userId, message }: Readonly<UseCallSupersededNoticeOptions>) {
  const recentRef = useRef<RecentEvent[]>([]);
  const pendingRef = useRef<PendingExit | null>(null);
  const messageRef = useRef(message);
  messageRef.current = message;

  const show = useCallback(() => {
    toast.info(messageRef.current());
  }, []);

  useTopic<CallSupersededEvent>(userId ? `chat.user.${userId}` : '', (workspaceEvent: WorkspaceEvent<CallSupersededEvent>) => {
    if (workspaceEvent.event !== 'call_superseded') return;
    const event = workspaceEvent.data;
    if (!event || event.kind !== kind) return;

    // The kick got here first: it is waiting for exactly this.
    const pending = pendingRef.current;
    if (pending && isAbout(event, pending.target)) {
      clearTimeout(pending.timer);
      pendingRef.current = null;
      show();
      return;
    }

    // Still in the room: the kick follows. Forgotten after a while, so a later
    // removal by a host is not mistaken for this one.
    const entry: RecentEvent = {
      event,
      timer: setTimeout(() => {
        recentRef.current = recentRef.current.filter((recent) => recent !== entry);
      }, EVENT_TTL_MS),
    };
    recentRef.current.push(entry);
  });

  /**
   * Call when the room was left without the user asking for it (`kicked` /
   * `ended`). Shows the supersede message when the server said so, otherwise
   * runs `fallback` (the generic "the host ended the meeting" toast) once the
   * grace period has passed.
   */
  const explainExit = useCallback((target: SupersedeTarget, fallback?: () => void) => {
    const announced = recentRef.current.find((recent) => isAbout(recent.event, target));
    if (announced) {
      clearTimeout(announced.timer);
      recentRef.current = recentRef.current.filter((recent) => recent !== announced);
      show();
      return;
    }
    if (pendingRef.current) clearTimeout(pendingRef.current.timer);
    const pending: PendingExit = {
      target,
      fallback,
      timer: setTimeout(() => {
        if (pendingRef.current === pending) pendingRef.current = null;
        pending.fallback?.();
      }, KICK_GRACE_MS),
    };
    pendingRef.current = pending;
  }, [show]);

  useEffect(() => () => {
    for (const recent of recentRef.current) clearTimeout(recent.timer);
    recentRef.current = [];
    if (pendingRef.current) clearTimeout(pendingRef.current.timer);
    pendingRef.current = null;
  }, []);

  return { explainExit };
}
