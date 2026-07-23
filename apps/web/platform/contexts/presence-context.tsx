/**
 * Platform-Wide Presence Context
 *
 * Provides user presence data to the entire application.
 * Fetches initial statuses, subscribes to real-time updates via
 * @weldsuite/realtime WorkspaceHub, and auto-manages the current
 * user's online/offline state.
 *
 * Offline detection is handled server-side by the WorkspaceHub DO:
 * when the last WebSocket disconnects, it waits 5 seconds (grace period
 * for page refreshes) before broadcasting offline. No beforeunload needed.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
} from 'react';
import { useAuth, useOrganization } from '@clerk/clerk-react';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useTopic, useWorkspaceClientMaybe } from '@weldsuite/realtime/react';
import type { PresenceStatus } from '@weldsuite/ui/components/status-dot';

export interface UserPresence {
  status: PresenceStatus;
  statusText?: string;
  statusEmoji?: string;
}

interface PresenceContextValue {
  presenceMap: Record<string, UserPresence>;
  myStatus: UserPresence | null;
  setMyStatus: (status: PresenceStatus, statusText?: string, statusEmoji?: string) => void;
  getStatus: (userId: string) => UserPresence | undefined;
  isLoading: boolean;
}

const PresenceContext = createContext<PresenceContextValue | null>(null);

export function PresenceProvider({ children }: { children: React.ReactNode }) {
  const { userId } = useAuth();
  const { organization } = useOrganization();
  const { getClient } = useAppApiClient();
  const workspaceClient = useWorkspaceClientMaybe();

  const [presenceMap, setPresenceMap] = useState<Record<string, UserPresence>>({});
  const [isLoading, setIsLoading] = useState(true);
  const preAwayStatusRef = useRef<PresenceStatus | null>(null);
  const hasSetOnlineRef = useRef(false);
  /** Set by the idle-detection effect so other effects can register external
   *  activity (e.g. a `status_changed` WS event from another device of ours)
   *  with the shared idle clock. Null until the idle effect mounts. */
  const crossDeviceActivityRef = useRef<((ts: number) => void) | null>(null);
  /** True once the initial GET /chat-status has resolved for the current
   *  workspace. The auto-online effect waits on this so it can decide
   *  whether to overwrite an existing user-set status. */
  const initialFetchDoneRef = useRef(false);
  /** Bumped on workspace switch so dependent effects can re-run their gates. */
  const [fetchEpoch, setFetchEpoch] = useState(0);
  const awayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presenceMapRef = useRef(presenceMap);
  presenceMapRef.current = presenceMap;

  const workspaceId = organization?.id;

  // Fetch initial statuses. Resets the auto-online gate on every workspace
  // change so the new tenant's `chat_user_status` row is evaluated fresh.
  useEffect(() => {
    if (!workspaceId) return;

    let cancelled = false;
    hasSetOnlineRef.current = false;
    initialFetchDoneRef.current = false;

    const fetchStatuses = async () => {
      try {
        const client = await getClient();
        const response = await client.get<any>('/chat-status');
        if (cancelled) return;

        const map: Record<string, UserPresence> = {};
        for (const s of response?.data ?? []) {
          map[s.userId] = {
            status: s.status || 'offline',
            statusText: s.statusText || undefined,
            statusEmoji: s.statusEmoji || undefined,
          };
        }
        setPresenceMap(map);
      } catch (err) {
        console.error('[Presence] Failed to fetch statuses:', err);
      } finally {
        if (!cancelled) {
          initialFetchDoneRef.current = true;
          setIsLoading(false);
          setFetchEpoch((n) => n + 1);
        }
      }
    };

    fetchStatuses();
    return () => { cancelled = true; };
  }, [workspaceId, getClient]);

  // Subscribe to real-time status changes via WorkspaceHub
  const handlePresenceEvent = useCallback((event: { event: string; data: any }) => {
    if (event.event === 'status_changed') {
      const { userId: uid, status, statusText, statusEmoji } = event.data;
      setPresenceMap((prev) => ({
        ...prev,
        [uid]: {
          status: status || 'offline',
          statusText: statusText || undefined,
          statusEmoji: statusEmoji || undefined,
        },
      }));
      // Cross-device coordination: if our OWN status was just set to a
      // non-idle value, treat it as activity so this tab's idle clock
      // doesn't immediately flap us back to `away`.
      if (uid === userId && (status === 'online' || status === 'busy' || status === 'dnd')) {
        crossDeviceActivityRef.current?.(Date.now());
      }
    } else if (event.event === 'status_cleared') {
      const { userId: uid } = event.data;
      setPresenceMap((prev) => {
        const next = { ...prev };
        delete next[uid];
        return next;
      });
    }
  }, [userId]);

  useTopic('presence', handlePresenceEvent);

  // Auto-set online once per workspace, AFTER the initial fetch resolves
  // so we can respect an existing user-set status (`dnd`/`away`/`busy`).
  // Offline is handled by the WorkspaceHub DO grace period — no beforeunload needed.
  useEffect(() => {
    if (!userId || !workspaceId) return;
    if (!initialFetchDoneRef.current) return;
    if (hasSetOnlineRef.current) return;

    const existing = presenceMapRef.current[userId]?.status;
    // Preserve a deliberate user-set status across refreshes / reconnects.
    if (existing === 'busy' || existing === 'away' || existing === 'dnd') {
      hasSetOnlineRef.current = true;
      return;
    }

    hasSetOnlineRef.current = true;

    // Optimistic: show 'online' immediately so we don't flash old status
    setPresenceMap((prev) => ({
      ...prev,
      [userId]: { ...prev[userId], status: 'online' },
    }));

    const setOnline = async () => {
      try {
        const client = await getClient();
        await client.put('/chat-status', { status: 'online' });
      } catch (err) {
        console.error('[Presence] Failed to set online:', err);
        hasSetOnlineRef.current = false;
      }
    };

    setOnline();
  }, [userId, workspaceId, getClient, fetchEpoch]);

  // Re-assert our current status whenever the realtime connection comes
  // back from a `reconnecting` state. Covers the case where the WorkspaceHub
  // grace period expired and persisted us `offline` while the network blip
  // was in progress; on reconnect we tell the server what we should be.
  useEffect(() => {
    if (!userId || !workspaceClient) return;
    let prev = workspaceClient.connectionState;
    const off = workspaceClient.onConnectionChange(async (state) => {
      const wasReconnecting = prev === 'reconnecting';
      prev = state;
      if (state !== 'connected' || !wasReconnecting) return;

      const current = presenceMapRef.current[userId];
      // Default to `online` when we don't yet have local state.
      const status: PresenceStatus = current?.status ?? 'online';
      try {
        const client = await getClient();
        await client.put('/chat-status', {
          status,
          ...(current?.statusText ? { statusText: current.statusText } : {}),
          ...(current?.statusEmoji ? { statusEmoji: current.statusEmoji } : {}),
        });
      } catch (err) {
        console.error('[Presence] Failed to re-assert status on reconnect:', err);
      }
    });
    return off;
  }, [userId, workspaceClient, getClient]);

  // Idle detection:
  //   • Status drops to `away` after IDLE_MS of NO user activity in ANY tab
  //     of THIS browser. Tabs in the same browser share an activity clock
  //     over `BroadcastChannel`, so tab-switching no longer flaps presence
  //     between `away` and `online`.
  //   • Any local input/scroll OR a same-browser activity broadcast resets
  //     the timer in every tab simultaneously.
  //   • Visibility changes do NOT immediately mark away — a hidden tab
  //     just stops generating local activity. If another tab is active,
  //     its broadcasts keep this one out of `away`. If every tab is
  //     hidden + idle, IDLE_MS expires and we go away.
  //   • Cross-device coordination is best-effort: a `status_changed` WS
  //     event for our own user bumps the activity clock too, so an active
  //     device on another machine prevents this one from flapping us back
  //     to `away` immediately after.
  useEffect(() => {
    if (!userId) return;

    const IDLE_MS = 5 * 60 * 1000;
    const ACTIVITY_THROTTLE_MS = 1000;
    let lastActivityAt = Date.now();
    let lastBroadcastAt = 0;
    let isRestoring = false;

    // Per-user channel so two users on the same machine (multi-account
    // shared device) don't reset each other's timers.
    const channel =
      typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel(`weldsuite-presence-${userId}`)
        : null;

    const goAway = async () => {
      const current = presenceMapRef.current[userId]?.status;
      // Only auto-away from a deliberate "available" state. Preserve user-
      // chosen `busy`/`dnd` and skip when already offline or away.
      if (current !== 'online') return;
      preAwayStatusRef.current = current;
      setPresenceMap((prev) => ({
        ...prev,
        [userId]: { ...prev[userId], status: 'away' },
      }));
      try {
        const client = await getClient();
        await client.put('/chat-status', { status: 'away' });
      } catch {
        // Ignore
      }
    };

    const goBack = async () => {
      if (isRestoring) return;
      const current = presenceMapRef.current[userId]?.status;
      if (current !== 'away') return;
      const restoreStatus: PresenceStatus = preAwayStatusRef.current ?? 'online';
      preAwayStatusRef.current = null;
      isRestoring = true;
      setPresenceMap((prev) => ({
        ...prev,
        [userId]: { ...prev[userId], status: restoreStatus },
      }));
      try {
        const client = await getClient();
        await client.put('/chat-status', { status: restoreStatus });
      } catch {
        // Ignore
      } finally {
        isRestoring = false;
      }
    };

    const scheduleIdleCheck = () => {
      if (awayTimerRef.current) clearTimeout(awayTimerRef.current);
      const elapsed = Date.now() - lastActivityAt;
      const remaining = Math.max(1000, IDLE_MS - elapsed);
      awayTimerRef.current = setTimeout(() => {
        awayTimerRef.current = null;
        if (Date.now() - lastActivityAt >= IDLE_MS) {
          void goAway();
        } else {
          // Another tab broadcast activity since we scheduled — re-arm.
          scheduleIdleCheck();
        }
      }, remaining);
    };

    /** Common path for local activity, peer broadcasts, and WS status pings. */
    const registerActivity = (ts: number, broadcast: boolean) => {
      if (ts > lastActivityAt) lastActivityAt = ts;
      if (presenceMapRef.current[userId]?.status === 'away') {
        void goBack();
      }
      scheduleIdleCheck();
      if (broadcast && channel) {
        // Throttle peer broadcasts — input events fire constantly.
        if (ts - lastBroadcastAt >= ACTIVITY_THROTTLE_MS) {
          lastBroadcastAt = ts;
          try {
            channel.postMessage({ type: 'activity', ts });
          } catch {
            // Channel may be closed during teardown.
          }
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
      // Becoming hidden does nothing — we now rely solely on the global
      // idle clock, so another active tab keeps us online.
      if (document.visibilityState === 'visible') {
        registerActivity(Date.now(), true);
      }
    };

    const onChannelMessage = (e: MessageEvent) => {
      const data = e.data;
      if (data && data.type === 'activity' && typeof data.ts === 'number') {
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
    if (channel) channel.addEventListener('message', onChannelMessage);

    crossDeviceActivityRef.current = (ts: number) => registerActivity(ts, false);

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
      crossDeviceActivityRef.current = null;
      if (awayTimerRef.current) {
        clearTimeout(awayTimerRef.current);
        awayTimerRef.current = null;
      }
    };
  }, [userId, getClient]);

  const setMyStatus = useCallback(
    async (status: PresenceStatus, statusText?: string, statusEmoji?: string) => {
      if (!userId) return;

      // Optimistic update
      setPresenceMap((prev) => ({
        ...prev,
        [userId]: { status, statusText, statusEmoji },
      }));

      try {
        const client = await getClient();
        await client.put('/chat-status', {
          status,
          statusText,
          statusEmoji,
        });
      } catch (err) {
        console.error('[Presence] Failed to set status:', err);
      }
    },
    [userId, getClient],
  );

  const getStatus = useCallback(
    (uid: string): UserPresence | undefined => presenceMap[uid],
    [presenceMap],
  );

  const myStatus = userId ? presenceMap[userId] ?? null : null;

  return (
    <PresenceContext.Provider value={{ presenceMap, myStatus, setMyStatus, getStatus, isLoading }}>
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
