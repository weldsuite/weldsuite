/**
 * WeldChat Call Context
 *
 * Global provider for voice/video call state management.
 * Uses Cloudflare RealtimeKit SDK — the SDK handles all WebRTC internally.
 * The backend only creates meetings and returns auth tokens.
 */

import React, { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useLeaveCallGuard } from '@weldsuite/weldmeet-ui';
import type RealtimeKitClient from '@cloudflare/realtimekit';
import {
  createRnnoiseSuppressor,
  installGetUserMediaPatch,
  type NoiseSuppressor,
} from '@weldsuite/df3-noise-suppression';
import rnnoiseWorkerUrl from '@weldsuite/df3-noise-suppression/rnnoise-worker?worker&url';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useAuth, useUser } from '@clerk/clerk-react';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';
import { weldchatKeys } from '@/hooks/queries/use-weldchat-queries';
import { useCallSwitchOptional, useRegisterActiveCall } from '@/contexts/active-call-context';
import { rtkParticipantIds, useCallSupersededNotice } from '@/hooks/use-call-superseded-notice';
import { chatCallLabel, type CallLabelRole } from '@/lib/call-switch-labels';
import { playCallJoinSound, playCallLeaveSound, playIncomingRingSound, playMuteSound, playUnmuteSound, playCameraToggleSound, playScreenShareSound, playHandRaiseSound, playHandLowerSound } from '@/lib/utils/notification-sound';
import { useVirtualBackground, type VirtualBackgroundType } from '@/hooks/use-virtual-background';
import { RoomClient } from '@weldsuite/realtime/client';
import { useTopic } from '@weldsuite/realtime/react';
import type { WorkspaceEvent } from '@weldsuite/realtime';
import { usePresenceMaybe } from '@/contexts/presence-context';
import type { PresenceStatus } from '@weldsuite/ui/components/status-dot';
import { apiUrl, getRealtimeWsOrigin } from '@/lib/api/public-env';

const REALTIME_BASE_URL = getRealtimeWsOrigin();

// RNNoise noise suppression flag. Default ON; set VITE_NOISE_SUPPRESSION=false
// (legacy alias VITE_DF3_NOISE_SUPPRESSION=false) to disable.
const NOISE_SUPPRESSION_ENABLED =
  import.meta.env.VITE_NOISE_SUPPRESSION !== 'false' &&
  import.meta.env.VITE_DF3_NOISE_SUPPRESSION !== 'false';

const NOISE_WORKLET_URL = '/df3-worklet-processor.js';

let realtimeKit: Promise<typeof import('@cloudflare/realtimekit')> | null = null;

/** The RealtimeKit SDK chunk, loaded once and shared by the prefetch and every call. */
function loadRealtimeKit(): Promise<typeof import('@cloudflare/realtimekit')> {
  realtimeKit ??= import('@cloudflare/realtimekit').catch((err: unknown) => {
    realtimeKit = null;
    throw err;
  });
  return realtimeKit;
}

let callAssetsRequested = false;

/**
 * Download what connecting a call needs before anyone clicks: the RealtimeKit
 * SDK chunk and the RNNoise worker + worklet. Loading them on "accept" /
 * "call" put seconds of downloading between the click and being connected,
 * worst on the first call after a page load. Runs once per page (on idle,
 * and again as soon as a call rings or starts in case idle never came).
 */
function prefetchCallAssets(): void {
  loadRealtimeKit().catch(() => undefined);
  if (callAssetsRequested || !NOISE_SUPPRESSION_ENABLED) return;
  callAssetsRequested = true;
  for (const url of [rnnoiseWorkerUrl, NOISE_WORKLET_URL]) {
    // Read to the end so the response lands in the HTTP cache.
    fetch(url)
      .then((res) => res.arrayBuffer())
      .catch(() => undefined);
  }
}

/** One toast for the whole reconnect: "reconnecting" is replaced by "back in the call". */
const RECONNECT_TOAST_ID = 'weldchat-reconnecting';

/**
 * How long a dropped connection may last before "reconnecting" is shown. The
 * SDK is usually back within a second or two, and flashing a toast (then
 * "back in the call") for that made a blip look like being thrown out.
 */
export const RECONNECT_TOAST_DELAY_MS = 3_000;

/** How long a deliberate leave waits for RealtimeKit before telling the backend anyway. */
const RTK_LEAVE_TIMEOUT_MS = 2_000;

/** How long a switch waits for a still-connecting call to settle before dropping it. */
const CONNECT_SETTLE_TIMEOUT_MS = 15_000;

/** How long the "call ended" card stays up after a call, before the call view closes. */
export const CALL_ENDED_VISIBLE_MS = 1_600;

// ============================================================================
// Helpers
// ============================================================================

interface CachedChannel {
  type?: string;
  name?: string | null;
}

interface CachedMember {
  userId?: string;
  name?: string;
  email?: string;
}

/**
 * What the "switch call" dialog calls the call in `channelId`: the other
 * people for a DM / group DM, the channel name otherwise. Reads whatever the
 * query cache already holds (the call UI loads it), and falls back to a
 * generic name rather than fetching for a label.
 */
function describeChannelCall(
  queryClient: QueryClient,
  channelId: string | null,
  selfUserId: string | undefined,
  role: CallLabelRole,
): string {
  const channel = channelId
    ? queryClient.getQueryData<{ data?: CachedChannel }>(weldchatKeys.channelDetail(channelId))?.data
    : undefined;
  if (!channelId || !channel) return chatCallLabel({ role });
  if (channel.type === 'dm' || channel.type === 'group') {
    const members = queryClient.getQueryData<{ data?: CachedMember[] }>(weldchatKeys.members(channelId))?.data ?? [];
    const names = members
      .filter((member) => member.userId !== selfUserId)
      .map((member) => member.name || member.email)
      .filter((name): name is string => !!name);
    return chatCallLabel({ role, person: names.join(', ') || null });
  }
  return chatCallLabel({ role, channelName: channel.name });
}

/**
 * Explicitly stop the local camera/mic MediaStreamTracks held by the RTK
 * client. RealtimeKit's `leave()` does not reliably stop the underlying
 * hardware tracks in the browser, so without this the OS camera/mic indicator
 * stays lit after the user leaves the call. Each getter can throw when the
 * corresponding media is disabled, so every read is guarded.
 */
/**
 * RealtimeKit's public `Self` type doesn't expose these fields/methods, but
 * the SDK's runtime object does. Used for hardware track cleanup and
 * screen-share quality tuning that has no first-class typed API.
 */
