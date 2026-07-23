/**
 * Call control bar for the WeldChat call screen.
 *
 * A React-Native port of the meeting-portal control bar
 * (@weldsuite/weldmeet-ui `CallControlsBar`): rounded-[18px] pill buttons with a
 * thin ring, a red treatment on the mic/camera when they're off, and a wide
 * destructive "leave" button with a rotated phone icon. Reads/toggles the local
 * participant's mic + camera straight off the RealtimeKit meeting via the core
 * hooks (no UI-kit controls).
 */

import React, { useCallback, useState } from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { Mic, MicOff, Video, VideoOff, SwitchCamera, Phone, Volume2 } from 'lucide-react-native';
import {
  useRealtimeKitMeeting,
  useRealtimeKitSelector,
} from '@cloudflare/realtimekit-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { getCallColors, type CallColors } from './call-theme';

/** The exact outline video-camera icon used by the web control bar (Heroicons). */
function VideoOnIcon({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.5}>
      <Path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"
      />
    </Svg>
  );
}

export function CallControls({ onLeave, callType }: { onLeave: () => void; callType?: 'voice' | 'video' }) {
  const { mode } = useTheme();
  const colors = getCallColors(mode);
  const insets = useSafeAreaInsets();
  const { meeting } = useRealtimeKitMeeting();

  const audioEnabled = useRealtimeKitSelector((m) => m.self.audioEnabled);
  const videoEnabled = useRealtimeKitSelector((m) => m.self.videoEnabled);

  // Loudspeaker toggle (WhatsApp-style): voice calls start on the earpiece,
  // video calls on the speaker. Switches the audio route by picking the
  // 'speaker' / 'earpiece' device the RN layer reports via getAudioDevices().
  const [speakerOn, setSpeakerOn] = useState(callType === 'video');

  const toggleSpeaker = useCallback(async () => {
    const next = !speakerOn;
    setSpeakerOn(next);
    try {
      const devices = await meeting.self.getAudioDevices();
      const wanted = next ? 'speaker' : 'earpiece';
      const target =
        devices.find((d) => d.deviceId === wanted) ??
        devices.find((d) => d.deviceId?.toLowerCase().includes(wanted));
      if (target) await meeting.self.setDevice(target);
    } catch {
      // Route may not be switchable until the call is connected — best effort.
    }
  }, [meeting, speakerOn]);

  const toggleAudio = useCallback(() => {
    if (audioEnabled) meeting.self.disableAudio();
    else meeting.self.enableAudio();
  }, [meeting, audioEnabled]);

  const toggleVideo = useCallback(() => {
    if (videoEnabled) meeting.self.disableVideo();
    else meeting.self.enableVideo();
  }, [meeting, videoEnabled]);

  const switchCamera = useCallback(() => {
    try {
      const track = meeting.self.videoTrack as unknown as { _switchCamera?: () => void } | undefined;
      track?._switchCamera?.();
    } catch {
      /* best effort */
    }
  }, [meeting]);

  return (
    <View style={[styles.bar, { backgroundColor: colors.background, paddingBottom: insets.bottom + 16 }]}>
      {/* Loudspeaker — highlighted (filled) while on, like WhatsApp */}
      <PillButton
        colors={colors}
        active={speakerOn}
        onPress={toggleSpeaker}
        icon={<Volume2 size={24} color={speakerOn ? colors.background : colors.secondaryForeground} />}
      />

      {/* Mic — red when muted */}
      <PillButton
        colors={colors}
        off={!audioEnabled}
        onPress={toggleAudio}
        icon={
          audioEnabled
            ? <Mic size={24} color={colors.secondaryForeground} />
            : <MicOff size={24} color={colors.offFg} />
        }
      />

      {/* Camera button.
          • voice call, camera off → neutral "turn camera on" (upgrade to video)
          • video call, camera off → red "camera off" (meeting-portal style)
          • camera on (either)   → neutral camera, taps to turn off */}
      <PillButton
        colors={colors}
        off={!videoEnabled && callType !== 'voice'}
        onPress={toggleVideo}
        icon={
          videoEnabled ? (
            <VideoOnIcon size={26} color={colors.secondaryForeground} />
          ) : callType === 'voice' ? (
            <Video size={24} color={colors.secondaryForeground} />
          ) : (
            <VideoOff size={24} color={colors.offFg} />
          )
        }
      />

      {/* Switch camera — only meaningful while the camera is on. */}
      {videoEnabled && (
        <PillButton
          colors={colors}
          off={false}
          onPress={switchCamera}
          icon={<SwitchCamera size={24} color={colors.secondaryForeground} />}
        />
      )}

      {/* Leave — wide destructive button with a rotated phone */}
      <TouchableOpacity
        style={[styles.leave, { backgroundColor: colors.destructive }]}
        activeOpacity={0.85}
        onPress={onLeave}
        accessibilityLabel="Leave call"
      >
        {/* Rotate via a wrapper View (rotates around its center) — applying the
            transform to the SVG itself rotates around its top-left origin and
            flings the icon out of the button. */}
        <View style={styles.leaveIcon}>
          <Phone size={24} color="#fff" fill="#fff" />
        </View>
      </TouchableOpacity>
    </View>
  );
}

function PillButton({
  icon,
  onPress,
  off = false,
  active = false,
  colors,
}: {
  icon: React.ReactNode;
  onPress: () => void;
  off?: boolean;
  /** Filled/highlighted state (e.g. speaker on) — inverts the button. */
  active?: boolean;
  colors: CallColors;
}) {
  const backgroundColor = active ? colors.secondaryForeground : off ? colors.offBg : colors.secondary;
  const borderColor = active ? colors.secondaryForeground : off ? colors.offRing : colors.border;
  return (
    <TouchableOpacity
      style={[styles.pill, { backgroundColor, borderColor }]}
      activeOpacity={0.85}
      onPress={onPress}
    >
      {icon}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  // flex items-center justify-center gap-3 p-4
  bar: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 13,
    paddingTop: 16,
    paddingHorizontal: 16,
  },
  // rounded pill control button
  pill: {
    width: 53,
    height: 53,
    borderRadius: 20,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  // wider destructive leave button
  leave: {
    width: 78,
    height: 53,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  leaveIcon: { transform: [{ rotate: '135deg' }] },
});
