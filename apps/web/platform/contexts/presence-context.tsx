/**
 * Platform-Wide Presence Context
 *
 * What every member's status dot shows, from two inputs
 * (`@weldsuite/realtime/presence`):
 *
 *  - **Live presence** from the realtime WorkspaceHub: a `snapshot` when we
 *    subscribe to `presence` (again on every reconnect), then
 *    `connection_changed` events. The hub alone decides who is connected; it
 *    notices a closed laptop or a dropped network by the missing heartbeat.
 *    This tab tells it two things about itself: whether the user is idle (no
 *    input in any tab of this browser for `IDLE_MS`) and whether they are in a
 *    call. The hub folds all tabs and devices of a member together, so an idle
 *    tab never marks someone away who is busy elsewhere.
 *  - **Chosen statuses** (Busy, Do not disturb, Away, Appear offline, custom
 *    text) from `GET /chat-status`, then `status_changed` / `status_cleared`
 *    events. `setMyStatus` sets ours.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import { useAuth, useOrganization } from '@clerk/clerk-react';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useTopic, useWorkspaceClientMaybe } from '@weldsuite/realtime/react';
import { topicMatches } from '@weldsuite/realtime/topics';
import {
  PRESENCE_EVENTS,
  PRESENCE_TOPIC,
  effectivePresence,
  type ChosenStatus,
  type LivePresence,
  type PresenceConnectionChange,
  type PresenceSnapshot,
  type PresenceStatusChange,
} from '@weldsuite/realtime/presence';
import type { WorkspaceEvent } from '@weldsuite/realtime';
import type { PresenceStatus } from '@weldsuite/ui/components/status-dot';

/** No input in any tab of this browser for this long marks the user idle. */
const IDLE_MS = 5 * 60 * 1000;
const ACTIVITY_THROTTLE_MS = 1000;

export interface UserPresence {
  status: PresenceStatus;
  statusText?: string;
  statusEmoji?: string;
}

/** A member's chosen status as we last heard it. */
interface ChosenEntry {
  status: ChosenStatus;
  statusText?: string;
  statusEmoji?: string;
  expiresAt: number | null;
  /** Server time of the write; an older event or fetch never replaces a newer one. */
  updatedAt: number;
}

interface ChatStatusRow {
  userId: string;
  manualStatus?: ChosenStatus;
  live?: LivePresence | null;
  statusText?: string | null;
  statusEmoji?: string | null;
  statusExpiresAt?: string | null;
  updatedAt?: string | null;
}

interface PresenceContextValue {
  presenceMap: Record<string, UserPresence>;
  myStatus: UserPresence | null;
  setMyStatus: (status: PresenceStatus, statusText?: string, statusEmoji?: string) => void;
  /** Show us as busy while in a call; cleared on its own if the tab goes away. */
  setInCall: (inCall: boolean) => void;
  getStatus: (userId: string) => UserPresence | undefined;
  isLoading: boolean;
}

const PresenceContext = createContext<PresenceContextValue | null>(null);

const timeOf = (iso: string | null | undefined): number => (iso ? Date.parse(iso) || 0 : 0);

function toEntry(change: PresenceStatusChange): ChosenEntry {
  return {
    status: change.status,
    statusText: change.statusText || undefined,
    statusEmoji: change.statusEmoji || undefined,
    expiresAt: change.expiresAt ? timeOf(change.expiresAt) : null,
    updatedAt: timeOf(change.updatedAt),
  };
}

/** Keep whichever of two entries for a member was written last. */
function newer(current: ChosenEntry | undefined, incoming: ChosenEntry): ChosenEntry {
  return current && current.updatedAt > incoming.updatedAt ? current : incoming;
}

