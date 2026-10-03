'use client';

/**
 * Guest Join Client — orchestrator
 *
 * Holds the state machine (loading → landing → waiting/waitlisted/connecting
 * → connected → ended/rejected/error) and all RTK lifecycle. Each named state
 * delegates to a screen component under ./components/.
 *
 * Data layer talks to /api/meeting/* via lib/meeting-api-client.ts (Zod-typed).
 * Form validation lives in the LandingScreen via react-hook-form + zodResolver.
 */

import RealtimeKitClient from '@cloudflare/realtimekit';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';

import {
  createRnnoiseSuppressor,
  installGetUserMediaPatch,
  type NoiseSuppressor,
} from '@weldsuite/df3-noise-suppression';
import {
  enableMicrophone,
  isMicrophonePermissionDenied,
  useMicrophoneRecovery,
  useVirtualBackground,
  type ViewMode,
} from '@weldsuite/weldmeet-ui';
import { writeGuestIdentity } from '@/lib/guest-identity';
import { randomToken } from '@/lib/random-id';

/**
 * RNNoise gate for the guest portal. meeting-portal has no FeatureFlagProvider
 * (no Clerk user to target), so we use an env-var flag here. Enabled by default;
 * set NEXT_PUBLIC_NOISE_SUPPRESSION=false to disable. (Legacy alias:
 * NEXT_PUBLIC_DF3_NOISE_SUPPRESSION=false also disables it.)
 */
const NOISE_SUPPRESSION_ENABLED =
  process.env.NEXT_PUBLIC_NOISE_SUPPRESSION !== 'false' &&
  process.env.NEXT_PUBLIC_DF3_NOISE_SUPPRESSION !== 'false';

/**
 * Explicitly stop the local camera/mic MediaStreamTracks held by the RTK
 * client. RealtimeKit's `leave()` does not reliably stop the
 * underlying hardware tracks in the browser, so without this the OS camera/mic
 * indicator stays lit after the guest leaves the meeting. Each getter can throw
 * when the corresponding media is disabled, so every read is guarded.
 */
