/**
 * WeldMeet Call Context
 *
 * Global provider for meeting video/audio session state.
 * Adapted from WeldChatCallProvider — uses the same RealtimeKit SDK
 * but with meeting-specific lifecycle (no ringing, join-on-demand, waiting room).
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
import { consumeStartHandoff } from '@/lib/weldmeet/start-handoff';
import { usePathname } from '@/lib/router';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import { weldmeetKeys } from '@/hooks/queries/use-weldmeet-queries';
import { useVirtualBackground, type VirtualBackgroundType } from '@/hooks/use-virtual-background';
import {
  playCallJoinSound,
  playCallLeaveSound,
  playMuteSound,
  playUnmuteSound,
  playCameraToggleSound,
  playScreenShareSound,
  playHandRaiseSound,
  playHandLowerSound,
} from '@/lib/utils/notification-sound';

// RNNoise noise suppression flag. Plain build-time/runtime gate, default ON;
// set VITE_NOISE_SUPPRESSION=false to disable. (Legacy alias:
// VITE_DF3_NOISE_SUPPRESSION=false still disables it.)
const NOISE_SUPPRESSION_ENABLED =
  import.meta.env.VITE_NOISE_SUPPRESSION !== 'false' &&
  import.meta.env.VITE_DF3_NOISE_SUPPRESSION !== 'false';

/**
 * Explicitly stop the local camera/mic MediaStreamTracks held by the RTK
 * client. RealtimeKit's `leave()` does not reliably stop the underlying
 * hardware tracks in the browser, so without this the OS camera/mic indicator
 * stays lit after the user leaves the meeting. Each getter can throw when the
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

export type MeetingCallStatus = 'idle' | 'preview' | 'connecting' | 'connected' | 'ended';

export type RecordingState = 'IDLE' | 'STARTING' | 'RECORDING' | 'PAUSED' | 'STOPPING';

export interface CallCaption {
  id: string;
  peerId: string;
  speakerName: string;
  text: string;
  isPartial: boolean;
  at: number;
}

interface WeldMeetCallState {
  meetingId: string | null;
  sessionId: string | null;
  meetingType: 'video' | 'audio';
  status: MeetingCallStatus;
  isMuted: boolean;
  isVideoOff: boolean;
  isScreenSharing: boolean;
  duration: number;
  meeting: RealtimeKitClient | null;
  handRaised: boolean;
  handRaisedParticipants: Set<string>;
  previewStream: MediaStream | null;
  previewAudioEnabled: boolean;
  previewVideoEnabled: boolean;
  isFullscreen: boolean;
  isPiP: boolean;
  /** Pinned participant id (or `<id>-screen` for a pinned screen share).
   *  Held in the context so the pin survives the meeting view remounting when
   *  it moves between the inline page and the fullscreen overlay. */
  pinnedId: string | null;
  viewMode: 'grid' | 'spotlight' | 'speaker' | 'sidebar';
  isOrganizer: boolean;
  meetingTitle: string;
  isRecording: boolean;
  recordingState: RecordingState;
  backgroundType: VirtualBackgroundType;
  backgroundValue: string | null;
  isBackgroundLoading: boolean;
  /** Pre-warmed camera track exposed to the PiP widget so it can render
   *  real media on `/weldmeet/new` before the meeting connects. */
  prewarmedVideoTrack: MediaStreamTrack | null;
  /** Rolling caption buffer (last ~5). Filled from RTK transcription
   *  events; the overlay only renders these when enableCaptions is on. */
  captions: CallCaption[];
}

