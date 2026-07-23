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
import { useVirtualBackground, type ViewMode } from '@weldsuite/weldmeet-ui';

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
 * client. RealtimeKit's `leave()`/`leaveRoom()` does not reliably stop the
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
  type MeetingInfo,
} from '@/lib/schemas';

import { ErrorScreen, EndedScreen, RejectedScreen } from './components/error-screen';
import { GuestMeetingRoom } from './components/guest-meeting-room';
import { LandingScreen } from './components/landing-screen';
import type { PermState } from './components/prejoin-media-controls';
import { ConnectingScreen, LoadingScreen, WaitingScreen } from './components/waiting-screen';
import { WaitlistedScreen } from './components/waitlisted-screen';

type PageState =
  | 'loading'
  | 'landing'
  | 'waiting'
  | 'connecting'
  | 'waitlisted'
  | 'connected'
  | 'ended'
  | 'rejected'
  | 'error';

export default function GuestJoinClient() {
  const params = useParams<{ orgId: string; joinCode: string }>();
  const orgId = params.orgId;
  const joinCode = params.joinCode;

  const [state, setState] = useState<PageState>('loading');
  const [errorMsg, setErrorMsg] = useState('');
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
  const [sessionId, setSessionId] = useState('');
  const [meetingTitle, setMeetingTitle] = useState('');

  // RTK
  const [rtkClient, setRtkClient] = useState<RealtimeKitClient | null>(null);
  const suppressorRef = useRef<NoiseSuppressor | null>(null);
  const suppressorRestoreRef = useRef<(() => void) | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [duration, setDuration] = useState(0);

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
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
    // Cast to any — packages/design/weldmeet-ui has its own pinned copy of
    // @cloudflare/realtimekit, so the structural-but-nominally-different
    // RealtimeKitClient types don't line up across the workspace boundary.
  } = useVirtualBackground(rtkClient as any);
  const videoRef = useRef<HTMLVideoElement>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
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
        setErrorMsg(err instanceof Error ? err.message : 'Failed to load meeting information.');
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

  // ── Leave on tab close ──

  useEffect(() => {
    const handler = () => {
      if (meetingId && sessionId && guestEmail) {
        try {
          fetch('/api/meeting/leave', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orgId, meetingId, sessionId, email: guestEmail }),
            keepalive: true,
          }).catch(() => {});
        } catch { /* best effort */ }
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [orgId, meetingId, sessionId, guestEmail]);

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
      const q = (navigator as any).permissions?.query?.bind(navigator.permissions);
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
        } catch (err: any) {
          console.warn(`[GuestJoin] getUserMedia(${kind}) failed:`, err?.name, err?.message);
          if (err?.name === 'NotAllowedError') {
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
        rtkClient.self.disableAudio();
        setPreviewAudioEnabled(false);
      } else {
        rtkClient.self.enableAudio();
        setPreviewAudioEnabled(true);
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
        rtkClient.self.disableVideo();
        setPreviewVideoEnabled(false);
      } else {
        rtkClient.self.enableVideo();
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
      } catch (err: any) {
        console.warn(`[GuestJoin] requestPermissions(${kind}) failed:`, err?.name, err?.message);
        const setter = kind === 'audio' ? setAudioPermission : setVideoPermission;
        if (err?.name === 'NotAllowedError') setter('denied');
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

  const connectToRtk = useCallback(async (authToken: string) => {
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

      m.self.on('roomJoined', () => setState('connected'));
      m.self.on('waitlisted', () => setState('waitlisted'));
      m.self.on('roomLeft', ({ state }: { state?: string }) => {
        // Release the camera/mic — RTK doesn't reliably stop them on its own.
        stopLocalMediaTracks(m);
        setRtkClient(null);
        try { suppressorRestoreRef.current?.(); } catch { /* ignore */ }
        suppressorRestoreRef.current = null;
        const sup = suppressorRef.current;
        suppressorRef.current = null;
        sup?.dispose().catch((err) => console.warn('[noise] dispose error:', err));
        setState(state === 'rejected' ? 'rejected' : 'ended');
      });

      await m.join();
      setRtkClient(m);
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
      setState('error');
      setErrorMsg('Failed to connect to the meeting. Please try again.');
    }
  }, [meetingInfo, previewStream, previewAudioEnabled, previewVideoEnabled, hostControls]);

  // ── Join handler ──

  const handleJoin = useCallback(async ({ name, email }: GuestJoinFormInput) => {
    setSubmitError(null);
    setGuestName(name);
    setGuestEmail(email);
    setJoining(true);

    try {
      const result = await guestJoinMeeting(orgId, { joinCode, name, email, colorSeed });

      setMeetingId(result.meetingId);
      setMeetingTitle(result.meetingTitle);

      if (result.status === 'ended') {
        setState('error');
        setErrorMsg('This meeting has already ended.');
      } else if (result.status === 'waiting') {
        setState('waiting');
        pollRef.current = setInterval(async () => {
          try {
            const retry = await guestJoinMeeting(orgId, { joinCode, name, email, colorSeed });
            if (retry.status === 'ended') {
              if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
              setState('error');
              setErrorMsg('This meeting has already ended.');
              return;
            }
            if (retry.status === 'joined' && retry.authToken && retry.sessionId) {
              if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
              setSessionId(retry.sessionId);
              await connectToRtk(retry.authToken);
            }
          } catch { /* keep polling */ }
        }, POLLING_INTERVAL_MS.waitingForSession);
      } else if (result.status === 'waitlisted' && result.waitlistId) {
        // WeldSuite-side waiting room (meeting.waitingRoom === true). The host
        // approves via the in-meeting Host Controls. We poll the dedicated
        // status endpoint; once admitted, re-call /api/meeting/join to mint
        // the actual RTK token.
        setState('waitlisted');
        const waitlistId = result.waitlistId;
        pollRef.current = setInterval(async () => {
          try {
            const status = await getGuestWaitlistStatus(orgId, result.meetingId, waitlistId);
            if (status === 'denied') {
              if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
              setState('rejected');
              return;
            }
            if (status === 'admitted') {
              const retry = await guestJoinMeeting(orgId, { joinCode, name, email, colorSeed });
              if (retry.status === 'ended') {
                if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
                setState('error');
                setErrorMsg('This meeting has already ended.');
                return;
              }
              if (retry.status === 'joined' && retry.authToken && retry.sessionId) {
                if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
                setSessionId(retry.sessionId);
                await connectToRtk(retry.authToken);
              }
            }
          } catch { /* keep polling */ }
        }, POLLING_INTERVAL_MS.waitlist);
      } else if (result.status === 'joined' && result.authToken && result.sessionId) {
        setSessionId(result.sessionId);
        await connectToRtk(result.authToken);
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to join meeting.');
      setJoining(false);
    }
  }, [orgId, joinCode, colorSeed, connectToRtk]);

  // ── Leave handler ──

  const handleLeave = useCallback(async () => {
    if (rtkClient) {
      // Stop the local hardware tracks first — RTK's leave() does not reliably
      // release the camera/mic, so the device indicator would otherwise stay on.
      stopLocalMediaTracks(rtkClient);
      try { rtkClient.leave(); } catch { /* ignore */ }
    }
    setRtkClient(null);
    try { suppressorRestoreRef.current?.(); } catch { /* ignore */ }
    suppressorRestoreRef.current = null;
    const sup = suppressorRef.current;
    suppressorRef.current = null;
    sup?.dispose().catch((err) => console.warn('[noise] dispose error:', err));

    if (meetingId && sessionId && guestEmail) {
      try {
        await guestLeaveMeeting(orgId, { meetingId, sessionId, email: guestEmail });
      } catch { /* best effort */ }
    }

    setState('ended');
  }, [rtkClient, orgId, meetingId, sessionId, guestEmail]);

  // ── Media controls (connected room) ──

  const toggleMute = useCallback(() => {
    if (!rtkClient) return;
    if (rtkClient.self.audioEnabled) {
      rtkClient.self.disableAudio();
      setIsMuted(true);
    } else {
      rtkClient.self.enableAudio();
      setIsMuted(false);
    }
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
      const self = rtkClient.self as unknown as any;
      const all = await self.getAllDevices?.();
      const videos = ((all ?? []) as any[]).filter((d) => d.kind === 'videoinput') as MediaDeviceInfo[];
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
    previewStream?.getTracks().forEach(t => t.stop());
    stopLocalMediaTracks(rtkClient);
    rtkClient?.leaveRoom();
    setState('ended');
  }, [previewStream, rtkClient]);

  // ── Render ──

  if (state === 'loading') return <LoadingScreen />;
  if (state === 'error') return <ErrorScreen message={errorMsg} />;
  if (state === 'ended') {
    return (
      <EndedScreen
        onReturnHome={() => {
          window.location.href = 'https://www.weldsuite.org/';
        }}
        onRejoin={async () => {
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
      hostControls={hostControls}
      onHostControlsBroadcast={setHostControls}
    />
  );
}
