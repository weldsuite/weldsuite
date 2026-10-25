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
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Keyboard, PermissionsAndroid, Platform } from 'react-native';
import { useSafeAreaInsets, SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';
import { Phone, MicOff } from 'lucide-react-native';
import {
  RealtimeKitProvider,
  useRealtimeKitClient,
} from '@cloudflare/realtimekit-react-native';
import { useCall, type CallSession, type CallType } from '@/contexts/CallContext';
import { useLoopingSound } from '@/hooks/useLoopingSound';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { BRAND } from '@/lib/brand';
import { InCallRoom } from './InCallRoom';

const RINGBACK = require('@/assets/sounds/ringback.wav');

/** How long a 1:1 call waits for the other person to come back before hanging up. */
const PEER_GONE_GRACE_MS = 10_000;

/**
 * Android grants the mic (and camera) at runtime. Ask before joining instead
 * of leaving it to the WebRTC layer: answering a ring is often the first time
 * the app touches the mic. Already granted → resolves without a prompt.
 */
async function ensureCallPermissions(callType: CallType): Promise<void> {
  if (Platform.OS !== 'android') return;
  const wanted = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
  if (callType === 'video') wanted.push(PermissionsAndroid.PERMISSIONS.CAMERA);
  try {
    await PermissionsAndroid.requestMultiple(wanted);
  } catch {
    // Join anyway: RealtimeKit then shows the mic as off.
  }
}

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

function getConnectingLabel(session: CallSession): string {
  if (!session.isDirect || session.answered) return 'Connecting…';
  const peerSuffix = session.peerName ? ` ${session.peerName}` : '';
  return `Calling${peerSuffix}…`;
}

function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function getCallStatus(
  session: CallSession,
  reconnecting: boolean,
  connected: boolean,
  duration: number,
): string {
  if (reconnecting) return 'Reconnecting…';
  if (connected) return formatDuration(duration);
  return session.answered ? 'Connecting…' : 'Ringing';
}

/** Height of the minimized call bar's body (below the status-bar inset). */
export const CALL_BAR_BODY_HEIGHT = 60;
/** Rounded top corners of the app page peeking out below the bar. */
const PAGE_CORNER_RADIUS = 16;

// WhatsApp's call bar, measured from its iOS app: a dark bar in light and dark
// mode alike, a near-black mute button, the red hang-up button and the name +
// status in green.
const CALL_BAR = {
  background: '#242625',
  button: '#101010',
  buttonRim: '#2C2E2D',
  green: '#82E382',
  red: '#D62E3F',
  icon: '#FFFFFF',
};

/**
 * Wraps the app's navigator. When a call is minimized it reserves space at the
 * top for the call bar so the whole page shrinks to sit beneath it — matching
 * WhatsApp's latest behaviour (the content makes room rather than being
 * covered). Child screens see a zeroed top inset because this container already
 * clears the status bar, so they don't double-pad.
 */
export function CallInsetContainer({ children }: Readonly<{ children: React.ReactNode }>) {
  const insets = useSafeAreaInsets();
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
        showBar && { backgroundColor: CALL_BAR.background, paddingTop: insets.top + CALL_BAR_BODY_HEIGHT },
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

function ActiveCall({ session }: Readonly<{ session: CallSession }>) {
  const { minimized, minimizeCall, expandCall, leaveCall, markConnected } = useCall();
  const [meeting, initMeeting] = useRealtimeKitClient();
  const router = useRouter();

  // The call screen covers the chat: a keyboard left up from the composer
  // would sit on top of it, when the call starts and when it is expanded.
  useEffect(() => {
    if (!minimized) Keyboard.dismiss();
  }, [minimized]);

  // The call keeps going in the bar; its chat opens underneath.
  const openChat = useCallback(() => {
    minimizeCall();
    const base = session.isDirect ? '/dm' : '/channel';
    router.navigate(`${base}/${session.channelId}` as never);
  }, [minimizeCall, router, session.isDirect, session.channelId]);

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
  const [reconnecting, setReconnecting] = useState(false);
  const reconnectingRef = useRef(false);
  reconnectingRef.current = reconnecting;

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
    if (m.self.audioEnabled) void m.self.disableAudio();
    else void m.self.enableAudio();
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
    void (async () => {
      try {
        await ensureCallPermissions(session.callType);
        if (cancelled) return;
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
    // Also fires when the SDK got back in after a dropped connection.
    const onJoined = () => {
      setReconnecting(false);
      markConnected();
    };
    const onLeft = (payload?: { state?: string }) => {
      // 'disconnected' is a dropped connection the SDK is already restoring
      // (it rejoins by itself), not a leave: stay in the call. Hanging up here
      // threw people out on a short network drop.
      if (payload?.state === 'disconnected') {
        setReconnecting(true);
        return;
      }
      void handleLeave();
    };
    meeting.self.on('roomJoined', onJoined);
    meeting.self.on('roomLeft', onLeft);
    return () => {
      meeting.self.off('roomJoined', onJoined);
      meeting.self.off('roomLeft', onLeft);
    };
  }, [meeting, markConnected, handleLeave]);

  // Latch "answered" once a remote participant stays present (for ringback, the
  // timer and the bar status). Peer events come from `participants.joined`, not
  // `participants`. Whoever was already in the room (the caller, when we
  // answered) is only listed once `roomJoined` fires, so re-check then too.
  useEffect(() => {
    if (!meeting) return;
    const joined = meeting.participants.joined as unknown as {
      toArray?: () => unknown[];
      on?: (e: string, cb: () => void) => void;
      off?: (e: string, cb: () => void) => void;
    };
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let peerGoneTimer: ReturnType<typeof setTimeout> | null = null;
    const count = () => joined.toArray?.().length ?? 0;
    const evaluate = () => {
      const present = count() > 0;
      if (!connectedRef.current) {
        if (present) {
          connectTimer ??= setTimeout(() => {
            connectTimer = null;
            if (count() > 0) {
              startedAtRef.current = Date.now();
              setConnected(true);
            }
          }, 600);
        } else if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        return;
      }
      // 1:1 call and the other person is gone: their leave does not end the
      // call server side while we are still in the room, so hang up here. The
      // grace period rides out their reconnect after a network drop.
      if (!session.isDirect) return;
      if (present) {
        if (peerGoneTimer) clearTimeout(peerGoneTimer);
        peerGoneTimer = null;
      } else {
        peerGoneTimer ??= setTimeout(() => {
          peerGoneTimer = null;
          if (count() === 0 && !reconnectingRef.current) void handleLeave();
        }, PEER_GONE_GRACE_MS);
      }
    };
    // A reconnect rebuilds the list: cleared, then everyone re-added right after.
    const onCleared = () => queueMicrotask(evaluate);
    evaluate();
    meeting.self.on('roomJoined', evaluate);
    joined.on?.('participantJoined', evaluate);
    joined.on?.('participantLeft', evaluate);
    joined.on?.('participantsCleared', onCleared);
    return () => {
      if (connectTimer) clearTimeout(connectTimer);
      if (peerGoneTimer) clearTimeout(peerGoneTimer);
      meeting.self.off('roomJoined', evaluate);
      joined.off?.('participantJoined', evaluate);
      joined.off?.('participantLeft', evaluate);
      joined.off?.('participantsCleared', onCleared);
    };
  }, [meeting, session.isDirect, handleLeave]);

  // Ringback only for the caller; an answered ring already has the caller there.
  useLoopingSound(!!session.isDirect && !session.answered && !connected, RINGBACK, { duringCall: true });

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
  const callStatus = getCallStatus(session, reconnecting, connected, duration);

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
              isDirect={session.isDirect}
              callType={session.callType}
              status={callStatus}
              onMinimize={minimizeCall}
              onOpenChat={openChat}
              onLeave={handleLeave}
            />
          </RealtimeKitProvider>
        ) : (
          <View style={[styles.connecting, { backgroundColor: colors.background }]}>
            <ActivityIndicator size="large" color={BRAND} />
            <Text style={[styles.connectingText, { color: colors.text }]}>
              {getConnectingLabel(session)}
            </Text>
          </View>
        )}
      </View>

      {minimized && (
        <MinimizedCallBar
          peerName={session.peerName}
          status={callStatus}
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
}: Readonly<{
  peerName?: string;
  status: string;
  isMuted: boolean;
  onToggleMute: () => void;
  onExpand: () => void;
  onLeave: () => void;
}>) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingTop: insets.top }]}>
      {/* Light status bar text on the dark bar, until the bar goes. */}
      <StatusBar style="light" />
      <View style={styles.barRow}>
        {/* Muted: the button turns white, as in WhatsApp. */}
        <TouchableOpacity
          style={[styles.circleBtn, styles.muteBtn, isMuted && styles.muteBtnOn]}
          onPress={onToggleMute}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={isMuted ? 'Unmute' : 'Mute'}
          accessibilityState={{ selected: isMuted }}
        >
          <MicOff size={20} color={isMuted ? CALL_BAR.button : CALL_BAR.icon} strokeWidth={2} />
        </TouchableOpacity>

        <TouchableOpacity style={styles.barCenter} onPress={onExpand} activeOpacity={0.7} accessibilityLabel="Return to call">
          <Phone size={15} color={CALL_BAR.green} fill={CALL_BAR.green} />
          <Text style={styles.barText} numberOfLines={1}>
            {peerName ? `${peerName} - ${status}` : status}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.circleBtn, styles.hangupBtn]}
          onPress={onLeave}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="End call"
        >
          <View style={styles.hangupIcon}>
            <Phone size={18} color={CALL_BAR.icon} fill={CALL_BAR.icon} />
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
    backgroundColor: CALL_BAR.background,
  },
  // The buttons sit a little above the middle of the bar, as in WhatsApp.
  barRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: CALL_BAR_BODY_HEIGHT - 4,
    paddingHorizontal: 16,
  },
  circleBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  muteBtn: {
    backgroundColor: CALL_BAR.button,
    borderWidth: 1,
    borderColor: CALL_BAR.buttonRim,
  },
  muteBtnOn: { backgroundColor: CALL_BAR.icon, borderColor: CALL_BAR.icon },
  hangupBtn: { backgroundColor: CALL_BAR.red },
  // The handset lies flat, receiver ends down.
  hangupIcon: { transform: [{ rotate: '135deg' }] },
  barCenter: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 8,
  },
  barText: { fontSize: 15, fontWeight: '600', color: CALL_BAR.green, flexShrink: 1 },
});
