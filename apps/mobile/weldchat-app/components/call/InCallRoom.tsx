/**
 * WeldChat in-call surface (mobile).
 *
 * Uses RealtimeKit's participant grid for media, but wraps it in WeldChat chrome
 * (brand colors, IncomingCallModal-style control bar) instead of the stock
 * `RtkMeeting` shell.
 */

import React, { useContext, useEffect, useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronDown, Hash, MessageCircle } from 'lucide-react-native';
import {
  RtkUIProvider,
  RtkUIContext,
  RtkGrid,
  provideRtkDesignSystem,
  generateBrandColors,
} from '@cloudflare/realtimekit-react-native-ui';
import type { useRealtimeKitClient } from '@cloudflare/realtimekit-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { BRAND } from '@/lib/brand';
import { useI18n } from '@/lib/i18n';
import { addCallActionListener } from '@/modules/weldchat-calls';
import { CallControls } from './CallControls';

type MeetingClient = NonNullable<ReturnType<typeof useRealtimeKitClient>[0]>;

provideRtkDesignSystem({
  theme: 'darkest',
  colors: {
    brand: generateBrandColors(BRAND),
  },
  borderRadius: 'rounded',
});

function JoinedCallBody({
  meeting,
  peerName,
  peerAvatar,
  isDirect,
  callType,
  status,
  onMinimize,
  onOpenChat,
  onLeave,
}: Readonly<{
  meeting: MeetingClient;
  peerName?: string;
  peerAvatar?: string;
  /** 1:1 call: the avatar is the person; otherwise the channel's #. */
  isDirect?: boolean;
  callType: 'voice' | 'video';
  /** Header subtitle: the running timer, or Ringing / Connecting / Reconnecting. */
  status: string;
  onMinimize: () => void;
  /** Shrink the call to the bar and open its chat. */
  onOpenChat: () => void;
  onLeave: () => void;
}>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();

  const [audioEnabled, setAudioEnabled] = useState(!!meeting.self.audioEnabled);
  const [videoEnabled, setVideoEnabled] = useState(!!meeting.self.videoEnabled);

  useEffect(() => {
    const self = meeting.self as unknown as {
      audioEnabled?: boolean;
      videoEnabled?: boolean;
      on?: (e: string, cb: () => void) => void;
      off?: (e: string, cb: () => void) => void;
    };
    const syncAudio = () => setAudioEnabled(!!self.audioEnabled);
    const syncVideo = () => setVideoEnabled(!!self.videoEnabled);
    syncAudio();
    syncVideo();
    self.on?.('audioUpdate', syncAudio);
    self.on?.('videoUpdate', syncVideo);
    return () => {
      self.off?.('audioUpdate', syncAudio);
      self.off?.('videoUpdate', syncVideo);
    };
  }, [meeting]);

  // The mute button on the iOS call screen (CallKit, e.g. on the lock screen).
  useEffect(
    () =>
      addCallActionListener((event) => {
        if (event.action !== 'mute') return;
        if (event.payload.muted === 'true') void meeting.self.disableAudio();
        else void meeting.self.enableAudio();
      }),
    [meeting],
  );

  const toggleMute = useCallback(() => {
    if (meeting.self.audioEnabled) void meeting.self.disableAudio();
    else void meeting.self.enableAudio();
  }, [meeting]);

  const toggleVideo = useCallback(() => {
    if (meeting.self.videoEnabled) void meeting.self.disableVideo();
    else void meeting.self.enableVideo();
  }, [meeting]);

  // Front ↔ back camera: switch to the other video input.
  const flipCamera = useCallback(async () => {
    const me = meeting.self as unknown as {
      getAllDevices: () => Promise<{ kind: string; deviceId: string }[]>;
      getCurrentDevices: () => { video?: { deviceId: string } };
      setDevice: (device: unknown) => Promise<void>;
    };
    try {
      const cameras = (await me.getAllDevices()).filter((d) => d.kind === 'videoinput');
      const current = me.getCurrentDevices().video?.deviceId;
      const next = cameras.find((d) => d.deviceId !== current);
      if (next) await me.setDevice(next);
    } catch {
      // No second camera, or the switch failed: stay on the current one.
    }
  }, [meeting]);

  const isVideo = callType === 'video';
  const title = peerName || (isVideo ? t.inCall.videoCall : t.inCall.voiceCall);
  const initial = peerName?.trim()[0]?.toUpperCase();

  let avatar: React.ReactNode;
  if (peerAvatar) {
    avatar = <Image source={{ uri: peerAvatar }} style={styles.avatar} />;
  } else {
    avatar = (
      <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: BRAND }]}>
        {isDirect && initial ? (
          <Text style={styles.avatarText}>{initial}</Text>
        ) : (
          <Hash size={64} color="#fff" strokeWidth={2.2} />
        )}
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* As in WhatsApp: minimize top left, the chat top right, then who
          you're calling, large, with the ringing state or the call's length. */}
      <View style={[styles.header, { paddingTop: insets.top + 4 }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity
            style={[styles.headerBtn, { backgroundColor: colors.secondary }]}
            onPress={onMinimize}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t.inCall.minimize}
          >
            <ChevronDown size={22} color={colors.text} strokeWidth={2.2} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.headerBtn, { backgroundColor: colors.secondary }]}
            onPress={onOpenChat}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t.inCall.backToChat}
          >
            <MessageCircle size={20} color={colors.text} strokeWidth={2.1} />
          </TouchableOpacity>
        </View>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[styles.status, { color: colors.mutedForeground }]} numberOfLines={1}>
          {status}
        </Text>
      </View>

      <CallStage meeting={meeting} isVideo={isVideo} background={colors.background}>
        {!isVideo && <View style={styles.voiceStage}>{avatar}</View>}
      </CallStage>

      {/* WeldMeet's control bar: mic, camera, More and leave. */}
      <CallControls
        audioEnabled={audioEnabled}
        videoEnabled={videoEnabled}
        showCamera={isVideo}
        onToggleMic={toggleMute}
        onToggleCamera={toggleVideo}
        onFlipCamera={() => void flipCamera()}
        onBackToChat={onOpenChat}
        onLeave={onLeave}
      />
    </View>
  );
}

