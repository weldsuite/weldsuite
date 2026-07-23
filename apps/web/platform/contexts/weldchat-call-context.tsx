/**
 * WeldChat Call Context
 *
 * Global provider for voice/video call state management.
 * Uses Cloudflare RealtimeKit SDK — the SDK handles all WebRTC internally.
 * The backend only creates meetings and returns auth tokens.
 */

import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import type RealtimeKitClient from '@cloudflare/realtimekit';
import {
  createRnnoiseSuppressor,
  installGetUserMediaPatch,
  type NoiseSuppressor,
} from '@weldsuite/df3-noise-suppression';
import rnnoiseWorkerUrl from '@weldsuite/df3-noise-suppression/rnnoise-worker?worker&url';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth, useUser } from '@clerk/clerk-react';
import { weldchatKeys } from '@/hooks/queries/use-weldchat-queries';
import { useNotificationPreferences } from '@/hooks/queries/use-notifications-queries';
import { playCallJoinSound, playCallLeaveSound, playMuteSound, playUnmuteSound, playCameraToggleSound, playScreenShareSound, playHandRaiseSound, playHandLowerSound } from '@/lib/utils/notification-sound';
import { useVirtualBackground, type VirtualBackgroundType } from '@/hooks/use-virtual-background';
import { RoomClient } from '@weldsuite/realtime/client';
import { useTopic } from '@weldsuite/realtime/react';
import type { WorkspaceEvent } from '@weldsuite/realtime';
import { usePresenceMaybe } from '@/contexts/presence-context';
import type { PresenceStatus } from '@weldsuite/ui/components/status-dot';

const REALTIME_BASE_URL =
  import.meta.env.VITE_REALTIME_URL?.replace(/\/ws\/?$/, '') || 'ws://localhost:8790';

// RNNoise noise suppression flag. Default ON; set VITE_NOISE_SUPPRESSION=false
// (legacy alias VITE_DF3_NOISE_SUPPRESSION=false) to disable.
const NOISE_SUPPRESSION_ENABLED =
  import.meta.env.VITE_NOISE_SUPPRESSION !== 'false' &&
  import.meta.env.VITE_DF3_NOISE_SUPPRESSION !== 'false';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Explicitly stop the local camera/mic MediaStreamTracks held by the RTK
 * client. RealtimeKit's `leave()` does not reliably stop the underlying
 * hardware tracks in the browser, so without this the OS camera/mic indicator
 * stays lit after the user leaves the call. Each getter can throw when the
 * corresponding media is disabled, so every read is guarded.
 */