interface WeldMeetCallActions {
  joinMeeting: (meetingId: string, options?: { meetingType?: 'video' | 'audio'; title?: string; isOrganizer?: boolean; skipPreview?: boolean }) => Promise<void>;
  confirmJoinFromPreview: () => Promise<void>;
  cancelPreview: () => void;
  togglePreviewAudio: () => void;
  togglePreviewVideo: () => void;
  leaveMeeting: () => Promise<void>;
  endMeeting: () => Promise<void>;
  toggleMute: () => void;
  toggleVideo: () => void;
  startScreenShare: (constraints?: DisplayMediaStreamOptions) => Promise<void>;
  stopScreenShare: () => void;
  toggleHandRaise: () => void;
  toggleFullscreen: () => void;
  minimizeToPiP: () => void;
  expandFromPiP: () => void;
  /** Pin / unpin a participant (or `<id>-screen`). Toggles off when the same
   *  id is pinned again. */
  togglePin: (id: string) => void;
  /**
   * Opens the out-of-browser Picture-in-Picture window (Document PiP, with a
   * native single-video fallback). The MeetingPiPWidget registers the actual
   * implementation via `registerPopOut`; this lets the in-meeting 3-dots menu
   * trigger it synchronously within the user gesture.
   */
  requestPopOut: () => void;
  /** Internal: the PiP widget registers its pop-out implementation here. */
  registerPopOut: (fn: () => void) => void;
  setViewMode: (mode: 'grid' | 'spotlight' | 'speaker' | 'sidebar') => void;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  pauseRecording: () => Promise<void>;
  resumeRecording: () => Promise<void>;
  applyBlur: (intensity?: number) => Promise<void>;
  applyImage: (url: string) => Promise<void>;
  removeBackground: () => void;
  /**
   * Idempotent: ensures camera + mic are acquired and bound to the hidden
   * PiP video. Call from inside a user gesture (e.g. the "Start meeting"
   * click) so the gesture activation is what triggers `getUserMedia` —
   * this is what makes Chrome auto-PiP the meeting on the user's NEXT tab
   * switch without first having to click inside the meeting room.
   * Returns once the prewarm has resolved (resolves immediately if already
   * warmed). Never rejects — silently swallows permission errors.
   */
  prewarmMedia: () => Promise<void>;
}

type WeldMeetCallContextValue = WeldMeetCallState & WeldMeetCallActions;

// ============================================================================
// Context
// ============================================================================

const WeldMeetCallContext = createContext<WeldMeetCallContextValue | null>(null);

export function useWeldMeetCall() {
  const ctx = useContext(WeldMeetCallContext);
  if (!ctx) throw new Error('useWeldMeetCall must be used within WeldMeetCallProvider');
  return ctx;
}

export function useWeldMeetCallOptional() {
  return useContext(WeldMeetCallContext);
}

// ============================================================================
// Provider
// ============================================================================

