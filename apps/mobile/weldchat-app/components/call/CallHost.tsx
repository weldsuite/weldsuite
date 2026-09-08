/**
 * Global call host.
 *
 * Renders the active call as an app-wide overlay (NOT a route) so it survives
 * navigation — the user can minimize the call to a top bar and move between
 * chats while the WebRTC connection stays alive, exactly like WhatsApp.
 *
 * In-call UI is WeldChat's branded `InCallRoom` (RealtimeKit grid + custom
 * chrome). This host owns init / join / leave, room lifecycle bridging, the
 * minimize bar, and releasing local camera/mic tracks.
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
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { BRAND } from '@/lib/brand';
import { InCallRoom } from './InCallRoom';

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
/** Rounded top corners of the app page peeking out below the bar. */
const PAGE_CORNER_RADIUS = 30;

/**
 * Wraps the app's navigator. When a call is minimized it reserves space at the
 * top for the call bar so the whole page shrinks to sit beneath it — matching
 * WhatsApp's latest behaviour (the content makes room rather than being
 * covered). Child screens see a zeroed top inset because this container already
 * clears the status bar, so they don't double-pad.
 */
export function CallInsetContainer({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { minimized, session } = useCall();
  const showBar = minimized && !!session;
  const childInsets = useMemo(
    () => (showBar ? { ...insets, top: 0 } : insets),
    [showBar, insets],
  );
  return (
    <View
      style={[
        { flex: 1 },
        showBar && { backgroundColor: colors.card, paddingTop: insets.top + CALL_BAR_BODY_HEIGHT },
      ]}
    >
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

  const [connected, setConnected] = useState(false);
  const connectedRef = useRef(false);
  connectedRef.current = connected;
  const [duration, setDuration] = useState(0);
  const startedAtRef = useRef(0);

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

  // Latch "answered" once a remote participant stays present (for ringback + bar status).
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

  useLoopingSound(!!session.isDirect && !connected, RINGBACK);

  useEffect(() => {
    if (!connected) return;
    if (!startedAtRef.current) startedAtRef.current = Date.now();
    const id = setInterval(() => {
      setDuration(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [connected]);

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
  }, []);

  const { colors } = useTheme();

  return (
    <>
      <View
        style={[styles.overlay, minimized && styles.hidden, { backgroundColor: colors.background }]}
        pointerEvents={minimized ? 'none' : 'auto'}
      >
        {meeting ? (
          <RealtimeKitProvider value={meeting as never}>
            <InCallRoom
              meeting={meeting}
              peerName={session.peerName}
              peerAvatar={session.peerAvatar ?? undefined}
              callType={session.callType}
              duration={duration}
              onMinimize={minimizeCall}
              onLeave={handleLeave}
            />
          </RealtimeKitProvider>
        ) : (
          <View style={[styles.connecting, { backgroundColor: colors.background }]}>
            <ActivityIndicator size="large" color={BRAND} />
            <Text style={[styles.connectingText, { color: colors.text }]}>
              {session.isDirect
                ? `Calling${session.peerName ? ` ${session.peerName}` : ''}…`
                : 'Connecting…'}
            </Text>
          </View>
        )}
      </View>

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
  const { colors } = useTheme();
  return (
    <View style={[styles.bar, { paddingTop: insets.top, backgroundColor: colors.card }]}>
      <StatusBar style="auto" />
      <View style={styles.barRow}>
        <TouchableOpacity
          style={[styles.circleBtn, { backgroundColor: colors.secondary }]}
          onPress={onToggleMute}
          hitSlop={6}
          accessibilityLabel={isMuted ? 'Unmute' : 'Mute'}
        >
          {isMuted ? <MicOff size={17} color={colors.text} /> : <Mic size={17} color={colors.text} />}
        </TouchableOpacity>

        <TouchableOpacity style={styles.barCenter} onPress={onExpand} activeOpacity={0.7} accessibilityLabel="Return to call">
          <Phone size={15} color={BRAND} fill={BRAND} />
          <Text style={[styles.barText, { color: BRAND }]} numberOfLines={1}>
            {peerName ? `${peerName} - ${status}` : status}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.circleBtn, { backgroundColor: colors.secondary }]}
          onPress={onLeave}
          hitSlop={6}
          accessibilityLabel="End call"
        >
          <View style={styles.hangupIcon}>
            <Phone size={17} color={colors.destructive} fill={colors.destructive} />
          </View>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
  connecting: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  connectingText: { fontSize: 14, marginTop: 8 },
  bar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1001,
    elevation: 1001,
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
  barText: { fontSize: 15, fontWeight: '600', flexShrink: 1 },
});
