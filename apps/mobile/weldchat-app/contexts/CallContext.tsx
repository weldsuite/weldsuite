/**
 * WeldChat mobile call context.
 *
 * Mirrors the platform's `weldchat-call-context.tsx` for the mobile client.
 * Cloudflare RealtimeKit handles the actual WebRTC media (in `CallHost`);
 * this context owns:
 *   - incoming-call signaling — realtime `call_incoming` on
 *     `chat.user.${userId}`, plus Expo push (`chat_incoming_call`) via
 *     `incoming-call-bridge` when the socket is asleep in background;
 *   - foreground recovery — on AppState `active`, poll `/chat-calls/active`
 *     for unanswered DM rings the user may have missed;
 *   - the call lifecycle (start / join / accept / decline / leave) over the
 *     shared app-api `/chat-calls/*` endpoints;
 *   - the joinable `session` (callId + RealtimeKit authToken) that `CallHost`
 *     consumes to connect to the SFU.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, Vibration } from 'react-native';
import { useAuth } from '@clerk/expo';
import { useTopic } from '@weldsuite/realtime/react';
import type { WorkspaceEvent } from '@weldsuite/realtime/types';
import { appApi } from '@/services/app-api';
import { useLoopingSound } from '@/hooks/useLoopingSound';
import {
  incomingCallPayloadFromNotificationData,
  setIncomingCallPushHandler,
  type IncomingCallPushPayload,
} from '@/lib/incoming-call-bridge';

const RINGTONE = require('@/assets/sounds/ringtone.wav');

export type CallType = 'voice' | 'video';
export type CallStatus = 'idle' | 'ringing-incoming' | 'connecting' | 'connected';

export interface IncomingCall {
  callId: string;
  channelId: string;
  callType: CallType;
  callerName: string;
  callerAvatar?: string;
}

/** A joined call ready for the RealtimeKit RN client to consume. */
export interface CallSession {
  callId: string;
  channelId: string;
  callType: CallType;
  authToken: string;
  /** Direct (1:1) call → drives the WhatsApp-style "calling" screen. */
  isDirect?: boolean;
  /** Callee display name shown on the outgoing-call screen. */
  peerName?: string;
  /** Callee avatar URL shown on the outgoing-call screen. */
  peerAvatar?: string | null;
}

/** Optional callee identity supplied when placing a direct (1:1) call. */
export interface CallPeer {
  name?: string;
  avatar?: string | null;
  isDirect?: boolean;
}

interface CallContextValue {
  status: CallStatus;
  incomingCall: IncomingCall | null;
  session: CallSession | null;
  /** Whether the active call is collapsed to the top bar (WhatsApp-style). */
  minimized: boolean;
  /** Collapse the active call to the top bar so the user can browse the app. */
  minimizeCall: () => void;
  /** Re-open the full-screen call from the minimized bar. */
  expandCall: () => void;
  /**
   * Calls currently active per channel (keyed by channelId), so a channel
   * screen can show a "Join call" banner. Seeded by the channel screen via
   * setChannelActiveCall and kept live by call_started / call_ended events.
   */
  activeChannelCalls: Record<string, { callId: string; callType: CallType }>;
  /** Start a call in a channel; if one is already active there, JOIN it. Navigates to the call room. */
  startCall: (channelId: string, callType: CallType, peer?: CallPeer) => Promise<void>;
  /** Join an existing call by id AND navigate to the call room. */
  joinCall: (callId: string, peer?: CallPeer) => Promise<void>;
  /** Join an existing call by id (used by push-tap / cold start). No navigation. */
  joinCallById: (callId: string) => Promise<void>;
  /** Seed/clear the known active call for a channel (called by the channel screen on focus). */
  setChannelActiveCall: (channelId: string, value: { callId: string; callType: CallType } | null) => void;
  /** Answer the currently ringing incoming call. Navigates to the call room. */
  acceptIncomingCall: () => Promise<void>;
  /** Reject the currently ringing incoming call. */
  declineCall: () => Promise<void>;
  /** Leave the active call. */
  leaveCall: () => Promise<void>;
  /** Called by the call room once the SFU room is joined. */
  markConnected: () => void;
}

const noop = async () => {};

const CallContext = createContext<CallContextValue>({
  status: 'idle',
  incomingCall: null,
  session: null,
  minimized: false,
  minimizeCall: () => {},
  expandCall: () => {},
  activeChannelCalls: {},
  startCall: noop,
  joinCall: noop,
  joinCallById: noop,
  setChannelActiveCall: () => {},
  acceptIncomingCall: noop,
  declineCall: noop,
  leaveCall: noop,
  markConnected: () => {},
});

