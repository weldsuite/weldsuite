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
import { AppState, Platform, Vibration } from 'react-native';
import { useAuth } from '@clerk/expo';
import { useTopic } from '@weldsuite/realtime/react';
import type { WorkspaceEvent } from '@weldsuite/realtime/types';
import { apiUrl, appApi } from '@/services/app-api';
import { useLoopingSound } from '@/hooks/useLoopingSound';
import {
  incomingCallPayloadFromNotificationData,
  setIncomingCallDismissHandler,
  setIncomingCallPushHandler,
  type IncomingCallPushPayload,
} from '@/lib/incoming-call-bridge';
import { incomingFromNativePayload, nativePayloadFromIncoming } from '@/lib/call-push';
import {
  addCallActionListener,
  configureNativeCalls,
  endNativeCall,
  isNativeCallsAvailable,
  releaseLockScreen,
  reportIncomingCall,
  takePendingCallActions,
  type NativeCallAction,
} from '@/modules/weldchat-calls';

/** iPhone rings through CallKit (also over the lock screen) instead of the in-app ring screen. */
const RINGS_THROUGH_CALLKIT = Platform.OS === 'ios' && isNativeCallsAvailable;

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
  /** Joined by answering a ring: the caller is already in the room, so no ringback. */
  answered?: boolean;
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

/** Ring-screen name when the ring did not say who is calling. */
const UNKNOWN_CALLER = 'Incoming call';

type JoinedParticipant = { userId: string; userName?: string; userAvatar?: string; leftAt?: string };

/**
 * Who you are talking to on an answered ring. The join response lists the
 * caller (they are already in the room), which also covers rings that arrived
 * without a name or avatar (server recovery, a bare push).
 */
function peerOfAnsweredCall(
  ic: IncomingCall,
  participants: JoinedParticipant[] | undefined,
  selfId: string | null | undefined,
): { name?: string; avatar?: string } {
  const caller = participants?.find((p) => p.userId !== selfId && !p.leftAt);
  const ringName = ic.callerName === UNKNOWN_CALLER ? undefined : ic.callerName;
  return {
    name: caller?.userName || ringName,
    avatar: caller?.userAvatar || ic.callerAvatar,
  };
}