interface RealtimeKitSelfInternal {
  videoTrack?: MediaStreamTrack;
  audioTrack?: MediaStreamTrack;
  rawVideoTrack?: MediaStreamTrack;
  rawAudioTrack?: MediaStreamTrack;
  screenShareTracks?: { video?: MediaStreamTrack; audio?: MediaStreamTrack };
  screenShareEnabled?: boolean;
  updateScreenshareConstraints?: (constraints: {
    width?: { ideal: number };
    height?: { ideal: number };
    frameRate?: { ideal: number };
  }) => Promise<void>;
}

function stopLocalMediaTracks(meeting: RealtimeKitClient | null) {
  if (!meeting) return;
  const self = meeting.self as unknown as RealtimeKitSelfInternal;
  const stop = (read: () => MediaStreamTrack | undefined) => {
    try {
      read()?.stop();
    } catch {
      /* track unavailable or already stopped */
    }
  };
  stop(() => self?.videoTrack);
  stop(() => self?.audioTrack);
  stop(() => self?.rawVideoTrack);
  stop(() => self?.rawAudioTrack);
  stop(() => self?.screenShareTracks?.video);
  stop(() => self?.screenShareTracks?.audio);
}

function pickIdeal(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && 'ideal' in v && typeof (v as { ideal: unknown }).ideal === 'number') {
    return (v as { ideal: number }).ideal;
  }
  return undefined;
}

/**
 * Applies the resolution/framerate the user picked in the share picker via the
 * SDK-supported updateScreenshareConstraints, retuning the active track in
 * place. Failures are logged and never abort the share.
 */
async function applyScreenShareConstraints(
  self: RealtimeKitSelfInternal,
  constraints?: DisplayMediaStreamOptions,
): Promise<void> {
  const videoConstraints = (constraints?.video && typeof constraints.video === 'object')
    ? (constraints.video as MediaTrackConstraints)
    : undefined;
  const width = pickIdeal(videoConstraints?.width);
  const height = pickIdeal(videoConstraints?.height);
  const frameRate = pickIdeal(videoConstraints?.frameRate);

  if (!width || !height) return;
  try {
    await self.updateScreenshareConstraints?.({
      width: { ideal: width },
      height: { ideal: height },
      ...(frameRate ? { frameRate: { ideal: frameRate } } : {}),
    });
  } catch (err) {
    console.warn('[WeldChat] updateScreenshareConstraints failed:', err);
  }
}

// ============================================================================
// Types
// ============================================================================

/**
 * `ended` is the short goodbye after a call: the room is gone and the call
 * view shows a "call ended" card for CALL_ENDED_VISIBLE_MS, then goes `idle`.
 */
export type CallStatus = 'idle' | 'preview' | 'ringing-outgoing' | 'ringing-incoming' | 'connecting' | 'connected' | 'ended';

/** Why the call view says goodbye: the user left (others may carry on), or the call is over. */
export type CallEndReason = 'left' | 'ended';

export interface IncomingCall {
  callId: string;
  channelId: string;
  callType: 'voice' | 'video';
  callerName: string;
  callerAvatar?: string;
}

/** `POST /chat-calls/start-and-join` and `POST /chat-calls/:id/join` responses. */
interface JoinChatCallResponse {
  data: {
    callId: string;
    authToken: string;
    /** Sent by /join (and by start-and-join for callType); absent from older servers. */
    channelId?: string;
    callType?: string;
  };
}

/** `POST /chat-calls/:id/prepare` response: a token minted while the call rings. */
interface PrepareChatCallResponse {
  data: {
    callId: string;
    channelId: string;
    callType: string;
    authToken: string;
  };
}

/** `GET /chat-calls/:id` response — a `chat_calls` row plus resolved participants. */
interface ChatCallDetailResponse {
  data: {
    id: string;
    channelId: string;
    callType: string;
  };
}

type CallViewMode = 'grid' | 'spotlight' | 'speaker' | 'sidebar';

interface WeldChatCallState {
  callId: string | null;
  channelId: string | null;
  callType: 'voice' | 'video';
  status: CallStatus;
  /** Set while `status` is `ended`. */
  endReason: CallEndReason | null;
  /** True when the local user started this call (vs. joined/answered an existing one). */
  isCallInitiator: boolean;
  isMuted: boolean;
  isVideoOff: boolean;
  isScreenSharing: boolean;
  duration: number;
  incomingCall: IncomingCall | null;
  meeting: RealtimeKitClient | null;
  handRaised: boolean;
  handRaisedParticipants: Set<string>;
  previewStream: MediaStream | null;
  previewAudioEnabled: boolean;
  previewVideoEnabled: boolean;
  previewJoinCallId: string | null;
  isFullscreen: boolean;
  isPiP: boolean;
  viewMode: CallViewMode;
  backgroundType: VirtualBackgroundType;
  backgroundValue: string | null;
  isBackgroundLoading: boolean;
}

interface WeldChatCallActions {
  startCall: (channelId: string, callType: 'voice' | 'video') => Promise<void>;
  joinCall: (callId: string) => Promise<void>;
  confirmJoinFromPreview: () => Promise<void>;
  cancelPreview: () => void;
  togglePreviewAudio: () => void;
  togglePreviewVideo: () => void;
  leaveCall: () => Promise<void>;
  endCall: () => Promise<void>;
  declineCall: () => Promise<void>;
  acceptIncomingCall: () => Promise<void>;
  toggleMute: () => void;
  toggleVideo: () => void;
  startScreenShare: (constraints?: DisplayMediaStreamOptions) => Promise<void>;
  stopScreenShare: () => void;
  toggleHandRaise: () => void;
  toggleFullscreen: () => void;
  minimizeToPiP: () => void;
  expandFromPiP: () => void;
  setViewMode: (mode: CallViewMode) => void;
  applyBlur: (intensity?: number) => Promise<void>;
  applyImage: (url: string) => Promise<void>;
  removeBackground: () => void;
}

type WeldChatCallContextValue = WeldChatCallState & WeldChatCallActions;

// ============================================================================
// Context
// ============================================================================

const WeldChatCallContext = createContext<WeldChatCallContextValue | null>(null);

export function useWeldChatCall() {
  const ctx = useContext(WeldChatCallContext);
  if (!ctx) throw new Error('useWeldChatCall must be used within WeldChatCallProvider');
  return ctx;
}

export function useWeldChatCallOptional() {
  return useContext(WeldChatCallContext);
}

// ============================================================================
// Provider
// ============================================================================

