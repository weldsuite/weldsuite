/**
 * Global call host.
 *
 * Renders the active call as an app-wide overlay (NOT a route) so it survives
 * navigation — the user can minimize the call to a top bar and move between
 * chats while the WebRTC connection stays alive, exactly like WhatsApp.
 *
 * Owns the RealtimeKit client lifecycle that used to live in the `call-room`
 * route: init / join / leave, room lifecycle bridging, and releasing the local
 * camera/mic tracks. The full-screen <CallScreen> is kept mounted while
 * minimized (just hidden) so its state — and the media — don't reset when the
 * user pops back into the call.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets, SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Phone, Mic, MicOff } from 'lucide-react-native';
import {
  RealtimeKitProvider,
  useRealtimeKitClient,
} from '@cloudflare/realtimekit-react-native';
import { useCall, type CallSession } from '@/contexts/CallContext';
import { useLoopingSound } from '@/hooks/useLoopingSound';
import { CallScreen, OutgoingCallPlaceholder } from './CallScreen';

const RINGBACK = require('@/assets/sounds/ringback.wav');

/**
 * Explicitly stop the local camera/mic MediaStreamTracks held by the RTK
 * client. RealtimeKit's `leave()` does not reliably stop the underlying
 * hardware tracks in React Native, so without this the OS camera/mic indicator
 * stays lit after the user leaves the call.
 */