export function InCallRoom({
  meeting,
  peerName,
  peerAvatar,
  isDirect,
  callType,
  status,
  onMinimize,
  onOpenChat,
  onLeave,
}: Readonly<{
  meeting: MeetingClient;
  peerName?: string;
  peerAvatar?: string;
  isDirect?: boolean;
  callType: 'voice' | 'video';
  /** Header subtitle: the running timer, or Ringing / Connecting / Reconnecting. */
  status: string;
  onMinimize: () => void;
  onOpenChat: () => void;
  onLeave: () => void;
}>) {
  return (
    <JoinedCallBody
      meeting={meeting}
      peerName={peerName}
      peerAvatar={peerAvatar}
      isDirect={isDirect}
      callType={callType}
      status={status}
      onMinimize={onMinimize}
      onOpenChat={onOpenChat}
      onLeave={onLeave}
    />
  );
}

/**
 * The stage between the header and the controls. RealtimeKit's UI provider
 * renders a dark SafeAreaView, which padded the status bar and home-indicator
 * areas in its own dark colour when it wrapped the whole screen. Kept to the
 * stage (away from the screen edges) under a cover in the theme colour, it
 * only supplies the grid's context.
 */
function CallStage({
  meeting,
  isVideo,
  background,
  children,
}: Readonly<{ meeting: MeetingClient; isVideo: boolean; background: string; children: React.ReactNode }>) {
  return (
    <View style={styles.stage}>
      <RtkUIProvider>
        <StageContent meeting={meeting} isVideo={isVideo} background={background}>
          {children}
        </StageContent>
      </RtkUIProvider>
    </View>
  );
}

function StageContent({
  meeting,
  isVideo,
  background,
  children,
}: Readonly<{ meeting: MeetingClient; isVideo: boolean; background: string; children: React.ReactNode }>) {
  const { storeStates, setStates } = useContext(RtkUIContext);

  useEffect(() => {
    setStates({ ...storeStates, meeting: 'joined' });
    // Only seed once when the room mounts — don't re-run on every storeStates change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting]);

  return (
    <View style={[styles.stageCover, { backgroundColor: background }]}>
      {/* Always mount the grid so remote audio/video tracks attach. For voice
          calls we overlay the branded avatar stage on top. */}
      <View style={isVideo ? styles.gridVisible : styles.gridHidden} pointerEvents={isVideo ? 'auto' : 'none'}>
        <RtkGrid meeting={meeting as never} />
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { alignItems: 'center', paddingHorizontal: 24, paddingBottom: 8 },
  headerRow: { alignSelf: 'stretch', flexDirection: 'row', justifyContent: 'space-between', marginHorizontal: -8 },
  headerBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '700', textAlign: 'center', marginTop: 10 },
  status: { fontSize: 17, lineHeight: 22, textAlign: 'center', marginTop: 4 },
  stage: { flex: 1, minHeight: 0, position: 'relative' },
  stageCover: { flex: 1, position: 'relative' },
  gridVisible: { flex: 1 },
  gridHidden: { ...StyleSheet.absoluteFill, opacity: 0 },
  // The avatar sits a little above the middle of the stage.
  voiceStage: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 48,
  },
  avatar: { width: 156, height: 156, borderRadius: 78 },
  avatarFallback: { justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: '#fff', fontSize: 64, fontWeight: '600' },
});