export function PresenceProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  const { userId } = useAuth();
  const { organization } = useOrganization();
  const { getClient } = useAppApiClient();
  const workspaceClient = useWorkspaceClientMaybe();

  const [chosen, setChosen] = useState<Record<string, ChosenEntry>>({});
  const [live, setLive] = useState<Record<string, LivePresence>>({});
  const [isLoading, setIsLoading] = useState(true);
  /** Once the hub's snapshot arrived, live presence from a fetch is older news. */
  const snapshotSeenRef = useRef(false);

  const workspaceId = organization?.id;

  const fetchStatuses = useCallback(async () => {
    try {
      const client = await getClient();
      const response = await client.get<{ data?: ChatStatusRow[] }>('/chat-status');

      const fetchedChosen: Record<string, ChosenEntry> = {};
      const fetchedLive: Record<string, LivePresence> = {};
      for (const row of response?.data ?? []) {
        fetchedChosen[row.userId] = {
          status: row.manualStatus ?? 'online',
          statusText: row.statusText || undefined,
          statusEmoji: row.statusEmoji || undefined,
          expiresAt: row.statusExpiresAt ? timeOf(row.statusExpiresAt) : null,
          updatedAt: timeOf(row.updatedAt),
        };
        if (row.live) fetchedLive[row.userId] = row.live;
      }

      setChosen((prev) => {
        const next: Record<string, ChosenEntry> = {};
        for (const [uid, entry] of Object.entries(fetchedChosen)) next[uid] = newer(prev[uid], entry);
        return next;
      });
      if (!snapshotSeenRef.current) setLive(fetchedLive);
    } catch (err) {
      console.error('[Presence] Failed to fetch statuses:', err);
    } finally {
      setIsLoading(false);
    }
  }, [getClient]);

  // Initial statuses, per workspace.
  useEffect(() => {
    if (!workspaceId) return;
    snapshotSeenRef.current = false;
    setChosen({});
    setLive({});
    void fetchStatuses();
  }, [workspaceId, fetchStatuses]);

  const handlePresenceEvent = useCallback((event: WorkspaceEvent) => {
    switch (event.event) {
      case PRESENCE_EVENTS.snapshot: {
        snapshotSeenRef.current = true;
        setLive({ ...(event.data as PresenceSnapshot).users });
        break;
      }
      case PRESENCE_EVENTS.connection: {
        const { userId: uid, live: memberLive } = event.data as PresenceConnectionChange;
        setLive((prev) => {
          const next = { ...prev };
          if (memberLive) next[uid] = memberLive;
          else delete next[uid];
          return next;
        });
        break;
      }
      case PRESENCE_EVENTS.status: {
        const change = event.data as PresenceStatusChange;
        // Events from before presence moved into the hub carry no write time
        // and meant something else; the fetch has the truth for those.
        if (!change.updatedAt) break;
        const entry = toEntry(change);
        setChosen((prev) => ({ ...prev, [change.userId]: newer(prev[change.userId], entry) }));
        break;
      }
      case PRESENCE_EVENTS.cleared: {
        const { userId: uid, updatedAt } = event.data as { userId: string; updatedAt?: string };
        setChosen((prev) => {
          if (!prev[uid] || prev[uid].updatedAt > timeOf(updatedAt)) return prev;
          const next = { ...prev };
          delete next[uid];
          return next;
        });
        break;
      }
    }
  }, []);

  useTopic(PRESENCE_TOPIC, handlePresenceEvent);

  // The replay log only goes back so far: when the hub says our cursor is too
  // old, chosen statuses may have changed unseen. Live presence needs nothing,
  // the resubscribe brings a fresh snapshot.
  useEffect(() => {
    if (!workspaceClient) return;
    return workspaceClient.onResyncRequired((topics) => {
      if (topics.some((topic) => topicMatches(topic, PRESENCE_TOPIC))) void fetchStatuses();
    });
  }, [workspaceClient, fetchStatuses]);

  // Idle detection: the user is idle after IDLE_MS without input in ANY tab of
  // this browser. Tabs share an activity clock over `BroadcastChannel`, so
  // switching tabs never makes one of them idle. A hidden tab simply stops
  // seeing input. Each tab reports to the hub; the hub only shows the member
  // away once every tab and device of theirs is idle.
  useEffect(() => {
    if (!userId || !workspaceClient) return;

    let lastActivityAt = Date.now();
    let lastBroadcastAt = 0;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    // Per-user channel so two users on the same machine (multi-account
    // shared device) don't reset each other's timers.
    const channel =
      typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel(`weldsuite-presence-${userId}`)
        : null;

    const scheduleIdleCheck = () => {
      if (idleTimer) clearTimeout(idleTimer);
      const remaining = Math.max(1000, IDLE_MS - (Date.now() - lastActivityAt));
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (Date.now() - lastActivityAt >= IDLE_MS) {
          workspaceClient.setPresence({ idle: true });
        } else {
          // Another tab broadcast activity since we scheduled — re-arm.
          scheduleIdleCheck();
        }
      }, remaining);
    };

    /** Common path for local activity and peer broadcasts. */
    const registerActivity = (ts: number, broadcast: boolean) => {
      if (ts > lastActivityAt) lastActivityAt = ts;
      workspaceClient.setPresence({ idle: false });
      scheduleIdleCheck();
      // Throttle peer broadcasts — input events fire constantly.
      if (broadcast && channel && ts - lastBroadcastAt >= ACTIVITY_THROTTLE_MS) {
        lastBroadcastAt = ts;
        try {
          channel.postMessage({ type: 'activity', ts });
        } catch {
          // Channel may be closed during teardown.
        }
      }
    };

    const onLocalActivity = () => {
      const now = Date.now();
      if (now - lastActivityAt < ACTIVITY_THROTTLE_MS) return;
      registerActivity(now, true);
    };

    const onVisibility = () => {
      // Becoming visible counts as activity (user just touched the tab).
      if (document.visibilityState === 'visible') registerActivity(Date.now(), true);
    };

    const onChannelMessage = (e: MessageEvent) => {
      const data = e.data;
      if (data?.type === 'activity' && typeof data.ts === 'number') {
        // Peer activity — update our clock but DON'T re-broadcast (avoid loops).
        registerActivity(data.ts, false);
      }
    };

    const activityEvents: Array<keyof DocumentEventMap> = [
      'mousemove',
      'mousedown',
      'keydown',
      'touchstart',
      'scroll',
      'wheel',
    ];
    for (const ev of activityEvents) {
      document.addEventListener(ev, onLocalActivity, { passive: true });
    }
    document.addEventListener('visibilitychange', onVisibility);
    channel?.addEventListener('message', onChannelMessage);

    scheduleIdleCheck();

    return () => {
      for (const ev of activityEvents) {
        document.removeEventListener(ev, onLocalActivity);
      }
      document.removeEventListener('visibilitychange', onVisibility);
      if (channel) {
        channel.removeEventListener('message', onChannelMessage);
        channel.close();
      }
      if (idleTimer) clearTimeout(idleTimer);
    };
  }, [userId, workspaceClient]);

  const setMyStatus = useCallback(
    async (status: PresenceStatus, statusText?: string, statusEmoji?: string) => {
      if (!userId) return;

      // Optimistic, without claiming a write time: the server's echo replaces it.
      setChosen((prev) => ({
        ...prev,
        [userId]: { status, statusText, statusEmoji, expiresAt: null, updatedAt: prev[userId]?.updatedAt ?? 0 },
      }));

      try {
        const client = await getClient();
        const response = await client.put<{ data?: PresenceStatusChange }>('/chat-status', {
          status,
          statusText,
          statusEmoji,
        });
        const change = response?.data;
        if (change?.updatedAt) {
          setChosen((prev) => ({ ...prev, [userId]: newer(prev[userId], toEntry(change)) }));
        }
      } catch (err) {
        console.error('[Presence] Failed to set status:', err);
      }
    },
    [userId, getClient],
  );

  const setInCall = useCallback(
    (inCall: boolean) => workspaceClient?.setPresence({ inCall }),
    [workspaceClient],
  );

  const presenceMap = useMemo(() => {
    const now = Date.now();
    const map: Record<string, UserPresence> = {};
    for (const uid of new Set([...Object.keys(chosen), ...Object.keys(live)])) {
      const entry = chosen[uid];
      const expired = entry?.expiresAt != null && entry.expiresAt <= now;
      // We are here ourselves, even before the hub's snapshot says so.
      const memberLive = uid === userId ? (live[uid] ?? 'online') : live[uid];
      map[uid] = {
        status: effectivePresence(expired ? 'online' : entry?.status, memberLive),
        statusText: expired ? undefined : entry?.statusText,
        statusEmoji: expired ? undefined : entry?.statusEmoji,
      };
    }
    if (userId && !map[userId]) map[userId] = { status: live[userId] ?? 'online' };
    return map;
  }, [chosen, live, userId]);

  const getStatus = useCallback(
    (uid: string): UserPresence | undefined => presenceMap[uid],
    [presenceMap],
  );

  const myStatus = userId ? presenceMap[userId] ?? null : null;

  const value = useMemo<PresenceContextValue>(
    () => ({ presenceMap, myStatus, setMyStatus, setInCall, getStatus, isLoading }),
    [presenceMap, myStatus, setMyStatus, setInCall, getStatus, isLoading],
  );

  return (
    <PresenceContext.Provider value={value}>
      {children}
    </PresenceContext.Provider>
  );
}

export function usePresence(): PresenceContextValue {
  const context = useContext(PresenceContext);
  if (!context) {
    throw new Error('usePresence must be used within a PresenceProvider');
  }
  return context;
}

export function usePresenceMaybe(): PresenceContextValue | null {
  return useContext(PresenceContext);
}