function stopLocalMediaTracks(client: RealtimeKitClient | null) {
  if (!client) return;
  const self = client.self as unknown as {
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

/** How long the kicked-state check may take before we fall back to a generic screen. */
const KICK_RESOLVE_TIMEOUT_MS = 8000;

/** Reject if `promise` has not settled within `ms` (the result is then ignored). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

import { POLLING_INTERVAL_MS, getPersonTheme } from '@/lib/constants';
import {
  getGuestMeetingInfo,
  getGuestWaitlistStatus,
  guestJoinMeeting,
  guestLeaveMeeting,
} from '@/lib/meeting-api-client';
import {
  DEFAULT_GUEST_HOST_CONTROLS,
  type GuestHostControls,
  type GuestJoinFormInput,
  type GuestJoinResult,
  type MeetingInfo,
} from '@/lib/schemas';

import { ErrorScreen, EndedScreen, RejectedScreen } from './components/error-screen';
import { GuestMeetingRoom } from './components/guest-meeting-room';
import { LandingScreen } from './components/landing-screen';
import type { PermState } from './components/prejoin-media-controls';
import { ConnectingScreen, LoadingScreen, WaitingScreen } from './components/waiting-screen';
import { WaitlistedScreen } from './components/waitlisted-screen';

type GuestJoinBody = Parameters<typeof guestJoinMeeting>[1];

const MEETING_NOT_FOUND_MESSAGE =
  'This meeting link is invalid or no longer exists. Check the link with the person who invited you.';

/** A 404 from the meeting API (or its "Meeting not found" message) means the link is dead. */
function isMeetingNotFoundError(err: unknown): boolean {
  if ((err as { status?: number } | null)?.status === 404) return true;
  return err instanceof Error && err.message === 'Meeting not found';
}

type PageState =
  | 'loading'
  | 'landing'
  | 'waiting'
  | 'connecting'
  | 'waitlisted'
  | 'connected'
  | 'ended'
  | 'hostEnded'
  | 'removed'
  | 'rejected'
  | 'error';

export default function GuestJoinClient() {
  const params = useParams<{ orgId: string; joinCode: string }>();
  const orgId = params.orgId;
  const joinCode = params.joinCode;

  const [state, setState] = useState<PageState>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  // True when the meeting info lookup says the link points at nothing (404).
  const [meetingNotFound, setMeetingNotFound] = useState(false);
  const [meetingInfo, setMeetingInfo] = useState<MeetingInfo | null>(null);
  // Host-control policy — initialised from /api/meeting/info and updated live
  // via RTK 'call:host-controls-updated' broadcasts from the platform host.
  const [hostControls, setHostControls] = useState<GuestHostControls>(DEFAULT_GUEST_HOST_CONTROLS);

  // Captured from the landing form on submit so other screens (waitlisted,
  // meeting room) have a stable identity to render with.
  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Session
  const [meetingId, setMeetingId] = useState('');
  // Signed guest session token from /join; authenticates chat, upload, leave.
  const [guestToken, setGuestToken] = useState('');
  const [meetingTitle, setMeetingTitle] = useState('');

  // RTK
  const [rtkClient, setRtkClient] = useState<RealtimeKitClient | null>(null);
  const suppressorRef = useRef<NoiseSuppressor | null>(null);
  const suppressorRestoreRef = useRef<(() => void) | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [duration, setDuration] = useState(0);
  // Whether the guest wants their mic on. Survives a browser-level block so
  // the mic comes back by itself once access is allowed again (TASK-713).
  const micWantedRef = useRef(true);

  // Camera preview
  const [previewAudioEnabled, setPreviewAudioEnabled] = useState(true);
  const [previewVideoEnabled, setPreviewVideoEnabled] = useState(true);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [joining, setJoining] = useState(false);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioInput, setSelectedAudioInput] = useState('');
  const [selectedVideoInput, setSelectedVideoInput] = useState('');
  const [audioPermission, setAudioPermission] = useState<PermState>('unknown');
  const [videoPermission, setVideoPermission] = useState<PermState>('unknown');
  // Stable per-session color theme — picked once on mount so the preview
  // tile/avatar color does not flicker as the guest types their name/email.
  const [colorSeed] = useState(() => {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
    return `${Date.now()}-${randomToken(11)}`;
  });
  const personTheme = useMemo(() => getPersonTheme(colorSeed), [colorSeed]);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [preferredViewMode, setPreferredViewMode] = useState<ViewMode>('grid');
  const [effectsOpen, setEffectsOpen] = useState(false);
  // Shared virtual-background hook — same one the platform uses; canonical
  // implementation lives in @weldsuite/weldmeet-ui so platform + portal stay
  // in sync.
  const {
    backgroundType,
    backgroundValue,
    isLoading: isBackgroundLoading,
    applyBlur,
    applyImage,
    removeBackground,
  } = useVirtualBackground(rtkClient);
  const videoRef = useRef<HTMLVideoElement>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // The RTK client the page currently owns. Event handlers compare against it
  // so a late event from a client the guest already left (or replaced) cannot
  // drive the UI, e.g. flip a fresh landing form back to "Connecting...".
  const activeRtkRef = useRef<RealtimeKitClient | null>(null);
  const rtkListenersCleanupRef = useRef<(() => void) | null>(null);
  // Bumped whenever a new join attempt starts or the guest leaves the
  // removed/ended screens, so an in-flight kicked-state check is discarded.
  const kickResolveSeqRef = useRef(0);
  const durationRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Fetch meeting info on mount ──

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await getGuestMeetingInfo(orgId, joinCode);
        if (cancelled) return;
        setMeetingInfo(info);
        setMeetingTitle(info.title);
        if (info.hostControls) setHostControls(info.hostControls);

        if (info.status === 'cancelled') {
          setState('error');
          setErrorMsg('This meeting has been cancelled.');
        } else if (info.status === 'completed') {
          setState('error');
          setErrorMsg('This meeting has already ended.');
        } else {
          setState('landing');
        }
      } catch (err: unknown) {
        if (cancelled) return;
        setState('error');
        if (isMeetingNotFoundError(err)) {
          setMeetingNotFound(true);
          setErrorMsg(MEETING_NOT_FOUND_MESSAGE);
        } else {
          setErrorMsg(err instanceof Error ? err.message : 'Failed to load meeting information.');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, joinCode]);

  // ── Duration timer ──

  useEffect(() => {
    if (state === 'connected') {
      durationRef.current = setInterval(() => setDuration((d) => d + 1), 1000);
    } else if (durationRef.current) {
      clearInterval(durationRef.current);
      durationRef.current = null;
    }
    return () => { if (durationRef.current) clearInterval(durationRef.current); };
  }, [state]);

  // ── Cleanup on unmount ──

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (durationRef.current) clearInterval(durationRef.current);
      rtkListenersCleanupRef.current?.();
      rtkListenersCleanupRef.current = null;
      activeRtkRef.current = null;
      kickResolveSeqRef.current += 1;
    };
  }, []);

  // ── Track browser fullscreen state ──

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    onChange();
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // ── Re-render when RTK self media state flips (waitlisted view) ──

  const [, setRtkSelfVersion] = useState(0);
  useEffect(() => {
    if (!rtkClient) return;
    // Listener only bumps the version so the videoRef effect re-attaches on
    // fresh track creation. The toggle handlers own previewAudioEnabled /
    // previewVideoEnabled directly so the button state never lags behind a
    // user click (and isn't overwritten by a possibly-stale audioUpdate event).
    const bump = () => setRtkSelfVersion(v => v + 1);
    rtkClient.self?.on?.('audioUpdate', bump);
    rtkClient.self?.on?.('videoUpdate', bump);
    // One-time sync at mount in case RTK's actual state differs from what we
    // asked for in defaults (e.g. permission was revoked between landing
    // and join).
    setPreviewAudioEnabled(!!rtkClient.self?.audioEnabled);
    setPreviewVideoEnabled(!!rtkClient.self?.videoEnabled);
    return () => {
      rtkClient.self?.off?.('audioUpdate', bump);
      rtkClient.self?.off?.('videoUpdate', bump);
    };
  }, [rtkClient]);

  // ── Keep the in-call mic state in step with RTK ──
  // A mic turned off while access is allowed (host mute, the participant
  // menu) is a real mute; one lost to a browser block is not, so it comes
  // back once access is allowed again.
  useEffect(() => {
    const self = rtkClient?.self;
    if (!self) return;
    const onAudioUpdate = () => {
      setIsMuted(!self.audioEnabled);
      if (self.audioEnabled) {
        micWantedRef.current = true;
        return;
      }
      void isMicrophonePermissionDenied().then((denied) => {
        if (!denied && !self.audioEnabled) micWantedRef.current = false;
      });
    };
    self.on('audioUpdate', onAudioUpdate);
    return () => {
      self.off('audioUpdate', onAudioUpdate);
    };
  }, [rtkClient]);

  useMicrophoneRecovery(rtkClient?.self, {
    isMicWanted: () => micWantedRef.current,
    onLost: () => {
      setIsMuted(true);
      setPreviewAudioEnabled(false);
    },
    onRestored: ({ enabled }) => {
      setIsMuted(!enabled);
      setPreviewAudioEnabled(enabled);
    },
  });

  // ── Leave on tab close ──

  useEffect(() => {
    const handler = () => {
      if (meetingId && guestToken) {
        guestLeaveMeeting(orgId, { meetingId, guestToken }, { keepalive: true }).catch(() => {});
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [orgId, meetingId, guestToken]);

  // ── Camera preview ──

  useEffect(() => {
    if (state !== 'landing') return;
    let cancelled = false;

    const refreshDevices = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        setAudioInputs(devices.filter(d => d.kind === 'audioinput'));
        setVideoInputs(devices.filter(d => d.kind === 'videoinput'));
      } catch { /* ignore */ }
    };

    // Query permission state (Chromium/Firefox; Safari support varies).
    const queriedPermissions: PermissionStatus[] = [];
    (async () => {
      const q = navigator.permissions?.query?.bind(navigator.permissions);
      if (!q) return;
      for (const [name, setter] of [
        ['microphone', setAudioPermission],
        ['camera', setVideoPermission],
      ] as const) {
        try {
          const status: PermissionStatus = await q({ name });
          if (cancelled) return;
          setter(status.state as PermState);
          status.onchange = () => { if (!cancelled) setter(status.state as PermState); };
          queriedPermissions.push(status);
        } catch { /* not supported for this name */ }
      }
    })();

    (async () => {
      // Request audio and video SEPARATELY. A combined { video: true, audio: true }
      // call fails wholesale with NotFoundError if either device is missing —
      // so a guest on a laptop with no camera (or no mic) ends up with neither
      // stream. Acquiring them independently lets us gracefully degrade.
      const acquire = async (
        constraints: MediaStreamConstraints,
        kind: 'audio' | 'video',
      ): Promise<MediaStream | null> => {
        try {
          return await navigator.mediaDevices.getUserMedia(constraints);
        } catch (err) {
          const { name, message } = err as { name?: string; message?: string };
          console.warn(`[GuestJoin] getUserMedia(${kind}) failed:`, name, message);
          if (name === 'NotAllowedError') {
            const setter = kind === 'audio' ? setAudioPermission : setVideoPermission;
            setter(prev => prev === 'granted' ? prev : 'denied');
          } else {
            const setter = kind === 'audio' ? setAudioPermission : setVideoPermission;
            setter(prev => prev === 'unknown' ? 'prompt' : prev);
          }
          return null;
        }
      };

      const [audioStream, videoStream] = await Promise.all([
        acquire({ audio: true }, 'audio'),
        acquire({ video: true }, 'video'),
      ]);

      if (cancelled) {
        audioStream?.getTracks().forEach(t => t.stop());
        videoStream?.getTracks().forEach(t => t.stop());
        return;
      }

      const combined = new MediaStream();
      audioStream?.getAudioTracks().forEach(t => combined.addTrack(t));
      videoStream?.getVideoTracks().forEach(t => combined.addTrack(t));

      if (combined.getTracks().length > 0) {
        setPreviewStream(combined);
      }
      if (audioStream) setAudioPermission('granted');
      if (videoStream) setVideoPermission('granted');

      // Reflect missing hardware in the toggle state so the pre-join controls
      // show "off" for any device we couldn't acquire — otherwise the user
      // sees a normal "on" toggle and joins expecting working video/audio.
      if (!audioStream) setPreviewAudioEnabled(false);
      if (!videoStream) setPreviewVideoEnabled(false);

      await refreshDevices();

      const audioTrack = audioStream?.getAudioTracks()[0];
      const videoTrack = videoStream?.getVideoTracks()[0];
      if (audioTrack?.getSettings().deviceId) setSelectedAudioInput(audioTrack.getSettings().deviceId!);
      if (videoTrack?.getSettings().deviceId) setSelectedVideoInput(videoTrack.getSettings().deviceId!);
    })();

    navigator.mediaDevices.addEventListener?.('devicechange', refreshDevices);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener?.('devicechange', refreshDevices);
      queriedPermissions.forEach(p => { p.onchange = null; });
      setPreviewStream(prev => { prev?.getTracks().forEach(t => t.stop()); return null; });
    };
  }, [state]);

  // ── Attach preview / RTK self stream to the <video> tag ──

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    // Prefer RTK's self video track once we've initialized the client (the
    // preview stream is stopped at that point so the camera can move to RTK).
    const rtkTrack = rtkClient?.self?.videoEnabled ? rtkClient?.self?.videoTrack : null;
    if (rtkTrack) {
      el.srcObject = new MediaStream([rtkTrack]);
    } else if (previewStream && previewVideoEnabled) {
      el.srcObject = previewStream;
    } else {
      el.srcObject = null;
    }
  }, [previewStream, previewVideoEnabled, state, rtkClient]);

  const togglePreviewAudio = useCallback(() => {
    if (rtkClient?.self) {
      // Once RTK owns the mic, toggle via the SDK and set the explicit state
      // (no `v => !v` flip — the SDK is the source of truth, not React state).
      if (rtkClient.self.audioEnabled) {
        micWantedRef.current = false;
        void rtkClient.self.disableAudio();
        setPreviewAudioEnabled(false);
      } else {
        micWantedRef.current = true;
        setPreviewAudioEnabled(true);
        void enableMicrophone(rtkClient.self).then(({ enabled }) => setPreviewAudioEnabled(enabled));
      }
      return;
    }
    if (previewStream) {
      previewStream.getAudioTracks().forEach(t => { t.enabled = !t.enabled; });
    }
    setPreviewAudioEnabled(v => !v);
  }, [previewStream, rtkClient]);

  const togglePreviewVideo = useCallback(() => {
    if (rtkClient?.self) {
      if (rtkClient.self.videoEnabled) {
        void rtkClient.self.disableVideo();
        setPreviewVideoEnabled(false);
      } else {
        void rtkClient.self.enableVideo();
        setPreviewVideoEnabled(true);
      }
      return;
    }
    if (previewStream) {
      previewStream.getVideoTracks().forEach(t => { t.enabled = !t.enabled; });
    }
    setPreviewVideoEnabled(v => !v);
  }, [previewStream, rtkClient]);

  // ── Device switching ──

  const changeAudioDevice = useCallback(async (deviceId: string) => {
    if (!deviceId || deviceId === selectedAudioInput) return;
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
        video: selectedVideoInput ? { deviceId: { exact: selectedVideoInput } } : true,
      });
      next.getAudioTracks().forEach(t => { t.enabled = previewAudioEnabled; });
      next.getVideoTracks().forEach(t => { t.enabled = previewVideoEnabled; });
      previewStream?.getTracks().forEach(t => t.stop());
      setPreviewStream(next);
      setSelectedAudioInput(deviceId);
      const v = next.getVideoTracks()[0]?.getSettings().deviceId;
      if (v) setSelectedVideoInput(v);
    } catch { /* permission or device error */ }
  }, [previewStream, previewAudioEnabled, previewVideoEnabled, selectedAudioInput, selectedVideoInput]);

  const changeVideoDevice = useCallback(async (deviceId: string) => {
    if (!deviceId || deviceId === selectedVideoInput) return;
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        audio: selectedAudioInput ? { deviceId: { exact: selectedAudioInput } } : true,
        video: { deviceId: { exact: deviceId } },
      });
      next.getAudioTracks().forEach(t => { t.enabled = previewAudioEnabled; });
      next.getVideoTracks().forEach(t => { t.enabled = previewVideoEnabled; });
      previewStream?.getTracks().forEach(t => t.stop());
      setPreviewStream(next);
      setSelectedVideoInput(deviceId);
      const a = next.getAudioTracks()[0]?.getSettings().deviceId;
      if (a) setSelectedAudioInput(a);
    } catch { /* permission or device error */ }
  }, [previewStream, previewAudioEnabled, previewVideoEnabled, selectedAudioInput, selectedVideoInput]);

  const requestPermissions = useCallback(async () => {
    // Acquire audio and video independently — see the landing effect for why
    // a combined getUserMedia call is unsafe (NotFoundError tears down both).
    const acquire = async (
      constraints: MediaStreamConstraints,
      kind: 'audio' | 'video',
    ): Promise<MediaStream | null> => {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        const { name, message } = err as { name?: string; message?: string };
        console.warn(`[GuestJoin] requestPermissions(${kind}) failed:`, name, message);
        const setter = kind === 'audio' ? setAudioPermission : setVideoPermission;
        if (name === 'NotAllowedError') setter('denied');
        return null;
      }
    };

    const [audioStream, videoStream] = await Promise.all([
      acquire({ audio: true }, 'audio'),
      acquire({ video: true }, 'video'),
    ]);

    previewStream?.getTracks().forEach(t => t.stop());

    const combined = new MediaStream();
    audioStream?.getAudioTracks().forEach(t => combined.addTrack(t));
    videoStream?.getVideoTracks().forEach(t => combined.addTrack(t));
    setPreviewStream(combined.getTracks().length > 0 ? combined : null);

    if (audioStream) setAudioPermission('granted');
    if (videoStream) setVideoPermission('granted');

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setAudioInputs(devices.filter(d => d.kind === 'audioinput'));
      setVideoInputs(devices.filter(d => d.kind === 'videoinput'));
    } catch { /* ignore */ }

    const a = audioStream?.getAudioTracks()[0]?.getSettings().deviceId;
    const v = videoStream?.getVideoTracks()[0]?.getSettings().deviceId;
    if (a) setSelectedAudioInput(a);
    if (v) setSelectedVideoInput(v);
  }, [previewStream]);

  // ── Connect to RTK ──

  // Detach the current client's listeners and stop treating it as the active
  // client. Anything it emits afterwards is ignored.
  const detachRtkClient = useCallback(() => {
    rtkListenersCleanupRef.current?.();
    rtkListenersCleanupRef.current = null;
    activeRtkRef.current = null;
  }, []);

  const releaseNoiseSuppression = useCallback(() => {
    try { suppressorRestoreRef.current?.(); } catch { /* ignore */ }
    suppressorRestoreRef.current = null;
    const sup = suppressorRef.current;
    suppressorRef.current = null;
    sup?.dispose().catch((err) => console.warn('[noise] dispose error:', err));
  }, []);

  const connectToRtk = useCallback(async (authToken: string) => {
    // A new attempt supersedes any previous client and any pending
    // kicked-state check.
    detachRtkClient();
    kickResolveSeqRef.current += 1;
    setState('connecting');
    try {
      const meetingType = meetingInfo?.meetingType ?? 'video';
      // Capture user's chosen mic/cam toggle state BEFORE we release the
      // preview stream (which owns the camera/mic until RTK takes over).
      const wantAudio = previewAudioEnabled;
      const wantVideo = previewVideoEnabled && meetingType === 'video';

      // Release the preview's getUserMedia tracks so RTK can acquire the
      // camera/mic exclusively. macOS/Chrome only allow a single consumer
      // per device, so without this RTK comes up with a dead stream.
      previewStream?.getTracks().forEach(t => t.stop());
      setPreviewStream(null);

      // Apply the meeting's noise-cancellation policy at RTK init time. Mid-
      // call host flips only affect subsequent join attempts (RTK has no
      // public per-session toggle for noiseSupression).
      const wantNoiseSupression = hostControls.noiseCancellation !== false;

      // Noise-suppression path: monkey-patch getUserMedia so RTK's internal
      // acquisition flows through RNNoise. Disable RTK's own NS to avoid
      // double-processing.
      const useNoiseSuppression = NOISE_SUPPRESSION_ENABLED && wantAudio && wantNoiseSupression;
      if (useNoiseSuppression) {
        const suppressor = createRnnoiseSuppressor({
          workerUrl: '/rnnoise-worker.js',
          workletUrl: '/df3-worklet-processor.js',
          logRtf: process.env.NODE_ENV !== 'production',
        });
        suppressorRef.current = suppressor;
        suppressorRestoreRef.current = installGetUserMediaPatch(suppressor);
      }

      let m: RealtimeKitClient;
      try {
        m = await RealtimeKitClient.init({
          authToken,
          defaults: {
            audio: wantAudio,
            video: wantVideo,
            mediaConfiguration: {
              audio: { noiseSupression: useNoiseSuppression ? false : wantNoiseSupression },
            },
          },
        });
      } catch (initErr) {
        try { suppressorRestoreRef.current?.(); } catch { /* ignore */ }
        suppressorRestoreRef.current = null;
        const sup = suppressorRef.current;
        suppressorRef.current = null;
        sup?.dispose().catch(() => undefined);
        throw initErr;
      }

      // From here on `m` is the page's current client. Every handler below
      // checks this first, so events from a client the guest already left or
      // replaced (RTK can emit roomLeft more than once, or late) are no-ops.
      const isCurrent = () => activeRtkRef.current === m;
      activeRtkRef.current = m;

      const resolveKickedState = async () => {
        // Both "host ended the meeting for all" and "host removed this guest"
        // arrive as 'kicked'. Show a neutral loading screen (never
        // 'connecting': nothing is connecting, and a stale 'connecting' is
        // how a screen can end up spinning with no join call) while a fresh
        // info read tells the two apart, so the guest never sees a wrong
        // message flash.
        const seq = (kickResolveSeqRef.current += 1);
        const isStale = () => kickResolveSeqRef.current !== seq;
        setState('loading');
        try {
          const info = await withTimeout(getGuestMeetingInfo(orgId, joinCode), KICK_RESOLVE_TIMEOUT_MS);
          if (isStale()) return;
          setMeetingInfo(info);
          if (info.status === 'completed' || !info.hasActiveSession) {
            setState('hostEnded');
          } else {
            setState('removed');
          }
        } catch {
          if (isStale()) return;
          // Couldn't tell which it was; fall back to the generic ended screen.
          setState('ended');
        }
      };

      const onRoomJoined = () => {
        if (isCurrent()) setState('connected');
      };
      const onWaitlisted = () => {
        if (isCurrent()) setState('waitlisted');
      };
      const onRoomLeft = ({ state }: { state?: string }) => {
        if (!isCurrent()) return;
        // This client is done: handle its first roomLeft only, and drop its
        // listeners so nothing it emits later can touch the UI again.
        detachRtkClient();
        // Release the camera/mic — RTK doesn't reliably stop them on its own.
        stopLocalMediaTracks(m);
        setRtkClient(null);
        releaseNoiseSuppression();

        if (state === 'rejected') {
          setState('rejected');
        } else if (state === 'ended') {
          setState('hostEnded');
        } else if (state === 'kicked') {
          // Both "host ended the meeting for all" and "host removed this guest"
          // surface as 'kicked'. The backend clears the active session before
          // kicking, so a fresh meeting-info read tells the two apart.
          void resolveKickedState();
        } else {
          setState('ended');
        }
      };

      m.self.on('roomJoined', onRoomJoined);
      m.self.on('waitlisted', onWaitlisted);
      m.self.on('roomLeft', onRoomLeft);
      rtkListenersCleanupRef.current = () => {
        m.self.off('roomJoined', onRoomJoined);
        m.self.off('waitlisted', onWaitlisted);
        m.self.off('roomLeft', onRoomLeft);
      };

      await m.join();
      // roomLeft can fire during join() (e.g. the host denied entry). That
      // handler already moved the UI on; don't resurrect the client.
      if (!isCurrent()) return;
      setRtkClient(m);
      micWantedRef.current = wantAudio;
      setIsMuted(!wantAudio);
      setIsVideoOff(!wantVideo);

      // Reconcile against RTK's authoritative room state. On a warm re-init
      // (e.g. the guest left and tapped "Rejoin" without a page reload),
      // join() can resolve with the room already in 'joined'/'waitlisted' —
      // the roomJoined/waitlisted event fired inside join() before our
      // listeners could observe it. Without this, there's no event left to
      // flip the UI and we hang on 'connecting' forever. Reading roomState is
      // idempotent with the event handlers above, so it's safe on first join.
      const roomState = (m.self as unknown as { roomState?: string }).roomState;
      if (roomState === 'joined') {
        setState('connected');
      } else if (roomState === 'waitlisted') {
        setState('waitlisted');
      }
    } catch (err) {
      console.error('[GuestJoin] RTK connection failed:', err);
      detachRtkClient();
      setState('error');
      setErrorMsg('Failed to connect to the meeting. Please try again.');
    }
  }, [orgId, joinCode, meetingInfo, previewStream, previewAudioEnabled, previewVideoEnabled, hostControls, detachRtkClient, releaseNoiseSuppression]);

  // ── Join handler ──

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Applies the outcome of a (re-)join attempt made while polling: ended and
  // removed stop the poll with a terminal screen, joined stops it and connects
  // to RTK. A response that lands after polling already stopped (an earlier
  // tick still in flight) is ignored so it cannot start a second connection or
  // override the screen the guest is on.
  const applyPolledJoinResult = useCallback(async (retry: GuestJoinResult) => {
    if (!pollRef.current) return;
    if (retry.status === 'ended') {
      stopPolling();
      setState('error');
      setErrorMsg('This meeting has already ended.');
      return;
    }
    if (retry.status === 'removed') {
      stopPolling();
      setState('removed');
      return;
    }
    if (retry.status === 'joined' && retry.authToken && retry.sessionId) {
      stopPolling();
      setGuestToken(retry.guestToken ?? '');
      await connectToRtk(retry.authToken);
    }
  }, [stopPolling, connectToRtk]);

  const retryJoin = useCallback(async (body: GuestJoinBody) => {
    try {
      const retry = await guestJoinMeeting(orgId, body);
      await applyPolledJoinResult(retry);
    } catch { /* keep polling */ }
  }, [orgId, applyPolledJoinResult]);

  const pollWaitlist = useCallback(async (
    joinedMeetingId: string,
    waitlistId: string,
    body: GuestJoinBody,
  ) => {
    try {
      const status = await getGuestWaitlistStatus(orgId, joinedMeetingId, waitlistId);
      if (status === 'denied') {
        stopPolling();
        setState('rejected');
        return;
      }
      if (status === 'admitted') {
        const retry = await guestJoinMeeting(orgId, body);
        await applyPolledJoinResult(retry);
      }
    } catch { /* keep polling */ }
  }, [orgId, stopPolling, applyPolledJoinResult]);

  const applyJoinResult = useCallback(async (result: GuestJoinResult, body: GuestJoinBody) => {
    if (result.status === 'ended') {
      setState('error');
      setErrorMsg('This meeting has already ended.');
      return;
    }
    if (result.status === 'removed') {
      // The host removed this guest from the running session; refused for the
      // rest of it. No polling, no Rejoin.
      stopPolling();
      setState('removed');
      return;
    }
    if (result.status === 'waiting') {
      setState('waiting');
      pollRef.current = setInterval(() => { void retryJoin(body); }, POLLING_INTERVAL_MS.waitingForSession);
      return;
    }
    if (result.status === 'waitlisted' && result.waitlistId) {
      // WeldSuite-side waiting room (meeting.waitingRoom === true). The host
      // approves via the in-meeting Host Controls. We poll the dedicated
      // status endpoint; once admitted, re-call /api/meeting/join to mint
      // the actual RTK token.
      setState('waitlisted');
      const { meetingId: joinedMeetingId, waitlistId } = result;
      pollRef.current = setInterval(() => {
        void pollWaitlist(joinedMeetingId, waitlistId, body);
      }, POLLING_INTERVAL_MS.waitlist);
      return;
    }
    if (result.status === 'joined' && result.authToken && result.sessionId) {
      setGuestToken(result.guestToken ?? '');
      await connectToRtk(result.authToken);
    }
  }, [retryJoin, pollWaitlist, connectToRtk, stopPolling]);

  const handleJoin = useCallback(async ({ name, email }: GuestJoinFormInput) => {
    setSubmitError(null);
    setGuestName(name);
    setGuestEmail(email);
    setJoining(true);
    // A fresh attempt supersedes any earlier polling or kicked-state check.
    stopPolling();
    kickResolveSeqRef.current += 1;

    try {
      const body: GuestJoinBody = { joinCode, name, email, colorSeed };
      const result = await guestJoinMeeting(orgId, body);

      // Remember the details for next time (prefills the landing form).
      if (result.status !== 'removed' && result.status !== 'ended') {
        writeGuestIdentity({ name, email });
      }

      setMeetingId(result.meetingId);
      setMeetingTitle(result.meetingTitle);

      await applyJoinResult(result, body);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to join meeting.');
      setJoining(false);
    }
  }, [orgId, joinCode, colorSeed, applyJoinResult, stopPolling]);

  // ── Leave handler ──

  const handleLeave = useCallback(async () => {
    // We are leaving on purpose: stop listening to this client so its own
    // roomLeft (or a late one) cannot overwrite whatever screen comes next.
    detachRtkClient();
    if (rtkClient) {
      // Stop the local hardware tracks first — RTK's leave() does not reliably
      // release the camera/mic, so the device indicator would otherwise stay on.
      stopLocalMediaTracks(rtkClient);
      Promise.resolve()
        .then(() => rtkClient.leave())
        .catch(() => { /* ignore */ });
    }
    setRtkClient(null);
    releaseNoiseSuppression();

    if (meetingId && guestToken) {
      try {
        await guestLeaveMeeting(orgId, { meetingId, guestToken });
      } catch { /* best effort */ }
    }

    setState('ended');
  }, [rtkClient, orgId, meetingId, guestToken, detachRtkClient, releaseNoiseSuppression]);

  // ── Media controls (connected room) ──

  const toggleMute = useCallback(async () => {
    if (!rtkClient) return;
    if (rtkClient.self.audioEnabled) {
      micWantedRef.current = false;
      void rtkClient.self.disableAudio();
      setIsMuted(true);
      return;
    }
    micWantedRef.current = true;
    // Re-acquires the mic when its track ended (access revoked and allowed
    // again), where a plain enableAudio() would leave it off (TASK-713). Reads
    // the real state, so a blocked mic doesn't show as on.
    const { enabled } = await enableMicrophone(rtkClient.self);
    setIsMuted(!enabled);
  }, [rtkClient]);

  const toggleVideo = useCallback(async () => {
    if (!rtkClient) return;
    if (rtkClient.self.videoEnabled) {
      try {
        await rtkClient.self.disableVideo();
        setIsVideoOff(true);
      } catch (err) {
        console.error('[GuestMeetingRoom] disableVideo failed:', err);
      }
      return;
    }

    // Trigger the permission prompt directly if it hasn't been granted yet.
    // Without this, enumerateDevices returns empty and RTK's enableVideo
    // silently no-ops because there are no devices to acquire.
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true });
      probe.getTracks().forEach((t) => t.stop());
    } catch (permErr) {
      console.error('[GuestMeetingRoom] camera permission denied or unavailable:', permErr);
      return;
    }

    try {
      const self = rtkClient.self;
      const all = await self.getAllDevices?.();
      const videos = (all ?? []).filter((d) => d.kind === 'videoinput');
      const current = self.getCurrentDevices?.();
      const currentId = current?.video?.deviceId;
      const target = (currentId && videos.find((v) => v.deviceId === currentId)) || videos[0];
      if (target) {
        try { await self.setDevice?.(target); }
        catch (err) { console.warn('[GuestMeetingRoom] setDevice failed:', err); }
      }
      await rtkClient.self.enableVideo();
      setIsVideoOff(!rtkClient.self.videoEnabled);
    } catch (err) {
      console.error('[GuestMeetingRoom] enableVideo failed:', err);
    }
  }, [rtkClient]);

  // Waitlisted "Leave" button — releases preview tracks and exits RTK without
  // hitting /api/meeting/leave (the guest is not yet in the active session).
  const handleWaitlistedLeave = useCallback(() => {
    detachRtkClient();
    previewStream?.getTracks().forEach(t => t.stop());
    stopLocalMediaTracks(rtkClient);
    void rtkClient?.leave();
    setRtkClient(null);
    releaseNoiseSuppression();
    setState('ended');
  }, [previewStream, rtkClient, detachRtkClient, releaseNoiseSuppression]);

  // ── Render ──

  if (state === 'loading') return <LoadingScreen />;
  if (state === 'error') {
    return meetingNotFound ? (
      <ErrorScreen joinCode={joinCode} title="Meeting not found" message={errorMsg} hint="" />
    ) : (
      <ErrorScreen message={errorMsg} joinCode={joinCode} />
    );
  }
  if (state === 'ended' || state === 'hostEnded' || state === 'removed') {
    const endedVariant = state === 'ended' ? 'left' : state;
    return (
      <EndedScreen
        variant={endedVariant}
        onReturnHome={() => {
          window.location.href = 'https://www.weldsuite.org/';
        }}
        onRejoin={async () => {
          // Back to a clean slate. `joining` stays true after a successful
          // join (the landing form is unmounted, not reset), so without this
          // the landing screen reopens in its "Connecting..." overlay with the
          // form hidden and never sends a /join: the Rejoin hang.
          kickResolveSeqRef.current += 1;
          stopPolling();
          setJoining(false);
          setSubmitError(null);
          // Re-check the meeting before sending the guest back to the landing
          // form. If the host has closed the meeting in the meantime, surface
          // the "already ended" screen instead of letting them re-enter their
          // details only to hit a dead end.
          try {
            const info = await getGuestMeetingInfo(orgId, joinCode);
            setMeetingInfo(info);
            if (info.status === 'completed') {
              setState('error');
              setErrorMsg('This meeting has already ended.');
              return;
            }
            if (info.status === 'cancelled') {
              setState('error');
              setErrorMsg('This meeting has been cancelled.');
              return;
            }
          } catch {
            // Couldn't re-check — fall through to landing; the join call will
            // re-validate and surface any terminal state.
          }
          setState('landing');
          setDuration(0);
        }}
      />
    );
  }
  if (state === 'rejected') return <RejectedScreen />;

  if (state === 'landing') {
    return (
      <LandingScreen
        joinCode={joinCode}
        meetingInfo={meetingInfo}
        joining={joining}
        submitError={submitError}
        personTheme={personTheme}
        videoRef={videoRef}
        previewStream={previewStream}
        previewAudioEnabled={previewAudioEnabled}
        previewVideoEnabled={previewVideoEnabled}
        audioPermission={audioPermission}
        videoPermission={videoPermission}
        audioInputs={audioInputs}
        videoInputs={videoInputs}
        selectedAudioInput={selectedAudioInput}
        selectedVideoInput={selectedVideoInput}
        togglePreviewAudio={togglePreviewAudio}
        togglePreviewVideo={togglePreviewVideo}
        changeAudioDevice={changeAudioDevice}
        changeVideoDevice={changeVideoDevice}
        requestPermissions={requestPermissions}
        onSubmit={handleJoin}
      />
    );
  }

  if (state === 'waiting') return <WaitingScreen />;
  if (state === 'connecting') return <ConnectingScreen />;

  if (state === 'waitlisted') {
    return (
      <WaitlistedScreen
        guestName={guestName}
        personTheme={personTheme}
        videoRef={videoRef}
        rtkClient={rtkClient}
        previewStream={previewStream}
        previewAudioEnabled={previewAudioEnabled}
        previewVideoEnabled={previewVideoEnabled}
        audioPermission={audioPermission}
        videoPermission={videoPermission}
        audioInputs={audioInputs}
        videoInputs={videoInputs}
        selectedAudioInput={selectedAudioInput}
        selectedVideoInput={selectedVideoInput}
        togglePreviewAudio={togglePreviewAudio}
        togglePreviewVideo={togglePreviewVideo}
        changeAudioDevice={changeAudioDevice}
        changeVideoDevice={changeVideoDevice}
        isFullscreen={isFullscreen}
        effectsOpen={effectsOpen}
        setEffectsOpen={setEffectsOpen}
        preferredViewMode={preferredViewMode}
        setPreferredViewMode={setPreferredViewMode}
        backgroundType={backgroundType}
        backgroundValue={backgroundValue}
        isBackgroundLoading={isBackgroundLoading}
        applyBlur={applyBlur}
        applyImage={applyImage}
        removeBackground={removeBackground}
        onLeave={handleWaitlistedLeave}
      />
    );
  }

  // Connected
  return (
    <GuestMeetingRoom
      rtkClient={rtkClient}
      meetingTitle={meetingTitle || meetingInfo?.title || ''}
      duration={duration}
      isMuted={isMuted}
      isVideoOff={isVideoOff}
      toggleMute={toggleMute}
      toggleVideo={toggleVideo}
      handleLeave={handleLeave}
      joinCode={joinCode}
      colorSeed={colorSeed}
      meetingId={meetingId}
      orgId={orgId}
      guestName={guestName}
      guestEmail={guestEmail}
      guestToken={guestToken}
      hostControls={hostControls}
      onHostControlsBroadcast={setHostControls}
    />
  );
}