function stopLocalMediaTracks(meeting: RealtimeKitClient | null) {
  if (!meeting) return;
  const self = meeting.self as unknown as {
    videoTrack?: MediaStreamTrack;
    audioTrack?: MediaStreamTrack;
    rawVideoTrack?: MediaStreamTrack;
    rawAudioTrack?: MediaStreamTrack;
    screenShareTracks?: { video?: MediaStreamTrack; audio?: MediaStreamTrack };
  };
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

// ============================================================================
// Types
// ============================================================================

export type CallStatus = 'idle' | 'preview' | 'ringing-outgoing' | 'ringing-incoming' | 'connecting' | 'connected' | 'ended';

export interface IncomingCall {
  callId: string;
  channelId: string;
  callType: 'voice' | 'video';
  callerName: string;
  callerAvatar?: string;
}

interface WeldChatCallState {
  callId: string | null;
  channelId: string | null;
  callType: 'voice' | 'video';
  status: CallStatus;
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
  viewMode: 'grid' | 'spotlight' | 'speaker' | 'sidebar';
  pendingCall: { channelId?: string; callId?: string; callType: 'voice' | 'video' } | null;
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
  setViewMode: (mode: 'grid' | 'spotlight' | 'speaker' | 'sidebar') => void;
  confirmSwitchCall: () => Promise<void>;
  cancelSwitchCall: () => void;
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

export function WeldChatCallProvider({ children }: { children: React.ReactNode }) {
  const { getClient } = useAppApiClient();
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const { user } = useUser();
  const { data: notifPrefs } = useNotificationPreferences();

  const [callId, setCallId] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [callType, setCallType] = useState<'voice' | 'video'>('voice');
  const [status, setStatus] = useState<CallStatus>('idle');
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
  const [viewMode, setViewMode] = useState<'grid' | 'spotlight' | 'speaker' | 'sidebar'>('grid');
  const [pendingCall, setPendingCall] = useState<{ channelId?: string; callId?: string; callType: 'voice' | 'video' } | null>(null);

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

  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Noise suppression handles (active only when NOISE_SUPPRESSION_ENABLED).
  const suppressorRef = useRef<NoiseSuppressor | null>(null);
  const suppressorRestoreRef = useRef<(() => void) | null>(null);
  const callIdRef = useRef<string | null>(null);
  const channelIdRef = useRef<string | null>(null);

  // Keep refs in sync so beforeunload / roomLeft can access latest values
  useEffect(() => { callIdRef.current = callId; }, [callId]);
  useEffect(() => { channelIdRef.current = channelId; }, [channelId]);

  // Ref to hold the latest Clerk JWT so beforeunload can use it synchronously
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
    refresh();
    // Refresh every 30s to keep the token valid for beforeunload
    const iv = setInterval(refresh, 30_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [status, getToken]);

  // Fire-and-forget leave notification for tab close / disconnect scenarios.
  // Uses fetch with keepalive (supports auth headers, survives page unload).
  const fireLeaveRequest = useCallback((cId: string) => {
    const baseUrl = import.meta.env.VITE_APP_API_URL ?? '';
    const url = `${baseUrl}/api/chat-calls/${cId}/leave`;
    const token = authTokenRef.current;
    if (!token) return;
    try {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: '{}',
        keepalive: true,
      }).catch(() => {});
    } catch { /* best effort */ }
  }, []);

  // Notify backend on tab close / navigation so the call doesn't stay open
  useEffect(() => {
    const handler = () => {
      const cId = callIdRef.current;
      if (cId) fireLeaveRequest(cId);
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [fireLeaveRequest]);

  // Duration timer
  useEffect(() => {
    if (status === 'connected') {
      durationTimerRef.current = setInterval(() => {
        setDuration((d) => d + 1);
      }, 1000);
    } else {
      if (durationTimerRef.current) {
        clearInterval(durationTimerRef.current);
        durationTimerRef.current = null;
      }
    }
    return () => {
      if (durationTimerRef.current) clearInterval(durationTimerRef.current);
    };
  }, [status]);

  // ── Incoming call listener via WorkspaceHub topic ────────────────────────
  // Keep a ref to status so the useTopic handler never closes over a stale value
  const statusRef = useRef<CallStatus>(status);
  useEffect(() => { statusRef.current = status; }, [status]);

  const handleIncomingCallEvent = useCallback(
    (event: WorkspaceEvent<{
      callId: string;
      channelId: string;
      callType: 'voice' | 'video';
      callerName: string;
      callerAvatar?: string;
    }>) => {
      if (event.event !== 'call_incoming') return;
      // Only surface the toast when the user is not already in a call
      if (statusRef.current !== 'idle' && statusRef.current !== 'ended') return;
      setIncomingCall({
        callId: event.data.callId,
        channelId: event.data.channelId,
        callType: event.data.callType,
        callerName: event.data.callerName,
        callerAvatar: event.data.callerAvatar,
      });
      setStatus('ringing-incoming');
    },
    [],
  );

  useTopic(user?.id ? `chat.user.${user.id}` : '', handleIncomingCallEvent);

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
  }, [channelId, status]);

  const cleanup = useCallback(() => {
    if (meeting) {
      // Stop the local hardware tracks BEFORE leaving — RTK's leave() does not
      // reliably release the camera/mic, so the device indicator would otherwise
      // stay on after the call ends.
      stopLocalMediaTracks(meeting);
      try { meeting.leave(); } catch { /* ignore */ }
    }
    // Restore getUserMedia first, then dispose the suppressor.
    try { suppressorRestoreRef.current?.(); } catch { /* ignore */ }
    suppressorRestoreRef.current = null;
    const suppressor = suppressorRef.current;
    suppressorRef.current = null;
    if (suppressor) {
      suppressor.dispose().catch((err) => console.warn('[noise] dispose error:', err));
    }
    setMeeting(null);
    setCallId(null);
    setChannelId(null);
    setStatus('idle');
    setIsCallInitiator(false);
    setDuration(0);
    setIsMuted(false);
    setIsVideoOff(false);
    setIsScreenSharing(false);
    setIncomingCall(null);
    setHandRaised(false);
    setHandRaisedParticipants(new Set());
    setIsPiP(false);
    setIsFullscreen(false);
  }, [meeting]);

  const stopPreviewStream = useCallback(() => {
    setPreviewStream((prev) => {
      prev?.getTracks().forEach((t) => t.stop());
      return null;
    });
  }, []);

  const initMeeting = useCallback(async (authToken: string, type: 'voice' | 'video', audioOn = true, videoOn?: boolean) => {
    // Noise suppression path: monkey-patch getUserMedia so RTK's internal
    // mic acquisition flows through RNNoise, and turn off RTK's browser-level
    // NS so we don't double-process.
    const useNoiseSuppression = NOISE_SUPPRESSION_ENABLED && audioOn;
    if (useNoiseSuppression) {
      const suppressor = createRnnoiseSuppressor({
        workerUrl: rnnoiseWorkerUrl,
        workletUrl: '/df3-worklet-processor.js',
        logRtf: !import.meta.env.PROD,
      });
      suppressorRef.current = suppressor;
      suppressorRestoreRef.current = installGetUserMediaPatch(suppressor);
    }

    const { default: RTK } = await import('@cloudflare/realtimekit');
    let m: RealtimeKitClient;
    try {
      m = await RTK.init({
        authToken,
        defaults: {
          audio: audioOn,
          video: videoOn ?? (type === 'video'),
          mediaConfiguration: {
            audio: { noiseSupression: useNoiseSuppression ? false : true },
          },
        },
      });
    } catch (err) {
      try { suppressorRestoreRef.current?.(); } catch { /* ignore */ }
      suppressorRestoreRef.current = null;
      const sup = suppressorRef.current;
      suppressorRef.current = null;
      sup?.dispose().catch(() => undefined);
      throw err;
    }

    m.self.on('roomJoined', () => {
      setStatus('connected');
      playCallJoinSound();
    });

    m.self.on('roomLeft', () => {
      // Notify the backend so the call auto-ends if no participants remain.
      // This fires on network drops, WebRTC disconnects, etc.
      const cId = callIdRef.current;
      if (cId) fireLeaveRequest(cId);
      cleanup();
    });

    await m.join();
    setMeeting(m);
    return m;
  }, [cleanup, fireLeaveRequest]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const isInActiveCall = status !== 'idle' && status !== 'ended';

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
    setStatus('connecting');
    const client = await getClient();
    // Single round-trip: creates the meeting + joins in one request.
    const res = await client.post<any>('/chat-calls/start-and-join', { channelId: chId, callType: type });
    setCallId(res.data.callId);
    await initMeeting(res.data.authToken, type, true, videoOn);
  }, [getClient, initMeeting]);

  const doJoinCall = useCallback(async (id: string) => {
    const client = await getClient();
    const callRes = await client.get<any>(`/chat-calls/${id}`);
    const call = callRes.data;
    const type = call.callType as 'voice' | 'video';

    setCallType(type);
    setChannelId(call.channelId);
    setPreviewJoinCallId(null);
    setCallId(id);
    setIsCallInitiator(false);
    const videoOn = type === 'video';
    setIsMuted(false);
    setIsVideoOff(!videoOn);
    setStatus('connecting');
    const joinRes = await client.post<any>(`/chat-calls/${id}/join`, {});
    await initMeeting(joinRes.data.authToken, type, true, videoOn);
  }, [getClient, initMeeting]);

  const startCall = useCallback(async (chId: string, type: 'voice' | 'video') => {
    if (isInActiveCall) {
      setPendingCall({ channelId: chId, callType: type });
      return;
    }
    await doStartCall(chId, type);
  }, [isInActiveCall, doStartCall]);

  const joinCall = useCallback(async (id: string) => {
    if (isInActiveCall) {
      setPendingCall({ callId: id, callType: 'voice' });
      return;
    }
    await doJoinCall(id);
  }, [isInActiveCall, doJoinCall]);

  const confirmSwitchCall = useCallback(async () => {
    if (!pendingCall) return;
    // Leave current call first
    if (callId) {
      const client = await getClient();
      try { await client.post<any>(`/chat-calls/${callId}/leave`, {}); } catch { /* best effort */ }
    }
    cleanup();
    // Start the pending call
    if (pendingCall.callId) {
      await doJoinCall(pendingCall.callId);
    } else if (pendingCall.channelId) {
      await doStartCall(pendingCall.channelId, pendingCall.callType);
    }
    setPendingCall(null);
  }, [pendingCall, callId, getClient, cleanup, doStartCall, doJoinCall]);

  const cancelSwitchCall = useCallback(() => {
    setPendingCall(null);
  }, []);

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
      setStatus('connecting');
      const joinRes = await client.post<any>(`/chat-calls/${previewJoinCallId}/join`, {});
      await initMeeting(joinRes.data.authToken, type, audioOn, videoOn);
    } else if (chId) {
      // Starting new call — single round-trip: creates meeting + joins in one request
      setStatus('connecting');
      const res = await client.post<any>('/chat-calls/start-and-join', { channelId: chId, callType: type });
      setCallId(res.data.callId);
      await initMeeting(res.data.authToken, type, audioOn, videoOn);
    }
    setPreviewJoinCallId(null);
  }, [stopPreviewStream, getClient, callType, channelId, previewJoinCallId, previewAudioEnabled, previewVideoEnabled, initMeeting]);

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

  const acceptIncomingCall = useCallback(async () => {
    if (!incomingCall) return;
    const ic = incomingCall;
    setIncomingCall(null);

    // Skip preview for incoming calls — join immediately
    const client = await getClient();
    const callRes = await client.get<any>(`/chat-calls/${ic.callId}`);
    const call = callRes.data;
    const type = (call.callType || ic.callType) as 'voice' | 'video';

    setCallType(type);
    setChannelId(call.channelId || ic.channelId);
    setCallId(ic.callId);
    setIsCallInitiator(false);
    setStatus('connecting');

    const joinRes = await client.post<any>(`/chat-calls/${ic.callId}/join`, {});
    await initMeeting(joinRes.data.authToken, type);
  }, [incomingCall, getClient, initMeeting]);

  const patchActiveCallsCache = useCallback((endedCallId: string) => {
    queryClient.setQueryData<Array<{ channelId: string; callId: string; callType: 'voice' | 'video' }>>(
      ['weldchat', 'active-calls'],
      (prev) => (prev ? prev.filter((c) => c.callId !== endedCallId) : prev),
    );
  }, [queryClient]);

  const leaveCall = useCallback(async () => {
    if (!callId) return;
    const endedCallId = callId;
    const chId = channelId;
    const client = await getClient();
    try {
      await client.post<any>(`/chat-calls/${endedCallId}/leave`, {});
    } catch { /* best effort */ }
    // Clear ref BEFORE cleanup so the roomLeft handler doesn't fire a duplicate /leave
    callIdRef.current = null;
    cleanup();
    patchActiveCallsCache(endedCallId);
    if (chId) {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.activeCall(chId) });
    }
  }, [callId, channelId, getClient, cleanup, queryClient, patchActiveCallsCache]);

  const endCall = useCallback(async () => {
    if (!callId) return;
    playCallLeaveSound();
    const endedCallId = callId;
    const chId = channelId;
    const client = await getClient();
    try {
      await client.post<any>(`/chat-calls/${endedCallId}/end`, {});
    } catch { /* best effort */ }
    // Clear ref BEFORE cleanup so the roomLeft handler doesn't fire a duplicate /leave
    callIdRef.current = null;
    cleanup();
    patchActiveCallsCache(endedCallId);
    if (chId) {
      queryClient.invalidateQueries({ queryKey: weldchatKeys.activeCall(chId) });
    }
  }, [callId, channelId, getClient, cleanup, queryClient, patchActiveCallsCache]);

  const declineCall = useCallback(async () => {
    if (!incomingCall) return;
    const client = await getClient();
    try {
      await client.post<any>(`/chat-calls/${incomingCall.callId}/decline`, {});
    } catch { /* best effort */ }
    setIncomingCall(null);
    setStatus('idle');
  }, [incomingCall, getClient]);

  const toggleMute = useCallback(() => {
    if (!meeting) return;
    if (meeting.self.audioEnabled) {
      meeting.self.disableAudio();
      setIsMuted(true);
      playMuteSound();
    } else {
      meeting.self.enableAudio();
      setIsMuted(false);
      playUnmuteSound();
    }
  }, [meeting]);

  const toggleVideo = useCallback(() => {
    if (!meeting) return;
    if (meeting.self.videoEnabled) {
      meeting.self.disableVideo();
      setIsVideoOff(true);
    } else {
      meeting.self.enableVideo();
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

      // RTK's enableScreenShare() SWALLOWS the getDisplayMedia rejection when the
      // user cancels the browser's screen picker (empty internal catch), so the
      // promise resolves normally but with NO active screen-share track — and the
      // NotAllowedError/AbortError catch below never fires. Detect the no-track
      // case and bail, otherwise the toolbar button sticks in the "Stop sharing"
      // state and the screen-share chime plays for a share that never started.
      if (!(meeting.self as any).screenShareEnabled) {
        setIsScreenSharing(false);
        return;
      }

      const videoConstraints = (constraints?.video && typeof constraints.video === 'object')
        ? (constraints.video as MediaTrackConstraints)
        : undefined;
      const pickIdeal = (v: unknown): number | undefined => {
        if (typeof v === 'number') return v;
        if (v && typeof v === 'object' && 'ideal' in (v as any) && typeof (v as any).ideal === 'number') {
          return (v as any).ideal as number;
        }
        return undefined;
      };
      const width = pickIdeal(videoConstraints?.width);
      const height = pickIdeal(videoConstraints?.height);
      const frameRate = pickIdeal(videoConstraints?.frameRate);

      if (width && height) {
        try {
          await (meeting.self as any).updateScreenshareConstraints({
            width: { ideal: width },
            height: { ideal: height },
            ...(frameRate ? { frameRate: { ideal: frameRate } } : {}),
          });
        } catch (err) {
          console.warn('[WeldChat] updateScreenshareConstraints failed:', err);
        }
      }

      // Bias the encoder for spatial sharpness — sharp text/UI over smooth
      // motion, matching WeldMeet's screen-share quality policy.
      try {
        const track = (meeting.self as any).screenShareTracks?.video as
          | MediaStreamTrack
          | undefined;
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
    } catch (err: any) {
      // NotAllowedError / AbortError = user cancelled the picker — not an error.
      const name = err?.name as string | undefined;
      if (name !== 'NotAllowedError' && name !== 'AbortError') {
        console.error('[WeldChat] startScreenShare failed:', err);
      }
    }
  }, [meeting]);

  const stopScreenShare = useCallback(() => {
    if (!meeting) return;
    meeting.self.disableScreenShare();
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

  const value: WeldChatCallContextValue = {
    callId,
    channelId,
    callType,
    status,
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
    pendingCall,
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
    confirmSwitchCall,
    cancelSwitchCall,
    applyBlur: virtualBackground.applyBlur,
    applyImage: virtualBackground.applyImage,
    removeBackground: virtualBackground.removeBackground,
  };

  return (
    <WeldChatCallContext.Provider value={value}>
      {children}
    </WeldChatCallContext.Provider>
  );
}