export function CallProvider({ children }: Readonly<{ children: React.ReactNode }>) {
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
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // Guards a single in-flight start/join so a UI "Join" tap and a push-tap
  // (joinCallById) can't both request a join token for the same call and race
  // each other's setSession. Reset in every start/join path's finally block.
  const joinInFlightRef = useRef(false);

  const presentIncoming = useCallback((payload: IncomingCallPushPayload) => {
    if (!payload.callId) return;
    if (RINGS_THROUGH_CALLKIT) {
      // CallKit is the ring screen; it ignores a call it already shows.
      if (sessionRef.current?.callId !== payload.callId) reportIncomingCall(nativePayloadFromIncoming(payload));
      return;
    }
    if (statusRef.current !== 'idle') {
      // Already ringing for this same call (duplicate push/realtime): the
      // in-app ring screen has it, so a native ring for it must stop.
      if (incomingCallRef.current?.callId === payload.callId) endNativeCall(payload.callId);
      return;
    }
    // The in-app ring screen takes over from the native call notification.
    endNativeCall(payload.callId);
    setIncomingCall({
      callId: payload.callId,
      channelId: payload.channelId,
      callType: payload.callType ?? 'voice',
      callerName: payload.callerName || UNKNOWN_CALLER,
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

  // Server cancel / native ring taking over → drop the in-app ring for that call.
  useEffect(() => {
    setIncomingCallDismissHandler((callId) => {
      if (incomingCallRef.current?.callId !== callId) return;
      setIncomingCall(null);
      setStatus((cur) => (cur === 'ringing-incoming' ? 'idle' : cur));
    });
    return () => setIncomingCallDismissHandler(null);
  }, []);

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
        callerName: candidate.initiatorName || UNKNOWN_CALLER,
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
      if (sessionRef.current) endNativeCall(sessionRef.current.callId);
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

  // `call_ended` on the personal topic: clear the channel's banner and, when the
  // caller hung up before we answered, every ring for the call.
  const handleCallEnded = useCallback((data: { channelId?: string; callId?: string } | undefined) => {
    // Clear the channel's active-call banner.
    const endedChannelId = data?.channelId;
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
    const endedId = data?.callId;
    // ...and the native ring (CallKit / call notification). A call this
    // phone answered ends through leaveCall instead.
    if (endedId && sessionRef.current?.callId !== endedId) endNativeCall(endedId);
    setIncomingCall((cur) => {
      if (cur && (!endedId || endedId === cur.callId)) {
        setStatus('idle');
        return null;
      }
      return cur;
    });
    if (!endedId) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- native module absent in Expo Go
      const { dismissPresentedNotificationsWhere } = require('@weldsuite/mobile-ui/services/notifications') as {
        dismissPresentedNotificationsWhere: (
          match: (data: Record<string, unknown>) => boolean,
        ) => Promise<void>;
      };
      void dismissPresentedNotificationsWhere((pushData) => {
        if (pushData.notificationType !== 'chat_incoming_call') return false;
        return pushData.entityId === endedId;
      });
    } catch {
      // Expo Go / missing native module — nothing to dismiss.
    }
  }, []);

  // Personal-topic handler: incoming ring + remote cancellation.
  const handlePersonalEvent = useCallback((event: WorkspaceEvent<Record<string, unknown>>) => {
    if (event.event === 'call_incoming') {
      const d = event.data as unknown as IncomingCallData;
      if (!d?.callId) return;
      presentIncoming({
        callId: d.callId,
        channelId: d.channelId,
        callType: (d.callType as CallType) ?? 'voice',
        callerName: d.callerName || UNKNOWN_CALLER,
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
      handleCallEnded(event.data as { channelId?: string; callId?: string });
    }
  }, [presentIncoming, handleCallEnded]);

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

  /** Join a ringing call: the in-app Accept, or Answer on the native ring. */
  const acceptCall = useCallback(async (ic: IncomingCall) => {
    if (joinInFlightRef.current) return;
    joinInFlightRef.current = true;
    Vibration.cancel();
    setIncomingCall(null);
    setStatus('connecting');
    // Android: the notification stops ringing. iOS keeps the answered CallKit
    // call until the call ends (it owns the audio session).
    if (Platform.OS === 'android') endNativeCall(ic.callId);
    try {
      const joinRes = await appApi.chatCalls.join(ic.callId);
      const peer = peerOfAnsweredCall(ic, joinRes.data.participants, userId);
      setSession({
        callId: ic.callId,
        channelId: ic.channelId,
        callType: ic.callType,
        authToken: joinRes.data.authToken,
        // Only DMs ring, so an answered ring is always 1:1.
        isDirect: true,
        answered: true,
        peerName: peer.name,
        peerAvatar: peer.avatar,
      });
      setMinimized(false);
    } catch (err) {
      console.error('[WeldChat:Call] acceptIncomingCall failed:', err);
      endNativeCall(ic.callId);
      setSession(null);
      setStatus('idle');
    } finally {
      joinInFlightRef.current = false;
    }
  }, [userId]);

  const acceptIncomingCall = useCallback(async () => {
    if (incomingCall) await acceptCall(incomingCall);
  }, [incomingCall, acceptCall]);

  const declineCall = useCallback(async () => {
    const ic = incomingCall;
    if (!ic) return;
    Vibration.cancel();
    setIncomingCall(null);
    setStatus('idle');
    endNativeCall(ic.callId);
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
    releaseLockScreen();
    if (s) {
      endNativeCall(s.callId);
      try {
        await appApi.chatCalls.leave(s.callId);
      } catch {
        /* best effort */
      }
    }
  }, [session]);
  const leaveCallRef = useRef(leaveCall);
  leaveCallRef.current = leaveCall;

  /** Answer / Decline / tap / hang-up on the native ring (CallKit, call notification). */
  const handleNativeAction = useCallback(
    (event: NativeCallAction) => {
      const callId = event.payload.callId ?? '';
      const incoming = incomingFromNativePayload(event.payload);
      switch (event.action) {
        case 'accept':
          if (incoming && sessionRef.current?.callId !== callId) void acceptCall(incoming);
          break;
        case 'open':
          if (incoming) presentIncoming(incoming);
          break;
        case 'decline':
          Vibration.cancel();
          if (incomingCallRef.current?.callId === callId) {
            setIncomingCall(null);
            setStatus((cur) => (cur === 'ringing-incoming' ? 'idle' : cur));
          }
          // Native already declined with the ring token when it had one.
          if (callId && event.payload.handledNatively !== 'true') {
            appApi.chatCalls.decline(callId).catch(() => {});
          }
          break;
        case 'end':
          if (sessionRef.current?.callId === callId) void leaveCallRef.current();
          break;
        default:
          // 'mute' is handled by the call room (InCallRoom), which owns the mic.
          break;
      }
    },
    [acceptCall, presentIncoming],
  );

  useEffect(() => {
    if (!userId || !isNativeCallsAvailable) return;
    configureNativeCalls(apiUrl('/public/chat-calls/decline'));
    const unsubscribe = addCallActionListener(handleNativeAction);
    // Answer on a closed app: the tap happened before JS (and auth) was up.
    for (const action of takePendingCallActions()) handleNativeAction(action);
    return unsubscribe;
  }, [userId, handleNativeAction]);

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