function stopLocalMediaTracks(meeting: ReturnType<typeof useRealtimeKitClient>[0]) {
  if (!meeting) return;
  const self = meeting.self as unknown as {
    videoTrack?: { stop?: () => void };
    audioTrack?: { stop?: () => void };
    rawVideoTrack?: { stop?: () => void };
    rawAudioTrack?: { stop?: () => void };
    screenShareTracks?: { video?: { stop?: () => void }; audio?: { stop?: () => void } };
  };
  const stop = (read: () => { stop?: () => void } | undefined) => {
    try {
      read()?.stop?.();
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

function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Height of the minimized call bar's body (below the status-bar inset). */
export const CALL_BAR_BODY_HEIGHT = 60;
/** "Very light black" backdrop of the WhatsApp ongoing-call bar. */
const CALL_BAR_BG = '#1c1c1e';
/** Rounded top corners of the app page peeking out below the bar. */
const PAGE_CORNER_RADIUS = 30;
const CALL_GREEN = '#25d366';
const HANGUP_RED = '#ff3b30';

/**
 * Wraps the app's navigator. When a call is minimized it reserves space at the
 * top for the call bar so the whole page shrinks to sit beneath it — matching
 * WhatsApp's latest behaviour (the content makes room rather than being
 * covered). Child screens see a zeroed top inset because this container already
 * clears the status bar, so they don't double-pad.
 */
export function CallInsetContainer({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const { minimized, session } = useCall();
  const showBar = minimized && !!session;
  // While minimized the container already clears the status bar, so children
  // get a zeroed top inset. Headers that want a comfortable height handle it
  // with a fixed centered content row (see ChannelView) so their content stays
  // vertically centered — a non-zero inset here would push it down on top only.
  const childInsets = useMemo(
    () => (showBar ? { ...insets, top: 0 } : insets),
    [showBar, insets],
  );
  return (
    <View
      style={[
        { flex: 1 },
        showBar && { backgroundColor: CALL_BAR_BG, paddingTop: insets.top + CALL_BAR_BODY_HEIGHT },
      ]}
    >
      {/* The page peeks out below the bar with rounded top corners; the dark
          backdrop shows through the corner curves (exactly like WhatsApp). */}
      <View
        style={[
          { flex: 1, overflow: 'hidden' },
          showBar && { borderTopLeftRadius: PAGE_CORNER_RADIUS, borderTopRightRadius: PAGE_CORNER_RADIUS },
        ]}
      >
        <SafeAreaInsetsContext.Provider value={childInsets}>
          {children}
        </SafeAreaInsetsContext.Provider>
      </View>
    </View>
  );
}

export function CallHost() {
  const { session } = useCall();
  if (!session) return null;
  // Key by callId so each call gets a fresh RealtimeKit client + clean unmount
  // cleanup (mirrors the old per-route lifecycle).
  return <ActiveCall key={session.callId} session={session} />;
}

function ActiveCall({ session }: { session: CallSession }) {
  const { minimized, minimizeCall, expandCall, leaveCall, markConnected } = useCall();
  const [meeting, initMeeting] = useRealtimeKitClient();

  const initTriggered = useRef(false);
  const leftRef = useRef(false);
  const meetingRef = useRef(meeting);
  meetingRef.current = meeting;
  const leaveCallRef = useRef(leaveCall);
  leaveCallRef.current = leaveCall;

  // ── Answered latch + duration (owned here so they survive minimize/expand) ──
  const [connected, setConnected] = useState(false);
  const connectedRef = useRef(false);
  connectedRef.current = connected;
  const [duration, setDuration] = useState(0);
  const startedAtRef = useRef(0);

  // Mic state — mirrored so the minimized bar's mute button stays in sync.
  const [audioEnabled, setAudioEnabled] = useState(true);
  useEffect(() => {
    if (!meeting) return;
    const self = meeting.self as unknown as {
      audioEnabled?: boolean;
      on?: (e: string, cb: () => void) => void;
      off?: (e: string, cb: () => void) => void;
    };
    const sync = () => setAudioEnabled(!!self.audioEnabled);
    sync();
    self.on?.('audioUpdate', sync);
    return () => self.off?.('audioUpdate', sync);
  }, [meeting]);
  const toggleMute = useCallback(() => {
    const m = meetingRef.current;
    if (!m) return;
    if (m.self.audioEnabled) m.self.disableAudio();
    else m.self.enableAudio();
  }, []);

  // Single, idempotent leave path.
  const handleLeave = useCallback(async () => {
    if (leftRef.current) return;
    leftRef.current = true;
    stopLocalMediaTracks(meetingRef.current);
    try {
      await meetingRef.current?.leave();
    } catch {
      /* best effort */
    }
    await leaveCallRef.current();
  }, []);

  // Init the RealtimeKit client once we have an auth token.
  useEffect(() => {
    if (!session.authToken || initTriggered.current) return;
    initTriggered.current = true;
    let cancelled = false;
    (async () => {
      try {
        await initMeeting({
          authToken: session.authToken,
          defaults: { audio: true, video: session.callType === 'video' },
        });
      } catch (err) {
        if (cancelled) return;
        console.error('[WeldChat:Call] initMeeting failed:', err);
        await leaveCall();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.authToken, session.callType, initMeeting, leaveCall]);

  // Bridge SFU room lifecycle into the call context.
  useEffect(() => {
    if (!meeting) return;
    const onJoined = () => markConnected();
    const onLeft = () => {
      void handleLeave();
    };
    meeting.self.on('roomJoined', onJoined);
    meeting.self.on('roomLeft', onLeft);
    return () => {
      meeting.self.off('roomJoined', onJoined);
      meeting.self.off('roomLeft', onLeft);
    };
  }, [meeting, markConnected, handleLeave]);

  // Latch "answered" once a remote participant stays present for a short beat —
  // ignores transient join/leave blips while their media connects.
  useEffect(() => {
    if (!meeting) return;
    const parts = meeting.participants as unknown as {
      joined?: { toArray?: () => unknown[] };
      on?: (e: string, cb: () => void) => void;
      off?: (e: string, cb: () => void) => void;
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const count = () => parts.joined?.toArray?.().length ?? 0;
    const evaluate = () => {
      if (connectedRef.current) return;
      if (count() > 0) {
        if (!timer) {
          timer = setTimeout(() => {
            timer = null;
            if (count() > 0) {
              startedAtRef.current = Date.now();
              setConnected(true);
            }
          }, 600);
        }
      } else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    evaluate();
    parts.on?.('participantJoined', evaluate);
    parts.on?.('participantLeft', evaluate);
    return () => {
      if (timer) clearTimeout(timer);
      parts.off?.('participantJoined', evaluate);
      parts.off?.('participantLeft', evaluate);
    };
  }, [meeting]);

  // Outgoing "calling…" ringback — plays for a direct (1:1) call we placed
  // until the other side answers (the connected latch flips).
  useLoopingSound(!!session.isDirect && !connected, RINGBACK);

  // Tick the call duration once answered.
  useEffect(() => {
    if (!connected) return;
    if (!startedAtRef.current) startedAtRef.current = Date.now();
    const id = setInterval(() => {
      setDuration(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [connected]);

  // Belt-and-suspenders: release camera/mic if we ever unmount without leaving.
  useEffect(() => {
    return () => {
      if (leftRef.current) return;
      leftRef.current = true;
      stopLocalMediaTracks(meetingRef.current);
      try {
        void meetingRef.current?.leave();
      } catch {
        /* best effort */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {/* Full-screen call — kept mounted while minimized (just hidden) so its
          state and the media stream don't reset on expand. */}
      <View
        style={[styles.overlay, minimized && styles.hidden]}
        pointerEvents={minimized ? 'none' : 'auto'}
      >
        {meeting ? (
          <RealtimeKitProvider value={meeting as never}>
            <CallScreen
              onLeave={handleLeave}
              onMinimize={minimizeCall}
              isDirect={session.isDirect}
              peerName={session.peerName}
              peerAvatar={session.peerAvatar}
              callType={session.callType}
              connected={connected}
              duration={duration}
            />
          </RealtimeKitProvider>
        ) : session.isDirect ? (
          // Direct call: show the "Calling…" screen instantly, no spinner — the
          // live CallScreen takes over seamlessly once the meeting initializes.
          <OutgoingCallPlaceholder
            peerName={session.peerName}
            peerAvatar={session.peerAvatar}
            callType={session.callType}
            onLeave={handleLeave}
            onMinimize={minimizeCall}
          />
        ) : (
          <View style={styles.connecting}>
            <ActivityIndicator size="large" color="#0095f6" />
            <Text style={styles.connectingText}>Connecting…</Text>
          </View>
        )}
      </View>

      {/* WhatsApp-style minimized top bar */}
      {minimized && (
        <MinimizedCallBar
          peerName={session.peerName}
          status={connected ? formatDuration(duration) : 'Ringing'}
          isMuted={!audioEnabled}
          onToggleMute={toggleMute}
          onExpand={expandCall}
          onLeave={handleLeave}
        />
      )}
    </>
  );
}

function MinimizedCallBar({
  peerName,
  status,
  isMuted,
  onToggleMute,
  onExpand,
  onLeave,
}: {
  peerName?: string;
  status: string;
  isMuted: boolean;
  onToggleMute: () => void;
  onExpand: () => void;
  onLeave: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingTop: insets.top }]}>
      {/* The bar's dark backdrop fills the status-bar area, so force the OS
          status-bar icons (clock, wifi, battery) to light/white — otherwise the
          default dark icons are invisible black-on-black while minimized. */}
      <StatusBar style="light" />
      <View style={styles.barRow}>
        {/* Mute toggle */}
        <TouchableOpacity style={styles.circleBtn} onPress={onToggleMute} hitSlop={6} accessibilityLabel={isMuted ? 'Unmute' : 'Mute'}>
          {isMuted ? <MicOff size={17} color="#fff" /> : <Mic size={17} color="#fff" />}
        </TouchableOpacity>

        {/* Name + status — tap to return to the call */}
        <TouchableOpacity style={styles.barCenter} onPress={onExpand} activeOpacity={0.7} accessibilityLabel="Return to call">
          <Phone size={15} color={CALL_GREEN} fill={CALL_GREEN} />
          <Text style={styles.barText} numberOfLines={1}>
            {peerName ? `${peerName} - ${status}` : status}
          </Text>
        </TouchableOpacity>

        {/* Hang up */}
        <TouchableOpacity style={styles.circleBtn} onPress={onLeave} hitSlop={6} accessibilityLabel="End call">
          <View style={styles.hangupIcon}>
            <Phone size={17} color={HANGUP_RED} fill={HANGUP_RED} />
          </View>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Sits above the navigation stack; absolute-fills the screen when shown.
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1000,
    elevation: 1000,
  },
  hidden: { display: 'none' },
  connecting: { flex: 1, backgroundColor: '#1c1d1f', justifyContent: 'center', alignItems: 'center', gap: 12 },
  connectingText: { color: '#fff', fontSize: 14, marginTop: 8 },
  // WhatsApp ongoing-call bar — "very light black", pinned to the very top.
  bar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1001,
    elevation: 1001,
    backgroundColor: CALL_BAR_BG,
  },
  barRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: CALL_BAR_BODY_HEIGHT,
    paddingHorizontal: 20,
  },
  circleBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#2c2c2e',
    justifyContent: 'center',
    alignItems: 'center',
  },
  hangupIcon: { transform: [{ rotate: '135deg' }] },
  barCenter: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 8,
  },
  barText: { color: CALL_GREEN, fontSize: 15, fontWeight: '600', flexShrink: 1 },
});
