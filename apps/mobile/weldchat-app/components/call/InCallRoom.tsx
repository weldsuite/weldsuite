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
import { Mic, MicOff, Video, VideoOff, PhoneOff, ChevronDown } from 'lucide-react-native';
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

type MeetingClient = NonNullable<ReturnType<typeof useRealtimeKitClient>[0]>;

provideRtkDesignSystem({
  theme: 'darkest',
  colors: {
    brand: generateBrandColors(BRAND),
  },
  borderRadius: 'rounded',
});

function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function JoinedCallBody({
  meeting,
  peerName,
  peerAvatar,
  callType,
  duration,
  onMinimize,
  onLeave,
}: {
  meeting: MeetingClient;
  peerName?: string;
  peerAvatar?: string;
  callType: 'voice' | 'video';
  duration: number;
  onMinimize: () => void;
  onLeave: () => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { storeStates, setStates } = useContext(RtkUIContext);

  const [audioEnabled, setAudioEnabled] = useState(!!meeting.self.audioEnabled);
  const [videoEnabled, setVideoEnabled] = useState(!!meeting.self.videoEnabled);

  useEffect(() => {
    setStates({ ...storeStates, meeting: 'joined' });
    // Only seed once when the room mounts — don't re-run on every storeStates change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting]);

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

  const toggleMute = useCallback(() => {
    if (meeting.self.audioEnabled) meeting.self.disableAudio();
    else meeting.self.enableAudio();
  }, [meeting]);

  const toggleVideo = useCallback(() => {
    if (meeting.self.videoEnabled) meeting.self.disableVideo();
    else meeting.self.enableVideo();
  }, [meeting]);

  const initial = (peerName ?? '?').trim()[0]?.toUpperCase() ?? '?';
  const isVideo = callType === 'video';

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: 8 }]}>
        <TouchableOpacity
          style={styles.headerBtn}
          onPress={onMinimize}
          hitSlop={10}
          accessibilityLabel="Minimize call"
        >
          <ChevronDown size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
            {peerName || (isVideo ? 'Video call' : 'Voice call')}
          </Text>
          <Text style={[styles.headerSubtitle, { color: colors.muted }]}>
            {formatDuration(duration)}
          </Text>
        </View>
        <View style={styles.headerBtn} />
      </View>

      <View style={styles.stage}>
        {/* Always mount the grid so remote audio/video tracks attach. For voice
            calls we overlay the branded avatar stage on top. */}
        <View style={isVideo ? styles.gridVisible : styles.gridHidden} pointerEvents={isVideo ? 'auto' : 'none'}>
          <RtkGrid meeting={meeting as never} />
        </View>
        {!isVideo && (
          <View style={styles.voiceStage}>
            {peerAvatar ? (
              <Image source={{ uri: peerAvatar }} style={styles.avatar} />
            ) : (
              <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: BRAND }]}>
                <Text style={styles.avatarText}>{initial}</Text>
              </View>
            )}
            <Text style={[styles.peerName, { color: colors.text }]} numberOfLines={1}>
              {peerName || 'On call'}
            </Text>
          </View>
        )}
      </View>

      <View style={[styles.controls, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
        <TouchableOpacity
          style={[styles.controlBtn, { backgroundColor: colors.secondary }]}
          onPress={toggleMute}
          accessibilityLabel={audioEnabled ? 'Mute' : 'Unmute'}
        >
          {audioEnabled ? (
            <Mic size={24} color={colors.text} strokeWidth={2} />
          ) : (
            <MicOff size={24} color={colors.text} strokeWidth={2} />
          )}
        </TouchableOpacity>

        {isVideo && (
          <TouchableOpacity
            style={[styles.controlBtn, { backgroundColor: colors.secondary }]}
            onPress={toggleVideo}
            accessibilityLabel={videoEnabled ? 'Turn camera off' : 'Turn camera on'}
          >
            {videoEnabled ? (
              <Video size={24} color={colors.text} strokeWidth={2} />
            ) : (
              <VideoOff size={24} color={colors.text} strokeWidth={2} />
            )}
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={[styles.controlBtn, { backgroundColor: colors.destructive }]}
          onPress={onLeave}
          accessibilityLabel="Leave call"
        >
          <PhoneOff size={24} color="#fff" strokeWidth={2} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

export function InCallRoom({
  meeting,
  peerName,
  peerAvatar,
  callType,
  duration,
  onMinimize,
  onLeave,
}: {
  meeting: MeetingClient;
  peerName?: string;
  peerAvatar?: string;
  callType: 'voice' | 'video';
  duration: number;
  onMinimize: () => void;
  onLeave: () => void;
}) {
  return (
    <RtkUIProvider>
      <JoinedCallBody
        meeting={meeting}
        peerName={peerName}
        peerAvatar={peerAvatar}
        callType={callType}
        duration={duration}
        onMinimize={onMinimize}
        onLeave={onLeave}
      />
    </RtkUIProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  headerBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: { flex: 1, alignItems: 'center', paddingHorizontal: 8 },
  headerTitle: { fontSize: 17, fontWeight: '600' },
  headerSubtitle: { fontSize: 13, marginTop: 2 },
  stage: { flex: 1, minHeight: 0, position: 'relative' },
  gridVisible: { flex: 1 },
  gridHidden: { ...StyleSheet.absoluteFillObject, opacity: 0 },
  voiceStage: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    paddingHorizontal: 32,
  },
  avatar: { width: 112, height: 112, borderRadius: 56 },
  avatarFallback: { justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: '#fff', fontSize: 44, fontWeight: '700' },
  peerName: { fontSize: 22, fontWeight: '600', textAlign: 'center' },
  controls: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 20,
    paddingTop: 16,
  },
  controlBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