export const useCall = () => useContext(CallContext);

// Vibrate-pause-vibrate, repeated — the "ringing phone" feel without an asset.
const RING_PATTERN = [0, 1000, 2000];

type IncomingCallData = {
  callId: string;
  channelId: string;
  callType: CallType;
  callerName: string;
  callerAvatar?: string;
};

export function CallProvider({ children }: { children: React.ReactNode }) {
  const { userId } = useAuth();

  const [status, setStatus] = useState<CallStatus>('idle');
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [session, setSession] = useState<CallSession | null>(null);
  // The call UI is a global overlay (see CallHost) rather than a route, so
  // starting a call just sets the session + expands the overlay; minimizing
  // collapses it to the top bar without tearing down the WebRTC client.
  const [minimized, setMinimized] = useState(false);
  const minimizeCall = useCallback(() => setMinimized(true), []);
  const expandCall = useCallback(() => setMinimized(false), []);
  const [activeChannelCalls, setActiveChannelCalls] = useState<
    Record<string, { callId: string; callType: CallType }>
  >({});

  const setChannelActiveCall = useCallback(
    (channelId: string, value: { callId: string; callType: CallType } | null) => {
      setActiveChannelCalls((cur) => {
        if (!value) {
          if (!(channelId in cur)) return cur;
          const next = { ...cur };
          delete next[channelId];
          return next;
        }
        if (cur[channelId]?.callId === value.callId) return cur;
        return { ...cur, [channelId]: value };
      });
    },
    [],
  );

  // Mirror status into a ref so the realtime handler (a stable closure) can read
  // the latest value without re-subscribing on every transition.
  const statusRef = useRef(status);
  statusRef.current = status;
  const incomingCallRef = useRef(incomingCall);
  incomingCallRef.current = incomingCall;

  // Guards a single in-flight start/join so a UI "Join" tap and a push-tap
  // (joinCallById) can't both request a join token for the same call and race
  // each other's setSession. Reset in every start/join path's finally block.
  const joinInFlightRef = useRef(false);

  const presentIncoming = useCallback((payload: IncomingCallPushPayload) => {
    if (statusRef.current !== 'idle') {
      // Already ringing for this same call — ignore duplicate push/realtime.
      if (incomingCallRef.current?.callId === payload.callId) return;
      return;
    }
    if (!payload.callId) return;
    setIncomingCall({
      callId: payload.callId,
      channelId: payload.channelId,
      callType: payload.callType ?? 'voice',
      callerName: payload.callerName || 'Incoming call',
      callerAvatar: payload.callerAvatar,
    });
    setStatus('ringing-incoming');
    // Full-screen modal owns the ring — clear the OS banner so they don't stack.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- native module absent in Expo Go
      const { dismissPresentedNotificationsWhere } = require('@weldsuite/mobile-ui/services/notifications') as {
        dismissPresentedNotificationsWhere: (
          match: (data: Record<string, unknown>) => boolean,
        ) => Promise<void>;
      };
      void dismissPresentedNotificationsWhere(
        (data) => data.notificationType === 'chat_incoming_call' && data.entityId === payload.callId,
      );
    } catch {
      // Expo Go
    }
  }, []);

  // Push path (NotificationContext) → Accept/Decline modal when WS is asleep.
  useEffect(() => {
    setIncomingCallPushHandler(presentIncoming);
    return () => setIncomingCallPushHandler(null);
  }, [presentIncoming]);

  // After background, the personal socket may have missed `call_incoming`.
  // Reconcile against active DM calls the user has not joined yet.
  // After background, the personal socket may have missed `call_incoming`.
  // Reconcile against active DM calls the user has not joined yet.
  const recoverIncomingFromServer = useCallback(async () => {
    if (!userId || statusRef.current !== 'idle') return;
    try {
      const { data: calls } = await appApi.chatCalls.active();
      const candidate = (calls ?? []).find((call) => {
        // Only DM rings (same rule as the backend push). Older API builds omit
        // channelType — skip those rows rather than risk ringing a channel huddle.
        if (call.channelType !== 'dm') return false;
        if (!call.initiatorId || call.initiatorId === userId) return false;
        // Only the initiator is on the call so far — still ringing for us.
        if ((call.participantCount ?? 0) > 1) return false;
        return call.status === 'ringing' || call.status === 'active';
      });
      if (!candidate || statusRef.current !== 'idle') return;
      presentIncoming({
        callId: candidate.callId,
        channelId: candidate.channelId,
        callType: candidate.callType ?? 'voice',
        callerName: candidate.initiatorName || 'Incoming call',
      });
    } catch {
      // best-effort recovery
    }
  }, [userId, presentIncoming]);

  useEffect(() => {
    void recoverIncomingFromServer();
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      void recoverIncomingFromServer();
      // Also re-surface from a still-presented OS banner (works even before the
      // enriched /active response is deployed).
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- native module absent in Expo Go
        const Notifications = require('expo-notifications') as typeof import('expo-notifications');
        void Notifications.getPresentedNotificationsAsync().then((presented) => {
          if (statusRef.current !== 'idle') return;
          for (const n of presented) {
            const data = (n.request.content.data ?? {}) as Record<string, unknown>;
            const payload = incomingCallPayloadFromNotificationData(data);
            if (payload) {
              presentIncoming(payload);
              return;
            }
          }
        });
      } catch {
        // Expo Go
      }
    });
    return () => sub.remove();
  }, [recoverIncomingFromServer, presentIncoming]);

  // Safety net: if we enter 'connecting' but never reach 'connected' — e.g. the
  // user backs out of the call room before the SFU room is joined — don't leave
  // the UI wedged in 'connecting' forever. Reset to idle after a timeout.
  useEffect(() => {
    if (status !== 'connecting') return;
    const timer = setTimeout(() => {
      // The effect only runs while status === 'connecting' and the cleanup
      // clears this timer the moment status changes, so reaching here means we
      // were stuck connecting for the full timeout.
      setStatus('idle');
      setSession(null);
    }, 30000);
    return () => clearTimeout(timer);
  }, [status]);

  // Ring (vibrate + ringtone) while an incoming call is pending; stop otherwise.
  useEffect(() => {
    if (status === 'ringing-incoming') {
      Vibration.vibrate(RING_PATTERN, true);
      return () => Vibration.cancel();
    }
    Vibration.cancel();
    return undefined;
  }, [status]);
  useLoopingSound(status === 'ringing-incoming', RINGTONE);

  // Personal-topic handler: incoming ring + remote cancellation.
  const handlePersonalEvent = useCallback((event: WorkspaceEvent<Record<string, unknown>>) => {
    if (event.event === 'call_incoming') {
      const d = event.data as unknown as IncomingCallData;
      if (!d?.callId) return;
      presentIncoming({
        callId: d.callId,
        channelId: d.channelId,
        callType: (d.callType as CallType) ?? 'voice',
        callerName: d.callerName ?? 'Incoming call',
        callerAvatar: d.callerAvatar,
      });
    } else if (event.event === 'call_started') {
      // A call became active in one of our channels — track it so the channel
      // screen can show a "Join call" banner.
      const d = event.data as { channelId?: string; callId?: string; callType?: string };
      if (d?.channelId && d?.callId) {
        setActiveChannelCalls((cur) => ({
          ...cur,
          [d.channelId as string]: {
            callId: d.callId as string,
            callType: (d.callType as CallType) ?? 'voice',
          },
        }));
      }
    } else if (event.event === 'call_ended') {
      // Clear the channel's active-call banner.
      const endedChannelId = (event.data as { channelId?: string })?.channelId;
      if (endedChannelId) {
        setActiveChannelCalls((cur) => {
          if (!(endedChannelId in cur)) return cur;
          const next = { ...cur };
          delete next[endedChannelId];
          return next;
        });
      }
      // Caller hung up before we answered — dismiss the ring + any lingering
      // OS push banner for this call (killed/background delivery path).
      const endedId = (event.data as { callId?: string })?.callId;
      setIncomingCall((cur) => {
        if (cur && (!endedId || endedId === cur.callId)) {
          setStatus('idle');
          return null;
        }
        return cur;
      });
      if (endedId) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports -- native module absent in Expo Go
          const { dismissPresentedNotificationsWhere } = require('@weldsuite/mobile-ui/services/notifications') as {
            dismissPresentedNotificationsWhere: (
              match: (data: Record<string, unknown>) => boolean,
            ) => Promise<void>;
          };
          void dismissPresentedNotificationsWhere((data) => {
            if (data.notificationType !== 'chat_incoming_call') return false;
            return data.entityId === endedId;
          });
        } catch {
          // Expo Go / missing native module — nothing to dismiss.
        }
      }
    }
  }, [presentIncoming]);

  useTopic<Record<string, unknown>>(userId ? `chat.user.${userId}` : '', handlePersonalEvent);

  const startCall = useCallback(
    async (channelId: string, callType: CallType, peer?: CallPeer) => {
      if (joinInFlightRef.current) return;
      joinInFlightRef.current = true;
      setStatus('connecting');
      try {
        const res = await appApi.chatCalls.startAndJoin({ channelId, callType });
        setSession({
          callId: res.data.callId,
          channelId,
          // Prefer the server's callType: start-and-join may have joined an
          // already-active call whose type differs from the requested one.
          callType: res.data.callType ?? callType,
          authToken: res.data.authToken,
          isDirect: peer?.isDirect,
          peerName: peer?.name,
          peerAvatar: peer?.avatar,
        });
        setMinimized(false);
      } catch (err) {
        console.error('[WeldChat:Call] startCall failed:', err);
        setSession(null);
        setStatus('idle');
        throw err;
      } finally {
        joinInFlightRef.current = false;
      }
    },
    [],
  );

  /** Join an already-active call by id and open the call overlay. */
  const joinCall = useCallback(
    async (callId: string, peer?: CallPeer) => {
      if (joinInFlightRef.current) return;
      joinInFlightRef.current = true;
      setStatus('connecting');
      try {
        const callRes = await appApi.chatCalls.get(callId);
        const call = callRes.data;
        const joinRes = await appApi.chatCalls.join(callId);
        setSession({
          callId,
          channelId: call.channelId,
          callType: call.callType,
          authToken: joinRes.data.authToken,
          isDirect: peer?.isDirect,
          peerName: peer?.name,
          peerAvatar: peer?.avatar,
        });
        setMinimized(false);
      } catch (err) {
        console.error('[WeldChat:Call] joinCall failed:', err);
        setSession(null);
        setStatus('idle');
        throw err;
      } finally {
        joinInFlightRef.current = false;
      }
    },
    [],
  );

  const joinCallById = useCallback(async (callId: string) => {
    if (joinInFlightRef.current) return;
    joinInFlightRef.current = true;
    setStatus('connecting');
    try {
      const callRes = await appApi.chatCalls.get(callId);
      const call = callRes.data;
      const joinRes = await appApi.chatCalls.join(callId);
      setSession({
        callId,
        channelId: call.channelId,
        callType: call.callType,
        authToken: joinRes.data.authToken,
      });
    } catch (err) {
      console.error('[WeldChat:Call] joinCallById failed:', err);
      setSession(null);
      setStatus('idle');
      throw err;
    } finally {
      joinInFlightRef.current = false;
    }
  }, []);

  const acceptIncomingCall = useCallback(async () => {
    const ic = incomingCall;
    if (!ic) return;
    if (joinInFlightRef.current) return;
    joinInFlightRef.current = true;
    Vibration.cancel();
    setIncomingCall(null);
    setStatus('connecting');
    try {
      const joinRes = await appApi.chatCalls.join(ic.callId);
      setSession({
        callId: ic.callId,
        channelId: ic.channelId,
        callType: ic.callType,
        authToken: joinRes.data.authToken,
      });
      setMinimized(false);
    } catch (err) {
      console.error('[WeldChat:Call] acceptIncomingCall failed:', err);
      setSession(null);
      setStatus('idle');
    } finally {
      joinInFlightRef.current = false;
    }
  }, [incomingCall]);

  const declineCall = useCallback(async () => {
    const ic = incomingCall;
    if (!ic) return;
    Vibration.cancel();
    setIncomingCall(null);
    setStatus('idle');
    try {
      await appApi.chatCalls.decline(ic.callId);
    } catch {
      /* best effort */
    }
  }, [incomingCall]);

  const leaveCall = useCallback(async () => {
    const s = session;
    setSession(null);
    setStatus('idle');
    setMinimized(false);
    if (s) {
      try {
        await appApi.chatCalls.leave(s.callId);
      } catch {
        /* best effort */
      }
    }
  }, [session]);

  const markConnected = useCallback(() => {
    setStatus((cur) => (cur === 'connecting' ? 'connected' : cur));
  }, []);

  const value = useMemo<CallContextValue>(
    () => ({
      status,
      incomingCall,
      session,
      minimized,
      minimizeCall,
      expandCall,
      activeChannelCalls,
      startCall,
      joinCall,
      joinCallById,
      setChannelActiveCall,
      acceptIncomingCall,
      declineCall,
      leaveCall,
      markConnected,
    }),
    [
      status,
      incomingCall,
      session,
      minimized,
      minimizeCall,
      expandCall,
      activeChannelCalls,
      startCall,
      joinCall,
      joinCallById,
      setChannelActiveCall,
      acceptIncomingCall,
      declineCall,
      leaveCall,
      markConnected,
    ],
  );

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}