export function WeldChatCallProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  const { getClient } = useAppApiClient();
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const { user } = useUser();

  const [callId, setCallId] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [callType, setCallType] = useState<'voice' | 'video'>('voice');
  const [status, setStatus] = useState<CallStatus>('idle');
  const [endReason, setEndReason] = useState<CallEndReason | null>(null);
  const [isCallInitiator, setIsCallInitiator] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [duration, setDuration] = useState(0);
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [handRaised, setHandRaised] = useState(false);
  const [handRaisedParticipants, setHandRaisedParticipants] = useState<Set<string>>(new Set());
  const [meeting, setMeeting] = useState<RealtimeKitClient | null>(null);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [previewAudioEnabled, setPreviewAudioEnabled] = useState(true);
  const [previewVideoEnabled, setPreviewVideoEnabled] = useState(true);
  const [previewJoinCallId, setPreviewJoinCallId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPiP, setIsPiP] = useState(false);
  const [viewMode, setViewMode] = useState<CallViewMode>('grid');

  // Mirror call activity into the shared presence status so other users see
  // a "busy" indicator while this user is in a call. We snapshot the pre-call
  // status the first time we flip to busy and restore it when the call ends.
  // PresenceProvider may not be mounted (e.g., HMR ordering, auth pages) — in
  // that case skip the side-effect rather than crashing the shell.
  const presence = usePresenceMaybe();
  const myStatus = presence?.myStatus;
  const setMyStatus = presence?.setMyStatus;
  const preCallStatusRef = useRef<PresenceStatus | null>(null);
  useEffect(() => {
    if (!setMyStatus) return;
    const activeStatuses: CallStatus[] = ['connecting', 'connected', 'ringing-outgoing'];
    const isActive = activeStatuses.includes(status);
    if (isActive) {
      if (preCallStatusRef.current == null) {
        preCallStatusRef.current = (myStatus?.status as PresenceStatus) ?? 'online';
        setMyStatus('busy');
      }
    } else if (preCallStatusRef.current != null) {
      const restore = preCallStatusRef.current;
      preCallStatusRef.current = null;
      // Only restore if we're still marked busy (don't stomp a manual change).
      if (myStatus?.status === 'busy') setMyStatus(restore);
    }
  }, [status, myStatus?.status, setMyStatus]);

  // Auto-apply saved virtual background preference when meeting starts
  const virtualBackground = useVirtualBackground(meeting);

  const toggleFullscreen = useCallback(() => {
    setIsFullscreen(prev => !prev);
    setIsPiP(false);
  }, []);

  const minimizeToPiP = useCallback(() => {
    setIsPiP(true);
    setIsFullscreen(false);
  }, []);

  const expandFromPiP = useCallback(() => {
    setIsPiP(false);
  }, []);

  const callSwitch = useCallSwitchOptional();
  // The server drops the older connection when this user joins another call or
  // the same one again elsewhere, and says so just before the kick.
  const supersededNotice = useCallSupersededNotice({
    kind: 'chat',
    userId: user?.id,
    message: () => getTranslations('weldchat').calling.supersededByOtherCall,
  });
  const explainUnexpectedExit = supersededNotice.explainExit;

  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Noise suppression handles (active only when NOISE_SUPPRESSION_ENABLED).
  const suppressorRef = useRef<NoiseSuppressor | null>(null);
  const suppressorRestoreRef = useRef<(() => void) | null>(null);
  const callIdRef = useRef<string | null>(null);
  const channelIdRef = useRef<string | null>(null);

  // Keep refs in sync so pagehide / roomLeft can access latest values
  useEffect(() => { callIdRef.current = callId; }, [callId]);
  useEffect(() => { channelIdRef.current = channelId; }, [channelId]);

  // Ref to hold the latest Clerk JWT so pagehide can use it synchronously
  const authTokenRef = useRef<string | null>(null);

  // Keep the token fresh while in an active call
  useEffect(() => {
    if (status === 'idle' || status === 'ended' || status === 'preview') return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const t = await getToken();
        if (!cancelled) authTokenRef.current = t;
      } catch { /* ignore */ }
    };
    void refresh();
    // Refresh every 30s to keep the token valid for pagehide
    const iv = setInterval(refresh, 30_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [status, getToken]);

  // Fire-and-forget leave notification for tab close / disconnect scenarios.
  // Uses fetch with keepalive (supports auth headers, survives page unload).
  const fireLeaveRequest = useCallback((cId: string) => {
    const url = apiUrl(`/api/chat-calls/${cId}/leave`);
    const token = authTokenRef.current;
    if (!token) return;
    // Best effort: a failed leave notification must never block teardown.
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
      keepalive: true,
    }).catch(() => {});
  }, []);

  // Confirm before a reload / tab close drops an active call, and notify the
  // backend once the page really goes away so the call doesn't stay open.
  useLeaveCallGuard({
    warn: status === 'ringing-outgoing' || status === 'connecting' || status === 'connected',
    onLeave: () => {
      const cId = callIdRef.current;
      if (cId) fireLeaveRequest(cId);
    },
  });

  // Duration timer
  useEffect(() => {
    if (status === 'connected') {
      durationTimerRef.current = setInterval(() => {
        setDuration((d) => d + 1);
      }, 1000);
    } else if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
    return () => {
      if (durationTimerRef.current) clearInterval(durationTimerRef.current);
    };
  }, [status]);

  // ── Incoming call listener via WorkspaceHub topic ────────────────────────
  // Keep a ref to status so the useTopic handler never closes over a stale value
  const statusRef = useRef<CallStatus>(status);
  useEffect(() => { statusRef.current = status; }, [status]);

  // Fetch the call SDK and noise-suppression files once the shell is idle, so
  // the first call of the session does not download them after the click.
  useEffect(() => {
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(prefetchCallAssets, { timeout: 10_000 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = setTimeout(prefetchCallAssets, 3_000);
    return () => clearTimeout(timer);
  }, []);

  /** Back to no call at all. Touches no RealtimeKit room: callers leave it first. */
  const resetCallState = useCallback(() => {
    setMeeting(null);
    setCallId(null);
    setChannelId(null);
    setStatus('idle');
    setEndReason(null);
    setIsCallInitiator(false);
    setDuration(0);
    setIsMuted(false);
    setIsVideoOff(false);
    setIsScreenSharing(false);
    // A ring for another call (it came in while this one was live) keeps ringing.
    setHandRaised(false);
    setHandRaisedParticipants(new Set());
    setIsPiP(false);
    setIsFullscreen(false);
  }, []);

  // Closes the "call ended" card (see CallStatus `ended`).
  const farewellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearFarewell = useCallback(() => {
    if (farewellTimerRef.current) clearTimeout(farewellTimerRef.current);
    farewellTimerRef.current = null;
  }, []);
  useEffect(() => clearFarewell, [clearFarewell]);

  /** A new call takes the view over: drop what the last one left behind. */
  const enterConnecting = useCallback(() => {
    clearFarewell();
    setEndReason(null);
    setDuration(0);
    setIsFullscreen(false);
    setIsPiP(false);
    setStatus('connecting');
  }, [clearFarewell]);

  const getClientRef = useRef(getClient);
  getClientRef.current = getClient;

  // RealtimeKit tokens asked for while a call rings (POST /:id/prepare), by
  // call id. Accepting connects with it straight away instead of waiting for
  // the server to add us to the room first. Null when preparing failed: the
  // accept then joins the usual way.
  const preparedJoinsRef = useRef(new Map<string, Promise<string | null>>());

  const prepareJoin = useCallback((id: string) => {
    if (preparedJoinsRef.current.has(id)) return;
    const prepared = (async () => {
      const client = await getClientRef.current();
      const res = await client.post<PrepareChatCallResponse>(`/chat-calls/${id}/prepare`, {});
      return res.data.authToken;
    })().catch(() => null);
    preparedJoinsRef.current.set(id, prepared);
  }, []);

  /** The prepared token for `id` (waiting for one still on its way), used once. */
  const takePreparedJoin = useCallback((id: string): Promise<string | null> => {
    const prepared = preparedJoinsRef.current.get(id) ?? Promise.resolve(null);
    preparedJoinsRef.current.delete(id);
    return prepared;
  }, []);

  const handleIncomingCallEvent = useCallback(
    (event: WorkspaceEvent<{
      callId: string;
      channelId: string;
      callType: 'voice' | 'video';
      callerName: string;
      callerAvatar?: string;
    }>) => {
      if (event.event !== 'call_incoming') return;
      // A ring for the call we are already in (our own start, another tab's join).
      if (callIdRef.current === event.data.callId) return;
      setIncomingCall({
        callId: event.data.callId,
        channelId: event.data.channelId,
        callType: event.data.callType,
        callerName: event.data.callerName,
        callerAvatar: event.data.callerAvatar,
      });
      // While it rings, get everything accepting needs: the SDK files and a
      // token for the room. Answering is then just connecting.
      prefetchCallAssets();
      prepareJoin(event.data.callId);
      // Busy (in a call or meeting): it still rings, but only as the toast. The
      // status stays what the live call needs, and accepting asks to switch.
      if (statusRef.current === 'ended') {
        // The goodbye of the last call gives way to the ring.
        clearFarewell();
        resetCallState();
      }
      if (statusRef.current === 'idle' || statusRef.current === 'ended') {
        setStatus('ringing-incoming');
      }
    },
    [prepareJoin, clearFarewell, resetCallState],
  );

  useTopic(user?.id ? `chat.user.${user.id}` : '', handleIncomingCallEvent);

  // The callee hears a ringtone while the incoming call popup is up. It goes
  // quiet after 30s, the same window the caller's "calling" tiles ring for.
  useEffect(() => {
    if (status !== 'ringing-incoming') return;
    playIncomingRingSound();
    const iv = setInterval(() => playIncomingRingSound(), 2600);
    const quiet = setTimeout(() => clearInterval(iv), 30_000);
    return () => {
      clearInterval(iv);
      clearTimeout(quiet);
    };
  }, [status]);

  // RoomClient for hand-raise events via realtime-worker
  const handRaiseRoomRef = useRef<RoomClient | null>(null);
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  useEffect(() => {
    if (!channelId || status !== 'connected') {
      // Disconnect previous room if channel/status changed
      if (handRaiseRoomRef.current) {
        handRaiseRoomRef.current.disconnect();
        handRaiseRoomRef.current = null;
      }
      return;
    }

    const rc = new RoomClient({
      url: `${REALTIME_BASE_URL}/ws/chat/${channelId}`,
      getToken: async () => (await getTokenRef.current()) || '',
    });
    handRaiseRoomRef.current = rc;

    const unsubRaise = rc.on('call:hand-raised', (ev) => {
      setHandRaisedParticipants(prev => new Set([...prev, ev.userId]));
      if (ev.userId !== user?.id) {
        playHandRaiseSound();
      }
    });

    const unsubLower = rc.on('call:hand-lowered', (ev) => {
      setHandRaisedParticipants(prev => {
        const next = new Set(prev);
        next.delete(ev.userId);
        return next;
      });
    });

    rc.connect().catch((err) => {
      console.error('[WeldChat:Call] Hand-raise room connect failed:', err);
    });

    return () => {
      unsubRaise();
      unsubLower();
      rc.disconnect();
      handRaiseRoomRef.current = null;
    };
  }, [channelId, status, user?.id]);

  /** Restore getUserMedia first, then dispose the suppressor. */
  const releaseSuppressor = useCallback(() => {
    try { suppressorRestoreRef.current?.(); } catch { /* ignore */ }
    suppressorRestoreRef.current = null;
    const suppressor = suppressorRef.current;
    suppressorRef.current = null;
    if (suppressor) {
      suppressor.dispose().catch((err) => console.warn('[noise] dispose error:', err));
    }
  }, []);

  /**
   * Start what connecting needs that does not wait for the server: the SDK
   * download and, with the mic on, the noise suppressor (its worklet and
   * RNNoise worker build in the background). Called from the click, so all of
   * it overlaps the API request instead of following it. Idempotent per call.
   *
   * Noise suppression path: getUserMedia is monkey-patched so RTK's internal
   * mic acquisition flows through RNNoise (initMeeting then turns off RTK's
   * browser-level NS so we don't double-process).
   */
  const prepareMedia = useCallback((audioOn: boolean) => {
    prefetchCallAssets();
    if (!NOISE_SUPPRESSION_ENABLED || !audioOn || suppressorRef.current) return;
    const suppressor = createRnnoiseSuppressor({
      workerUrl: rnnoiseWorkerUrl,
      workletUrl: NOISE_WORKLET_URL,
      // `import.meta.env.PROD` is Vite's build-time boolean, not a turbo-tracked
      // process.env var — eslint-plugin-turbo doesn't distinguish the two.
      logRtf: !import.meta.env.PROD,
    });
    suppressor.warm();
    suppressorRef.current = suppressor;
    suppressorRestoreRef.current = installGetUserMediaPatch(suppressor);
  }, []);

  // A connection drop still waiting to be announced (timer), or announced (shown).
  const reconnectNoticeRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; shown: boolean }>({
    timer: null,
    shown: false,
  });

  /** Forget the current connection drop; true when "reconnecting" was on screen. */
  const settleReconnectNotice = useCallback((): boolean => {
    const notice = reconnectNoticeRef.current;
    const wasShown = notice.shown;
    if (notice.timer) clearTimeout(notice.timer);
    notice.timer = null;
    notice.shown = false;
    return wasShown;
  }, []);

  const cleanup = useCallback(() => {
    settleReconnectNotice();
    toast.dismiss(RECONNECT_TOAST_ID);
    if (meeting) {
      // Stop the local hardware tracks BEFORE leaving — RTK's leave() does not
      // reliably release the camera/mic, so the device indicator would otherwise
      // stay on after the call ends.
      stopLocalMediaTracks(meeting);
      // Also reached after the room was already left (a deliberate leave does
      // that first), so a leave() that throws must not abort the teardown.
      Promise.resolve()
        .then(() => meeting.leave())
        .catch(() => { /* ignore */ });
    }
    releaseSuppressor();
    clearFarewell();
    resetCallState();
  }, [meeting, releaseSuppressor, clearFarewell, resetCallState, settleReconnectNotice]);

  /**
   * The call is over for this user: the room view gives way at once to a
   * "call ended" card (with the leave chime), which closes by itself after
   * CALL_ENDED_VISIBLE_MS. Callers stop the local tracks and leave the room;
   * this only ends the UI side. A ring or a new call in between takes over.
   */
  const showCallEnded = useCallback((reason: CallEndReason) => {
    settleReconnectNotice();
    toast.dismiss(RECONNECT_TOAST_ID);
    playCallLeaveSound();
    releaseSuppressor();
    setMeeting(null);
    setCallId(null);
    setIsScreenSharing(false);
    setHandRaised(false);
    setHandRaisedParticipants(new Set());
    setIsPiP(false);
    setEndReason(reason);
    setStatus('ended');
    clearFarewell();
    farewellTimerRef.current = setTimeout(() => {
      farewellTimerRef.current = null;
      if (statusRef.current === 'ended') resetCallState();
    }, CALL_ENDED_VISIBLE_MS);
  }, [releaseSuppressor, clearFarewell, resetCallState, settleReconnectNotice]);

  /**
   * A start or join that did not get through: back to no call, and say why.
   * When the server had already counted the user in, it is told they left.
   */
  const failConnect = useCallback((message: string) => {
    const counted = callIdRef.current;
    callIdRef.current = null;
    if (counted) fireLeaveRequest(counted);
    releaseSuppressor();
    clearFarewell();
    resetCallState();
    toast.error(message);
  }, [fireLeaveRequest, releaseSuppressor, clearFarewell, resetCallState]);

  /**
   * Leave the RealtimeKit room ahead of telling the backend about a leave: it
   * ends the call only once RealtimeKit reports the room empty, which it never
   * does while we are still connected. Bounded, so a dead connection cannot
   * hold up the hang-up.
   */
  const leaveRoom = useCallback(async () => {
    if (!meeting) return;
    stopLocalMediaTracks(meeting);
    await Promise.race([
      Promise.resolve()
        .then(() => meeting.leave())
        .catch(() => { /* ignore */ }),
      new Promise((resolve) => setTimeout(resolve, RTK_LEAVE_TIMEOUT_MS)),
    ]);
  }, [meeting]);

  const stopPreviewStream = useCallback(() => {
    setPreviewStream((prev) => {
      prev?.getTracks().forEach((t) => t.stop());
      return null;
    });
  }, []);

  const initMeeting = useCallback(async (authToken: string, type: 'voice' | 'video', audioOn = true, videoOn?: boolean) => {
    // Usually already done from the click (see prepareMedia).
    prepareMedia(audioOn);
    const useNoiseSuppression = suppressorRef.current !== null;

    let m: RealtimeKitClient;
    try {
      const { default: RTK } = await loadRealtimeKit();
      m = await RTK.init({
        authToken,
        defaults: {
          audio: audioOn,
          video: videoOn ?? (type === 'video'),
          mediaConfiguration: {
            audio: { noiseSupression: !useNoiseSuppression },
          },
        },
      });
    } catch (err) {
      releaseSuppressor();
      throw err;
    }

    // Set when join() fails: the room is then left here, which is no call ending.
    let abandoned = false;

    m.self.on('roomJoined', (payload) => {
      setStatus('connected');
      // The SDK got back in by itself after a dropped connection: no join chime.
      if (payload?.reconnected) {
        // A blip shorter than the toast delay never said "reconnecting", so
        // there is nothing to replace either.
        if (!settleReconnectNotice()) return;
        // An explicit duration: the "reconnecting" toast this replaces never expires.
        toast.success(getTranslations('weldchat').calling.reconnected, {
          id: RECONNECT_TOAST_ID,
          duration: 4000,
        });
        return;
      }
      playCallJoinSound();
    });

    m.self.on('roomLeft', ({ state }) => {
      // 'disconnected' is not a leave: the connection dropped and the SDK is
      // already reconnecting (it emits roomJoined { reconnected: true } once
      // back). Leaving here threw people out of the call on a short network
      // drop, and their /leave could end the call for everyone else.
      if (state === 'disconnected') {
        // Kept in the console so a drop can be matched to what the tab was doing.
        console.warn(`[WeldChat:Call] Connection dropped (tab ${document.visibilityState}), reconnecting`);
        const notice = reconnectNoticeRef.current;
        if (!notice.timer && !notice.shown) {
          notice.timer = setTimeout(() => {
            notice.timer = null;
            notice.shown = true;
            toast.loading(getTranslations('weldchat').calling.reconnecting, {
              id: RECONNECT_TOAST_ID,
              duration: Infinity,
            });
          }, RECONNECT_TOAST_DELAY_MS);
        }
        return;
      }
      // The ref is already cleared when the user left or ended the call
      // themselves (or the join was refused): whoever did that tears down.
      const cId = callIdRef.current;
      if (!cId || abandoned) return;
      callIdRef.current = null;
      // Notify the backend so the call auto-ends once the room is empty.
      fireLeaveRequest(cId);
      // The SDK gave up reconnecting; only a new call gets the user back in.
      if (state === 'failed') {
        toast.error(getTranslations('weldchat').calling.connectionLost);
      }
      // Removed without asking: the server may have done it because this user
      // joined another call or meeting, in which case it says so.
      if (state === 'ended' || state === 'kicked') {
        explainUnexpectedExit({ sessionId: cId, participantIds: rtkParticipantIds(m) });
      }
      stopLocalMediaTracks(m);
      showCallEnded('ended');
    });

    // The room view comes up now, with the user's own tile and controls, while
    // the join completes; the others' tiles appear as RealtimeKit adds them.
    setMeeting(m);
    try {
      await m.join();
    } catch (err) {
      abandoned = true;
      stopLocalMediaTracks(m);
      await Promise.resolve().then(() => m.leave()).catch(() => { /* ignore */ });
      setMeeting(null);
      releaseSuppressor();
      throw err;
    }
    return m;
  }, [fireLeaveRequest, explainUnexpectedExit, prepareMedia, releaseSuppressor, showCallEnded, settleReconnectNotice]);

  // ── Actions ──────────────────────────────────────────────────────────────

  // No pre-join preview for chat calls — join straight into the room (same as
  // acceptIncomingCall). Default audio on; video on only for video calls.
  const doStartCall = useCallback(async (chId: string, type: 'voice' | 'video') => {
    setCallType(type);
    setChannelId(chId);
    setPreviewJoinCallId(null);
    setIsCallInitiator(true);
    const videoOn = type === 'video';
    setIsMuted(false);
    setIsVideoOff(!videoOn);
    enterConnecting();
    // The SDK and the noise suppressor get ready while the request runs.
    prepareMedia(true);
    try {
      const client = await getClient();
      // Single round-trip: creates the call (in the DM's standing room) + joins.
      const res = await client.post<JoinChatCallResponse>('/chat-calls/start-and-join', { channelId: chId, callType: type });
      callIdRef.current = res.data.callId;
      setCallId(res.data.callId);
      await initMeeting(res.data.authToken, type, true, videoOn);
    } catch (err) {
      failConnect(getTranslations('weldchat').calling.startFailed);
      throw err;
    }
  }, [getClient, initMeeting, prepareMedia, enterConnecting, failConnect]);

  /**
   * Connect to a call that rang for us. With a token prepared while it rang,
   * RealtimeKit starts connecting at once and POST /join (which reuses that
   * participant) only records the answer, in parallel. If the join is refused
   * (the call ended while it rang), back out of the room again. A failure
   * throws; the caller resets the call (failConnect).
   */
  const joinRungCall = useCallback(async (id: string, preparedToken: string, type: 'voice' | 'video') => {
    const videoOn = type === 'video';
    const client = await getClient();
    const join = client.post<JoinChatCallResponse>(`/chat-calls/${id}/join`, {});
    const connecting = initMeeting(preparedToken, type, true, videoOn);
    // Awaited below; marked handled so a failure while the join is pending isn't reported as unhandled.
    connecting.catch(() => undefined);
    try {
      await join;
    } catch (err) {
      // The answer never counted, so no /leave either.
      callIdRef.current = null;
      const m = await connecting.catch(() => null);
      if (m) {
        stopLocalMediaTracks(m);
        await Promise.resolve().then(() => m.leave()).catch(() => { /* ignore */ });
      }
      throw err;
    }
    await connecting;
  }, [getClient, initMeeting]);

  /**
   * Join with POST /join alone: its answer carries the token and what kind of
   * call it is, so connecting starts straight after it (no GET of the call first).
   */
  const joinUnprepared = useCallback(async (id: string) => {
    const client = await getClient();
    let joinRes: JoinChatCallResponse;
    try {
      joinRes = await client.post<JoinChatCallResponse>(`/chat-calls/${id}/join`, {});
    } catch (err) {
      // The join never counted, so no /leave either.
      callIdRef.current = null;
      throw err;
    }
    // An older server leaves the call's channel and type out of the answer.
    const call = joinRes.data.channelId && joinRes.data.callType
      ? { channelId: joinRes.data.channelId, callType: joinRes.data.callType }
      : (await client.get<ChatCallDetailResponse>(`/chat-calls/${id}`)).data;
    const type = call.callType as 'voice' | 'video';
    const videoOn = type === 'video';
    setCallType(type);
    setChannelId(call.channelId);
    setIsVideoOff(!videoOn);
    await initMeeting(joinRes.data.authToken, type, true, videoOn);
  }, [getClient, initMeeting]);

  /** Answer a ring: everything about the call came with it, so connecting starts at once. */
  const doAcceptIncomingCall = useCallback(async (ic: IncomingCall) => {
    setIncomingCall((ringing) => (ringing?.callId === ic.callId ? null : ringing));

    // Skip preview for incoming calls — join immediately. The ring carried the
    // call's type and channel, so there is nothing to fetch first.
    const type = ic.callType;
    const videoOn = type === 'video';
    setCallType(type);
    setChannelId(ic.channelId);
    setPreviewJoinCallId(null);
    callIdRef.current = ic.callId;
    setCallId(ic.callId);
    setIsCallInitiator(false);
    setIsMuted(false);
    setIsVideoOff(!videoOn);
    enterConnecting();
    prepareMedia(true);

    try {
      const preparedToken = await takePreparedJoin(ic.callId);
      if (preparedToken) {
        await joinRungCall(ic.callId, preparedToken, type);
      } else {
        await joinUnprepared(ic.callId);
      }
    } catch (err) {
      failConnect(getTranslations('weldchat').calling.joinFailed);
      throw err;
    }
  }, [prepareMedia, takePreparedJoin, joinRungCall, joinUnprepared, enterConnecting, failConnect]);

  const incomingCallRef = useRef(incomingCall);
  incomingCallRef.current = incomingCall;

  const doJoinCall = useCallback(async (id: string) => {
    // Joining a call that is ringing for us (e.g. from its banner) answers the ring.
    const ringing = incomingCallRef.current;
    if (ringing?.callId === id) {
      await doAcceptIncomingCall(ringing);
      return;
    }

    prepareMedia(true);
    // The active-calls list knows the channel, so the call view can show
    // "connecting" there before the join answers.
    const listed = queryClient
      .getQueryData<Array<{ channelId: string; callId: string; callType?: 'voice' | 'video' }>>(['weldchat', 'active-calls'])
      ?.find((active) => active.callId === id);
    setChannelId(listed?.channelId ?? null);
    if (listed?.callType) setCallType(listed.callType);
    setPreviewJoinCallId(null);
    callIdRef.current = id;
    setCallId(id);
    setIsCallInitiator(false);
    setIsMuted(false);
    enterConnecting();
    try {
      await joinUnprepared(id);
    } catch (err) {
      failConnect(getTranslations('weldchat').calling.joinFailed);
      throw err;
    }
  }, [queryClient, prepareMedia, doAcceptIncomingCall, joinUnprepared, enterConnecting, failConnect]);

  // The latest closures, for a switch that only starts the call after the user
  // confirmed and the current one was left: the render that left it has run by
  // then, and a closure from before it would still hold the old RealtimeKit client.
  const doStartCallRef = useRef(doStartCall);
  doStartCallRef.current = doStartCall;
  const doJoinCallRef = useRef(doJoinCall);
  doJoinCallRef.current = doJoinCall;

  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;
  const selfUserIdRef = useRef(user?.id);
  selfUserIdRef.current = user?.id;

  /** Asks to leave the live call or meeting first, when there is one. */
  const startCall = useCallback(async (chId: string, type: 'voice' | 'video') => {
    await callSwitch.runWithSwitch({
      target: {
        kind: 'chat',
        label: () => describeChannelCall(queryClientRef.current, chId, selfUserIdRef.current, 'target'),
      },
      proceed: () => doStartCallRef.current(chId, type),
    });
  }, [callSwitch]);

  const joinCall = useCallback(async (id: string) => {
    // Already in it (a "Join" button for the call we are in): nothing to do.
    if (callIdRef.current === id) return;
    await callSwitch.runWithSwitch({
      target: {
        kind: 'chat',
        label: () => {
          const known = queryClientRef.current
            .getQueryData<Array<{ channelId: string; callId: string }>>(['weldchat', 'active-calls'])
            ?.find((active) => active.callId === id);
          return describeChannelCall(queryClientRef.current, known?.channelId ?? null, selfUserIdRef.current, 'target');
        },
      },
      proceed: () => doJoinCallRef.current(id),
    });
  }, [callSwitch]);

  const confirmJoinFromPreview = useCallback(async () => {
    const audioOn = previewAudioEnabled;
    const videoOn = previewVideoEnabled;
    setIsMuted(!audioOn);
    setIsVideoOff(!videoOn);
    stopPreviewStream();
    const client = await getClient();
    const type = callType;
    const chId = channelId;

    if (previewJoinCallId) {
      // Joining existing call
      setCallId(previewJoinCallId);
      enterConnecting();
      const joinRes = await client.post<JoinChatCallResponse>(`/chat-calls/${previewJoinCallId}/join`, {});
      await initMeeting(joinRes.data.authToken, type, audioOn, videoOn);
    } else if (chId) {
      // Starting new call — single round-trip: creates meeting + joins in one request
      enterConnecting();
      const res = await client.post<JoinChatCallResponse>('/chat-calls/start-and-join', { channelId: chId, callType: type });
      setCallId(res.data.callId);
      await initMeeting(res.data.authToken, type, audioOn, videoOn);
    }
    setPreviewJoinCallId(null);
  }, [stopPreviewStream, getClient, callType, channelId, previewJoinCallId, previewAudioEnabled, previewVideoEnabled, initMeeting, enterConnecting]);

  const cancelPreview = useCallback(() => {
    stopPreviewStream();
    setStatus('idle');
    setChannelId(null);
    setPreviewJoinCallId(null);
  }, [stopPreviewStream]);

  const togglePreviewAudio = useCallback(() => {
    if (previewStream) {
      const audioTrack = previewStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setPreviewAudioEnabled(audioTrack.enabled);
      }
    }
  }, [previewStream]);

  const togglePreviewVideo = useCallback(() => {
    if (previewStream) {
      const videoTrack = previewStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setPreviewVideoEnabled(videoTrack.enabled);
      }
    }
  }, [previewStream]);

  const doAcceptIncomingCallRef = useRef(doAcceptIncomingCall);
  doAcceptIncomingCallRef.current = doAcceptIncomingCall;

  /** Accepting while in another call or meeting asks to switch first; the ring stays until then. */
  const acceptIncomingCall = useCallback(async () => {
    if (!incomingCall) return;
    const ic = incomingCall;
    await callSwitch.runWithSwitch({
      target: { kind: 'chat', label: () => chatCallLabel({ role: 'target', caller: ic.callerName }) },
      proceed: () => doAcceptIncomingCallRef.current(ic),
    });
  }, [incomingCall, callSwitch]);

  const patchActiveCallsCache = useCallback((endedCallId: string) => {
    queryClient.setQueryData<Array<{ channelId: string; callId: string; callType: 'voice' | 'video' }>>(
      ['weldchat', 'active-calls'],
      (prev) => (prev ? prev.filter((c) => c.callId !== endedCallId) : prev),
    );
  }, [queryClient]);

  /**
   * Leave the call (the others carry on). The view says goodbye at once; the
   * room and the backend are told after, and the returned promise waits for
   * that (a switch joins the next call only once this one is left).
   */
  const leaveCall = useCallback(async () => {
    if (!callId) return;
    const endedCallId = callId;
    const chId = channelId;
    // Clear ref BEFORE leaving so the roomLeft handler doesn't fire a duplicate /leave
    callIdRef.current = null;
    if (meeting) stopLocalMediaTracks(meeting);
    showCallEnded('left');
    patchActiveCallsCache(endedCallId);
    await leaveRoom();
    const client = await getClient();
    try {
      await client.post(`/chat-calls/${endedCallId}/leave`, {});
    } catch { /* best effort */ }
    if (chId) {
      void queryClient.invalidateQueries({ queryKey: weldchatKeys.activeCall(chId) });
    }
  }, [callId, channelId, meeting, getClient, leaveRoom, showCallEnded, queryClient, patchActiveCallsCache]);

  /** End the call for everyone. Like leaving, the view says goodbye before the backend answers. */
  const endCall = useCallback(async () => {
    if (!callId) return;
    const endedCallId = callId;
    const chId = channelId;
    const m = meeting;
    // Clear ref first so the roomLeft the end causes doesn't fire a /leave
    callIdRef.current = null;
    if (m) stopLocalMediaTracks(m);
    showCallEnded('ended');
    patchActiveCallsCache(endedCallId);
    const client = await getClient();
    try {
      await client.post(`/chat-calls/${endedCallId}/end`, {});
    } catch { /* best effort */ }
    if (m) {
      // The end already removed everyone; a leave() that throws changes nothing.
      Promise.resolve()
        .then(() => m.leave())
        .catch(() => { /* ignore */ });
    }
    if (chId) {
      void queryClient.invalidateQueries({ queryKey: weldchatKeys.activeCall(chId) });
    }
  }, [callId, channelId, meeting, getClient, showCallEnded, queryClient, patchActiveCallsCache]);

  const declineCall = useCallback(async () => {
    if (!incomingCall) return;
    preparedJoinsRef.current.delete(incomingCall.callId);
    const client = await getClient();
    try {
      await client.post(`/chat-calls/${incomingCall.callId}/decline`, {});
    } catch { /* best effort */ }
    setIncomingCall(null);
    // Only the ring is over: when it came in during a call, that call carries on.
    setStatus((current) => (current === 'ringing-incoming' ? 'idle' : current));
  }, [incomingCall, getClient]);

  // ── Single active call ───────────────────────────────────────────────────
  // While this call is live it is registered with the coordinator, so joining
  // another call or a WeldMeet meeting can ask to leave it first.
  const meetingRef = useRef(meeting);
  useEffect(() => { meetingRef.current = meeting; }, [meeting]);
  const leaveCallRef = useRef(leaveCall);
  leaveCallRef.current = leaveCall;
  const cleanupRef = useRef(cleanup);
  cleanupRef.current = cleanup;
  const settleWaitersRef = useRef<Array<() => void>>([]);

  // A call that is still connecting has no call id or RealtimeKit room to leave
  // yet: this wakes whoever is waiting for it to get there (or to fail).
  useEffect(() => {
    if (status === 'connecting' || (status === 'connected' && !meeting)) return;
    for (const wake of settleWaitersRef.current.splice(0)) wake();
  }, [status, meeting]);

  /** Leaves this call for a switch. Never ends it for the others. */
  const leaveForSwitch = useCallback(async () => {
    const stillConnecting = () =>
      statusRef.current === 'connecting' || (statusRef.current === 'connected' && !meetingRef.current);
    if (stillConnecting()) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CONNECT_SETTLE_TIMEOUT_MS);
        settleWaitersRef.current.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (callIdRef.current) {
      await leaveCallRef.current();
    } else if (statusRef.current !== 'idle') {
      // No call id: the request for it never came back. Drop what is left.
      cleanupRef.current();
    }
  }, []);

  const isCallLive = status === 'connecting' || status === 'connected' || status === 'ringing-outgoing';
  useRegisterActiveCall(
    'chat',
    isCallLive
      ? {
          id: callId ?? `channel:${channelId ?? ''}`,
          label: () => describeChannelCall(queryClient, channelId, user?.id, 'current'),
          leave: leaveForSwitch,
        }
      : null,
  );

  const toggleMute = useCallback(() => {
    if (!meeting) return;
    if (meeting.self.audioEnabled) {
      void meeting.self.disableAudio();
      setIsMuted(true);
      playMuteSound();
    } else {
      void meeting.self.enableAudio();
      setIsMuted(false);
      playUnmuteSound();
    }
  }, [meeting]);

  const toggleVideo = useCallback(() => {
    if (!meeting) return;
    if (meeting.self.videoEnabled) {
      void meeting.self.disableVideo();
      setIsVideoOff(true);
    } else {
      void meeting.self.enableVideo();
      setIsVideoOff(false);
    }
    playCameraToggleSound();
  }, [meeting]);

  const startScreenShare = useCallback(async (constraints?: DisplayMediaStreamOptions) => {
    if (!meeting) return;
    try {
      // RTK's enableScreenShare() takes no arguments — it calls getDisplayMedia
      // internally and shows the browser's screen picker itself. Calling
      // getDisplayMedia() ourselves first and then passing the captured stream
      // to enableScreenShare(stream) made the picker appear TWICE: the SDK
      // ignores the passed stream and re-prompts. So enable with no args, then
      // apply the resolution/framerate the user picked via the SDK-supported
      // updateScreenshareConstraints, retuning the active track in place. (Same
      // approach as the WeldMeet call context.)
      await meeting.self.enableScreenShare();

      const self = meeting.self as unknown as RealtimeKitSelfInternal;

      // RTK's enableScreenShare() SWALLOWS the getDisplayMedia rejection when the
      // user cancels the browser's screen picker (empty internal catch), so the
      // promise resolves normally but with NO active screen-share track — and the
      // NotAllowedError/AbortError catch below never fires. Detect the no-track
      // case and bail, otherwise the toolbar button sticks in the "Stop sharing"
      // state and the screen-share chime plays for a share that never started.
      if (!self.screenShareEnabled) {
        setIsScreenSharing(false);
        return;
      }

      await applyScreenShareConstraints(self, constraints);

      // Bias the encoder for spatial sharpness — sharp text/UI over smooth
      // motion, matching WeldMeet's screen-share quality policy.
      try {
        const track = self.screenShareTracks?.video;
        if (track && 'contentHint' in track) {
          track.contentHint = 'detail';
        }
      } catch { /* ignore */ }

      // Mirror the user stopping the share via the browser's native "Stop
      // sharing" bar back into React state so the button label stays accurate.
      const onScreenShareUpdate = (update: { screenShareEnabled: boolean }) => {
        if (!update?.screenShareEnabled) {
          setIsScreenSharing(false);
          meeting.self.off('screenShareUpdate', onScreenShareUpdate);
        }
      };
      meeting.self.on('screenShareUpdate', onScreenShareUpdate);

      setIsScreenSharing(true);
      playScreenShareSound();
    } catch (err) {
      // NotAllowedError / AbortError = user cancelled the picker — not an error.
      const name = err instanceof Error ? err.name : undefined;
      if (name !== 'NotAllowedError' && name !== 'AbortError') {
        console.error('[WeldChat] startScreenShare failed:', err);
      }
    }
  }, [meeting]);

  const stopScreenShare = useCallback(() => {
    if (!meeting) return;
    void meeting.self.disableScreenShare();
    setIsScreenSharing(false);
    playScreenShareSound();
  }, [meeting]);

  const toggleHandRaise = useCallback(() => {
    if (!handRaiseRoomRef.current) return;
    const newState = !handRaised;
    setHandRaised(newState);
    if (newState) {
      playHandRaiseSound();
      handRaiseRoomRef.current.sendHandRaise();
    } else {
      playHandLowerSound();
      handRaiseRoomRef.current.sendHandLower();
    }
  }, [handRaised]);

  const value = useMemo<WeldChatCallContextValue>(
    () => ({
      callId,
      channelId,
      callType,
      status,
      endReason,
      isCallInitiator,
      isMuted,
      isVideoOff,
      isScreenSharing,
      duration,
      incomingCall,
      meeting,
      handRaised,
      handRaisedParticipants,
      previewStream,
      previewAudioEnabled,
      previewVideoEnabled,
      previewJoinCallId,
      isFullscreen,
      isPiP,
      viewMode,
      backgroundType: virtualBackground.backgroundType,
      backgroundValue: virtualBackground.backgroundValue,
      isBackgroundLoading: virtualBackground.isLoading,
      startCall,
      joinCall,
      confirmJoinFromPreview,
      cancelPreview,
      togglePreviewAudio,
      togglePreviewVideo,
      leaveCall,
      endCall,
      declineCall,
      acceptIncomingCall,
      toggleMute,
      toggleVideo,
      startScreenShare,
      stopScreenShare,
      toggleHandRaise,
      toggleFullscreen,
      minimizeToPiP,
      expandFromPiP,
      setViewMode,
      applyBlur: virtualBackground.applyBlur,
      applyImage: virtualBackground.applyImage,
      removeBackground: virtualBackground.removeBackground,
    }),
    [
      callId,
      channelId,
      callType,
      status,
      endReason,
      isCallInitiator,
      isMuted,
      isVideoOff,
      isScreenSharing,
      duration,
      incomingCall,
      meeting,
      handRaised,
      handRaisedParticipants,
      previewStream,
      previewAudioEnabled,
      previewVideoEnabled,
      previewJoinCallId,
      isFullscreen,
      isPiP,
      viewMode,
      virtualBackground.backgroundType,
      virtualBackground.backgroundValue,
      virtualBackground.isLoading,
      startCall,
      joinCall,
      confirmJoinFromPreview,
      cancelPreview,
      togglePreviewAudio,
      togglePreviewVideo,
      leaveCall,
      endCall,
      declineCall,
      acceptIncomingCall,
      toggleMute,
      toggleVideo,
      startScreenShare,
      stopScreenShare,
      toggleHandRaise,
      toggleFullscreen,
      minimizeToPiP,
      expandFromPiP,
      setViewMode,
      virtualBackground.applyBlur,
      virtualBackground.applyImage,
      virtualBackground.removeBackground,
    ],
  );

  return (
    <WeldChatCallContext.Provider value={value}>
      {children}
    </WeldChatCallContext.Provider>
  );
}