export function WeldMeetCallProvider({ children }: { children: React.ReactNode }) {
  const { getClient } = useAppApiClient();
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [meetingType, setMeetingType] = useState<'video' | 'audio'>('video');
  const [status, setStatus] = useState<MeetingCallStatus>('idle');
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [duration, setDuration] = useState(0);
  const [meeting, setMeeting] = useState<RealtimeKitClient | null>(null);
  const [handRaised, setHandRaised] = useState(false);
  const [handRaisedParticipants, setHandRaisedParticipants] = useState<Set<string>>(new Set());
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [previewAudioEnabled, setPreviewAudioEnabled] = useState(true);
  const [previewVideoEnabled, setPreviewVideoEnabled] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPiP, setIsPiP] = useState(false);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'spotlight' | 'speaker' | 'sidebar'>('grid');
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingState, setRecordingState] = useState<RecordingState>('IDLE');
  const [meetingTitle, setMeetingTitle] = useState('');
  /**
   * Most recent caption entries from RTK transcription. Kept as a small
   * ring buffer (last 5) so the on-screen overlay can show the rolling
   * subtitle. Cleared when the meeting ends.
   */
  const [captions, setCaptions] = useState<CallCaption[]>([]);
  const [prewarmedVideoTrack, setPrewarmedVideoTrack] = useState<MediaStreamTrack | null>(null);
  // SelfMedia from RealtimeKitClient.initMedia — the official "pre-warm camera
  // before init" handle. Passed as `defaults.mediaHandler` to the eventual
  // RealtimeKitClient.init call so RTK reuses our existing tracks instead of
  // acquiring fresh ones (no flicker, no second permission prompt). Held in a
  // ref so the value is read at the moment initMeeting runs without making
  // initMeeting depend on the SelfMedia state.
  const prewarmedMediaRef = useRef<Awaited<ReturnType<typeof RealtimeKitClient.initMedia>> | null>(null);
  const pathname = usePathname();

  // Noise suppression handles (active only when NOISE_SUPPRESSION_ENABLED).
  const suppressorRef = useRef<NoiseSuppressor | null>(null);
  const suppressorRestoreRef = useRef<(() => void) | null>(null);

  // Auto-apply saved virtual background preference when meeting starts
  const virtualBackground = useVirtualBackground(meeting);

  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const meetingIdRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const authTokenRef = useRef<string | null>(null);

  // Keep refs in sync
  useEffect(() => { meetingIdRef.current = meetingId; }, [meetingId]);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

  // Keep token fresh during active session
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
    const iv = setInterval(refresh, 30_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [status, getToken]);

  // ── Camera pre-warm ──────────────────────────────────────────────────────
  // While the user is on /weldmeet/new (the meeting-start lobby), pre-acquire
  // the camera + mic via RealtimeKitClient.initMedia. The returned SelfMedia
  // is later passed to RealtimeKitClient.init as `defaults.mediaHandler`, so
  // RTK reuses these exact tracks when the meeting connects — no flicker, no
  // second permission prompt, and Chrome sees a real getUserMedia stream
  // active on the origin from the moment the lobby loads. That's what makes
  // "click Start an instant meeting → immediate tab switch" produce auto-PiP
  // straight away (Google Meet's pattern), instead of needing the user to
  // first click somewhere inside the meeting room.
  const releasePrewarm = useCallback(() => {
    const m = prewarmedMediaRef.current;
    if (!m) return;
    try {
      // Stop the underlying tracks. We can't always rely on m.disableX() —
      // the public API differs across versions — but stopping the
      // MediaStreamTrack directly always releases the device.
      const v = m.videoTrack as MediaStreamTrack | undefined;
      const a = m.audioTrack as MediaStreamTrack | undefined;
      v?.stop();
      a?.stop();
    } catch { /* ignore */ }
    prewarmedMediaRef.current = null;
    setPrewarmedVideoTrack(null);
  }, []);

  // In-flight prewarm so `prewarmMedia()` is idempotent across concurrent
  // callers (e.g. the layout-mount effect AND the click handler).
  const prewarmInFlightRef = useRef<Promise<void> | null>(null);

  const prewarmMedia = useCallback(async (): Promise<void> => {
    if (prewarmedMediaRef.current) return;
    if (prewarmInFlightRef.current) return prewarmInFlightRef.current;
    // Skip prewarm when noise suppression is on — the prewarmed SelfMedia
    // tracks are raw and can't be fed through the suppressor (no RTK replace
    // path). Small UX cost: a brief "acquiring mic" at meeting start.
    if (NOISE_SUPPRESSION_ENABLED) return;

    const promise = import('@cloudflare/realtimekit').then(({ default: RTK }) => RTK.initMedia({ video: true, audio: true }))
      .then((media) => {
        // If the meeting connected while we were acquiring, RTK owns the
        // device — drop ours so we don't double-hold the camera.
        if (prewarmedMediaRef.current) {
          try {
            (media.videoTrack as MediaStreamTrack | undefined)?.stop();
            (media.audioTrack as MediaStreamTrack | undefined)?.stop();
          } catch { /* ignore */ }
          return;
        }
        prewarmedMediaRef.current = media;
        setPrewarmedVideoTrack((media.videoTrack as MediaStreamTrack | undefined) ?? null);
      })
      .catch(() => {
        // Permission denied / no camera — silently fall back to canvas in PiP widget.
      })
      .finally(() => {
        prewarmInFlightRef.current = null;
      });

    prewarmInFlightRef.current = promise;
    return promise;
  }, []);

  useEffect(() => {
    // Pre-warm only on /weldmeet/new — the lobby page where the user has
    // explicit intent to start a meeting. Acquiring the mic anywhere else
    // under /weldmeet would surface the browser's "microphone in use"
    // indicator on dashboard / list views and read as "the meeting is
    // already running", which it isn't.
    //
    // The click handler in /weldmeet/new also calls `prewarmMedia()`
    // synchronously, which covers the case where the user lands on a
    // different /weldmeet page and clicks Start before the lobby useEffect
    // has had a chance to run.
    const isLobby = !!pathname && pathname.startsWith('/weldmeet/new');
    if (!isLobby || status !== 'idle') return;
    if (prewarmedMediaRef.current) return;
    void prewarmMedia();
  }, [pathname, status, prewarmMedia]);

  // Release the pre-warm if the user navigates away from any /weldmeet/*
  // route without joining. /weldmeet/$id/room keeps it (initMeeting will
  // consume it via mediaHandler).
  useEffect(() => {
    const inWeldmeet = !!pathname && pathname.startsWith('/weldmeet');
    if (!inWeldmeet) releasePrewarm();
  }, [pathname, releasePrewarm]);

  // Fire-and-forget leave request for tab close
  const fireLeaveRequest = useCallback((mId: string, sId: string) => {
    const baseUrl = import.meta.env.VITE_APP_API_URL ?? 'http://localhost:8789';
    const url = `${baseUrl}/api/meeting-sessions/${sId}/leave`;
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

  // Notify backend on tab close
  useEffect(() => {
    const handler = () => {
      const mId = meetingIdRef.current;
      const sId = sessionIdRef.current;
      if (mId && sId) fireLeaveRequest(mId, sId);
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [fireLeaveRequest]);

  // Duration timer
  useEffect(() => {
    if (status === 'connected') {
      durationTimerRef.current = setInterval(() => setDuration((d) => d + 1), 1000);
    } else {
      if (durationTimerRef.current) {
        clearInterval(durationTimerRef.current);
        durationTimerRef.current = null;
      }
    }
    return () => { if (durationTimerRef.current) clearInterval(durationTimerRef.current); };
  }, [status]);

  // Subscribe to RTK transcription events. RTK only emits these when the
  // joined preset has `permissions.transcriptionEnabled = true` (seeded by
  // packages/core/cloudflare-realtime/src/index.ts). The host-controls toggle
  // `enableCaptions` doesn't gate the *event* — it gates the on-screen
  // rendering downstream in MeetingRoomView. Keeping the subscription
  // unconditional means flipping the host toggle has zero latency.
  useEffect(() => {
    if (!meeting) return;
    const ai = (meeting as any).ai;
    if (!ai?.on) return;
    const onTranscript = (t: {
      id?: string;
      peerId?: string;
      name?: string;
      transcript?: string;
      isPartialTranscript?: boolean;
      date?: Date;
    }) => {
      if (!t?.transcript || !t.peerId) return;
      setCaptions((prev) => {
        const next = [...prev];
        // If we already have a partial caption from the same speaker as the
        // most-recent entry, replace it instead of appending — RTK streams
        // partial deltas as separate events.
        const last = next[next.length - 1];
        if (last && last.peerId === t.peerId && last.isPartial) {
          next[next.length - 1] = {
            ...last,
            text: t.transcript ?? '',
            isPartial: t.isPartialTranscript !== false,
            at: Date.now(),
          };
          return next;
        }
        next.push({
          id: t.id ?? `cap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          peerId: t.peerId ?? '',
          speakerName: t.name ?? 'Speaker',
          text: t.transcript ?? '',
          isPartial: t.isPartialTranscript !== false,
          at: Date.now(),
        });
        // Keep the ring buffer small.
        return next.length > 5 ? next.slice(-5) : next;
      });
    };
    try { ai.on('transcript', onTranscript); } catch { /* ignore */ }
    return () => {
      try { ai.off?.('transcript', onTranscript); } catch { /* ignore */ }
    };
  }, [meeting]);

  // Subscribe to hand-raise + host-controls broadcasts from other participants.
  // RealtimeKit's own `participants.broadcastMessage` is reused (no extra
  // worker), so it works for both signed-in users and meeting-portal guests.
  useEffect(() => {
    if (!meeting) return;
    const selfId: string | undefined = meeting.self?.id;
    const handler = (msg: { type: string; payload: Record<string, unknown> }) => {
      if (msg.type === 'call:hand-raised' || msg.type === 'call:hand-lowered') {
        const peerId = typeof msg.payload?.peerId === 'string' ? msg.payload.peerId : null;
        if (!peerId) return;
        setHandRaisedParticipants((prev) => {
          const next = new Set(prev);
          if (msg.type === 'call:hand-raised') next.add(peerId);
          else next.delete(peerId);
          return next;
        });
        if (peerId !== selfId) {
          if (msg.type === 'call:hand-raised') playHandRaiseSound();
          else playHandLowerSound();
        }
        return;
      }
      if (msg.type === 'call:host-controls-updated') {
        const targetMeetingId = typeof msg.payload?.meetingId === 'string' ? msg.payload.meetingId : null;
        const json = typeof msg.payload?.controlsJson === 'string' ? msg.payload.controlsJson : null;
        if (!targetMeetingId || !json) return;
        let controls: Record<string, unknown>;
        try {
          controls = JSON.parse(json) as Record<string, unknown>;
        } catch {
          return;
        }
        // Optimistically merge into the cached meeting so the UI re-renders
        // its policy gates immediately. The next refetch will reconcile.
        queryClient.setQueryData(
          weldmeetKeys.meeting(targetMeetingId),
          (prev: Record<string, unknown> | null | undefined) => {
            if (!prev) return prev;
            return { ...prev, ...controls };
          },
        );
        return;
      }
    };
    try {
      meeting.participants.on('broadcastedMessage', handler);
    } catch (err) {
      console.error('[WeldMeet:Call] subscribe broadcastedMessage failed:', err);
    }
    return () => {
      try { meeting.participants.off('broadcastedMessage', handler); } catch { /* ignore */ }
    };
  }, [meeting, queryClient]);

  const cleanup = useCallback(() => {
    if (meeting) {
      // Stop the local hardware tracks BEFORE leaving — RTK's leave() does not
      // reliably release the camera/mic, so the device indicator would otherwise
      // stay on after the meeting ends.
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
    setMeetingId(null);
    setSessionId(null);
    setStatus('idle');
    setDuration(0);
    setIsMuted(false);
    setIsVideoOff(false);
    setIsScreenSharing(false);
    setHandRaised(false);
    setHandRaisedParticipants(new Set());
    setIsPiP(false);
    setPinnedId(null);
    setIsFullscreen(false);
    setIsOrganizer(false);
    setMeetingTitle('');
    setIsRecording(false);
    setRecordingState('IDLE');
    setCaptions([]);
  }, [meeting]);

  const stopPreviewStream = useCallback(() => {
    setPreviewStream((prev) => {
      prev?.getTracks().forEach((t) => t.stop());
      return null;
    });
  }, []);

  const startPreview = useCallback(async (type: 'video' | 'audio') => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      setPreviewStream(stream);
      setPreviewAudioEnabled(true);
      if (type === 'audio') {
        stream.getVideoTracks().forEach((t) => { t.enabled = false; });
        setPreviewVideoEnabled(false);
      } else {
        setPreviewVideoEnabled(true);
      }
    } catch {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        setPreviewStream(stream);
      } catch { /* no devices */ }
      setPreviewAudioEnabled(true);
      setPreviewVideoEnabled(false);
    }
  }, []);

  const initMeeting = useCallback(async (
    authToken: string,
    type: 'video' | 'audio',
    audioOn = true,
    videoOn?: boolean,
    options?: { noiseCancellation?: boolean },
  ) => {
    // Hand off the pre-warmed SelfMedia (if any) to RTK so it reuses the
    // already-running camera/mic tracks instead of re-acquiring the devices.
    // The ref is cleared synchronously: once init() consumes it, RTK owns
    // the tracks and our cleanup must NOT stop them.
    const handler = prewarmedMediaRef.current;
    prewarmedMediaRef.current = null;
    setPrewarmedVideoTrack(null);

    // Host-policy: when meeting.noiseCancellation === false, disable RTK's
    // browser-level noise suppression. Default (true) matches RTK's own
    // default — toggling off requires re-init, so a mid-call host flip only
    // applies to subsequent session joins.
    const noiseSupressionOn = options?.noiseCancellation !== false;

    // Noise suppression path: monkey-patch getUserMedia so RTK's internal
    // acquisition flows through RNNoise. Drop the prewarmed handler (raw tracks)
    // and turn off RTK's browser NS so we don't double-process.
    const useNoiseSuppression = NOISE_SUPPRESSION_ENABLED && audioOn && noiseSupressionOn;
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
          ...(handler && !useNoiseSuppression ? { mediaHandler: handler } : {}),
          mediaConfiguration: {
            audio: { noiseSupression: useNoiseSuppression ? false : noiseSupressionOn },
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
      const mId = meetingIdRef.current;
      const sId = sessionIdRef.current;
      if (mId && sId) fireLeaveRequest(mId, sId);
      cleanup();
    });

    // Track recording state
    m.recording?.on?.('recordingUpdate', (state: RecordingState) => {
      setRecordingState(state);
      setIsRecording(state === 'RECORDING' || state === 'PAUSED');
    });

    await m.join();
    setMeeting(m);
    return m;
  }, [cleanup, fireLeaveRequest]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const connectToMeeting = useCallback(async (mId: string, type: 'video' | 'audio', audioOn: boolean, videoOn: boolean) => {
    setStatus('connecting');

    // Read host-policy from the cached meeting (populated when the user
    // navigated to /weldmeet/$id). Noise cancellation defaults to ON; we
    // only opt-out when the host has explicitly turned it off.
    const cachedMeeting = queryClient.getQueryData(weldmeetKeys.meeting(mId)) as
      | { noiseCancellation?: boolean }
      | null
      | undefined;
    const initOpts = { noiseCancellation: cachedMeeting?.noiseCancellation !== false };

    try {
      // Fast path: if /weldmeet/new just called start-instant for this
      // meeting, the auth token is already available — skip the legacy
      // GET /sessions/active + POST /sessions/:id/join round-trips.
      const handoff = consumeStartHandoff(mId);
      if (handoff) {
        setSessionId(handoff.sessionId);
        await initMeeting(handoff.authToken, type, audioOn, videoOn, initOpts);
        return;
      }

      const client = await getClient();

      // Legacy path: late joiners + page reloads land here.
      let sId: string;
      let activeRes;
      try {
        activeRes = await client.get(`/meeting-sessions/active?meetingId=${encodeURIComponent(mId)}`);
      } catch { /* no active session */ }

      const activeSession = (activeRes as any)?.data;
      if (activeSession && activeSession.status !== 'ended') {
        sId = activeSession.id;
      } else {
        const startRes = await client.post<{ data: { sessionId: string } }>('/meeting-sessions/start', { meetingId: mId });
        sId = startRes.data?.sessionId;
      }

      if (!sId) throw new Error('Failed to create or find a session');

      setSessionId(sId);

      const joinRes = await client.post<{ data: { authToken: string } }>(`/meeting-sessions/${sId}/join`);
      const authToken = joinRes.data?.authToken;

      if (!authToken) throw new Error('Failed to get auth token');

      await initMeeting(authToken, type, audioOn, videoOn, initOpts);
    } catch (err) {
      console.error('[WeldMeet] Failed to connect to meeting:', err);
      setStatus('idle');
    }
  }, [getClient, initMeeting]);

  const joinMeeting = useCallback(async (
    mId: string,
    options?: { meetingType?: 'video' | 'audio'; title?: string; isOrganizer?: boolean; skipPreview?: boolean },
  ) => {
    const type = options?.meetingType ?? 'video';
    setMeetingType(type);
    setMeetingId(mId);
    setMeetingTitle(options?.title ?? '');
    setIsOrganizer(options?.isOrganizer ?? false);

    if (options?.skipPreview) {
      const audioOn = true;
      const videoOn = type === 'video';
      setIsMuted(!audioOn);
      setIsVideoOff(!videoOn);
      await connectToMeeting(mId, type, audioOn, videoOn);
    } else {
      setStatus('preview');
      await startPreview(type);
    }
  }, [startPreview, connectToMeeting]);

  const confirmJoinFromPreview = useCallback(async () => {
    if (!meetingId) return;
    const audioOn = previewAudioEnabled;
    const videoOn = previewVideoEnabled;
    setIsMuted(!audioOn);
    setIsVideoOff(!videoOn);
    stopPreviewStream();
    await connectToMeeting(meetingId, meetingType, audioOn, videoOn);
  }, [stopPreviewStream, previewAudioEnabled, previewVideoEnabled, connectToMeeting, meetingId, meetingType]);

  const cancelPreview = useCallback(() => {
    stopPreviewStream();
    setStatus('idle');
    setMeetingId(null);
    setMeetingTitle('');
    setIsOrganizer(false);
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

  const leaveMeeting = useCallback(async () => {
    if (!meetingId || !sessionId) return;
    const mId = meetingId;
    const sId = sessionId;
    playCallLeaveSound();
    const client = await getClient();
    try {
      await client.post(`/meeting-sessions/${sId}/leave`);
    } catch { /* best effort */ }
    meetingIdRef.current = null;
    sessionIdRef.current = null;
    cleanup();
    queryClient.invalidateQueries({ queryKey: weldmeetKeys.session(mId) });
    queryClient.invalidateQueries({ queryKey: weldmeetKeys.meeting(mId) });
  }, [meetingId, sessionId, getClient, cleanup, queryClient]);

  const endMeetingAction = useCallback(async () => {
    if (!meetingId || !sessionId) return;
    const mId = meetingId;
    const sId = sessionId;
    playCallLeaveSound();
    const client = await getClient();
    try {
      await client.post(`/meeting-sessions/${sId}/end`);
    } catch { /* best effort */ }
    meetingIdRef.current = null;
    sessionIdRef.current = null;
    cleanup();
    queryClient.invalidateQueries({ queryKey: weldmeetKeys.session(mId) });
    queryClient.invalidateQueries({ queryKey: weldmeetKeys.meeting(mId) });
  }, [meetingId, sessionId, getClient, cleanup, queryClient]);

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

  const toggleVideo = useCallback(async () => {
    if (!meeting) {
      console.warn('[WeldMeet] toggleVideo called with no meeting');
      return;
    }
    const wasEnabled = meeting.self.videoEnabled;
    console.log('[WeldMeet] toggleVideo: wasEnabled=', wasEnabled);

    if (wasEnabled) {
      try {
        await meeting.self.disableVideo();
        setIsVideoOff(true);
        playCameraToggleSound();
      } catch (err) {
        console.error('[WeldMeet] disableVideo failed:', err);
      }
      return;
    }

    // Turning the camera ON. Two cases:
    //
    // (1) Permission has never been granted for this origin. Chrome returns
    //     an empty device list from enumerateDevices and RTK's enableVideo()
    //     silently no-ops (no fresh getUserMedia call → no permission prompt
    //     → user thinks the button is broken).
    //
    // (2) Permission is granted and a device was acquired but the cached
    //     handle is now stale (OBS Virtual Camera took over the OS device,
    //     USB cam unplugged, etc.) — RTK reuses the dead handle.
    //
    // Strategy: always start by calling navigator.mediaDevices.getUserMedia
    // directly. On case (1) this triggers the prompt. On case (2) it forces
    // the browser to surface a NotReadableError we can react to. Either way
    // we then release the test stream and hand off to RTK, which will call
    // its own getUserMedia (now succeeding with the granted permission).
    try {
      console.log('[WeldMeet] toggleVideo: requesting getUserMedia to ensure permission');
      const probe = await navigator.mediaDevices.getUserMedia({ video: true });
      probe.getTracks().forEach((t) => t.stop());
      console.log('[WeldMeet] toggleVideo: getUserMedia probe succeeded, releasing test stream');
    } catch (permErr) {
      console.error('[WeldMeet] camera permission denied or no camera available:', permErr);
      return;
    }

    // Now the device list will include real entries with labels.
    try {
      const all = await meeting.self.getAllDevices();
      const videos = (all ?? []).filter((d: any) => d.kind === 'videoinput') as MediaDeviceInfo[];
      console.log('[WeldMeet] toggleVideo: available video inputs=', videos.map((v) => v.label || v.deviceId));

      const current = meeting.self.getCurrentDevices?.();
      const currentId = current?.video?.deviceId;
      const target = (currentId && videos.find((v) => v.deviceId === currentId)) || videos[0];
      if (target) {
        console.log('[WeldMeet] toggleVideo: setting device=', target.label || target.deviceId);
        try {
          await meeting.self.setDevice(target);
        } catch (err) {
          console.warn('[WeldMeet] setDevice failed, continuing to enableVideo anyway:', err);
        }
      }

      await meeting.self.enableVideo();
      const nowEnabled = meeting.self.videoEnabled;
      console.log('[WeldMeet] toggleVideo: enableVideo resolved, videoEnabled now=', nowEnabled);
      setIsVideoOff(!nowEnabled);
      if (nowEnabled) playCameraToggleSound();
    } catch (err) {
      console.error('[WeldMeet] enableVideo failed:', err);
    }
  }, [meeting]);

  const startScreenShare = useCallback(async (constraints?: DisplayMediaStreamOptions) => {
    if (!meeting) return;
    try {
      // RTK's enableScreenShare() takes no arguments — it calls getDisplayMedia
      // internally. To apply the resolution/framerate the user picked in the
      // controls bar we use updateScreenshareConstraints, which is the SDK's
      // supported way to retune the active share. We apply it after enabling
      // so the active track is reconfigured in place.
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
          console.warn('[WeldMeet] updateScreenshareConstraints failed:', err);
        }
      }

      // Bias the encoder for spatial sharpness. Per WeldMeet UX policy
      // (quality > smoothness > delay), 'detail' tells the browser to
      // preserve spatial quality — sharp text, fine UI — even if it has to
      // drop frame rate to do so. The alternative 'motion' optimizes for
      // smooth movement at the cost of sharpness, which produces a mushy
      // image on typical screen share content (docs, code, dashboards).
      try {
        const track = (meeting.self as any).screenShareTracks?.video as
          | MediaStreamTrack
          | undefined;
        if (track && 'contentHint' in track) {
          track.contentHint = 'detail';
        }
      } catch { /* ignore */ }

      // Listen for the user stopping the share via the browser's native
      // "Stop sharing" bar (or OS indicator). The RTK SDK fires a
      // screenShareUpdate event with { screenShareEnabled: false } in that case;
      // mirror it back into React state so the button label stays accurate.
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
        console.error('[WeldMeet] startScreenShare failed:', err);
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
    if (!meeting) return;
    const selfPeerId: string | undefined = meeting.self?.id;
    if (!selfPeerId) return;
    const newState = !handRaised;
    setHandRaised(newState);
    setHandRaisedParticipants((prev) => {
      const next = new Set(prev);
      if (newState) next.add(selfPeerId); else next.delete(selfPeerId);
      return next;
    });
    try {
      meeting.participants.broadcastMessage(
        newState ? 'call:hand-raised' : 'call:hand-lowered',
        { peerId: selfPeerId },
      );
    } catch (err) {
      console.error('[WeldMeet:Call] broadcast hand-raise failed:', err);
    }
    if (newState) playHandRaiseSound(); else playHandLowerSound();
  }, [meeting, handRaised]);

  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev);
    setIsPiP(false);
  }, []);

  const minimizeToPiP = useCallback(() => {
    setIsPiP(true);
    setIsFullscreen(false);
  }, []);

  // Pop-out (Document PiP) is implemented inside MeetingPiPWidget (it owns the
  // popup window + portal). The widget registers its opener here so the
  // in-meeting 3-dots menu can invoke it. Ref-backed + a stable wrapper so the
  // call chain (3-dots click → requestPopOut → openPopOut → requestWindow) stays
  // synchronous and keeps the user-activation Document PiP requires.
  const popOutRef = useRef<() => void>(() => {});
  const registerPopOut = useCallback((fn: () => void) => {
    popOutRef.current = fn;
  }, []);
  const requestPopOut = useCallback(() => {
    popOutRef.current();
  }, []);

  const expandFromPiP = useCallback(() => {
    setIsPiP(false);
  }, []);

  const togglePin = useCallback((id: string) => {
    setPinnedId((prev) => (prev === id ? null : id));
  }, []);

  const startRecording = useCallback(async () => {
    if (!meeting) return;
    // Optimistic state so the UI shows a "Starting…" spinner immediately —
    // RTK provisions the recorder server-side and can take a few seconds before
    // its `recordingUpdate` event arrives. The event reconciles the real state;
    // on failure we fall back to IDLE.
    setRecordingState('STARTING');
    try {
      await meeting.recording.start();
      // Notify backend
      const mId = meetingIdRef.current;
      const sId = sessionIdRef.current;
      if (mId && sId) {
        const client = await getClient();
        await client.post(`/meeting-sessions/${sId}/recording/start`).catch(() => {});
      }
    } catch (e) {
      console.error('[WeldMeetCall] Failed to start recording:', e);
      setRecordingState('IDLE');
    }
  }, [meeting, getClient]);

  const stopRecording = useCallback(async () => {
    if (!meeting) return;
    setRecordingState('STOPPING');
    try {
      await meeting.recording.stop();
      // Notify backend to fetch and save the recording URL
      const mId = meetingIdRef.current;
      const sId = sessionIdRef.current;
      if (mId && sId) {
        const client = await getClient();
        await client.post(`/meeting-sessions/${sId}/recording/stop`).catch(() => {});
      }
    } catch (e) {
      console.error('[WeldMeetCall] Failed to stop recording:', e);
      // Stop failed — recording is likely still running; restore that state.
      setRecordingState('RECORDING');
    }
  }, [meeting, getClient]);

  const pauseRecording = useCallback(async () => {
    if (!meeting) return;
    try {
      await meeting.recording.pause();
    } catch (e) {
      console.error('[WeldMeetCall] Failed to pause recording:', e);
    }
  }, [meeting]);

  const resumeRecording = useCallback(async () => {
    if (!meeting) return;
    try {
      await meeting.recording.resume();
    } catch (e) {
      console.error('[WeldMeetCall] Failed to resume recording:', e);
    }
  }, [meeting]);

  const value: WeldMeetCallContextValue = {
    meetingId,
    sessionId,
    meetingType,
    status,
    isMuted,
    isVideoOff,
    isScreenSharing,
    duration,
    meeting,
    handRaised,
    handRaisedParticipants,
    previewStream,
    previewAudioEnabled,
    previewVideoEnabled,
    isFullscreen,
    isPiP,
    pinnedId,
    viewMode,
    isOrganizer,
    meetingTitle,
    isRecording,
    recordingState,
    backgroundType: virtualBackground.backgroundType,
    backgroundValue: virtualBackground.backgroundValue,
    isBackgroundLoading: virtualBackground.isLoading,
    prewarmedVideoTrack,
    captions,
    joinMeeting,
    confirmJoinFromPreview,
    cancelPreview,
    togglePreviewAudio,
    togglePreviewVideo,
    leaveMeeting,
    endMeeting: endMeetingAction,
    toggleMute,
    toggleVideo,
    startScreenShare,
    stopScreenShare,
    toggleHandRaise,
    toggleFullscreen,
    minimizeToPiP,
    expandFromPiP,
    togglePin,
    requestPopOut,
    registerPopOut,
    setViewMode,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    applyBlur: virtualBackground.applyBlur,
    applyImage: virtualBackground.applyImage,
    removeBackground: virtualBackground.removeBackground,
    prewarmMedia,
  };

  // NOTE: do NOT wrap children in <RealtimeKitProvider> here. The provider's
  // implementation renders `value ? children : fallback` — wrapping the app
  // shell would white-screen every page when `meeting` is null (the common
  // case). The provider should be mounted locally inside meeting-overlay /
  // meeting room components where `meeting` is guaranteed non-null. Until
  // those components adopt it, downstream code keeps using
  // `useWeldMeetCall().meeting`.
  return (
    <WeldMeetCallContext.Provider value={value}>
      {children}
    </WeldMeetCallContext.Provider>
  );
}
