/**
 * Participant video tile for the WeldChat call screen.
 *
 * A faithful React-Native port of the meeting-portal tile
 * (@weldsuite/weldmeet-ui `ParticipantTile`): a rounded tile that shows live
 * video (RTCView) when the camera is on, or a deterministic colored
 * "camera-off" placeholder with a rounded-square avatar when it's off. A
 * bottom-left name pill (with a MicOff affordance), a hand-raise corner badge,
 * and the green/yellow/blue state rings all mirror the web design pixel-for-
 * pixel.
 */

import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Image, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { RTCView, MediaStream, type MediaStreamTrack } from '@cloudflare/react-native-webrtc';
import { MicOff, Hand } from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { getCallColors, getPersonTheme, getInitials } from './call-theme';

/** Minimal shape we read off a RealtimeKit participant (self or remote). */
export interface CallParticipant {
  id: string;
  name?: string;
  picture?: string;
  userId?: string;
  customParticipantId?: string;
  audioEnabled?: boolean;
  videoEnabled?: boolean;
  videoTrack?: MediaStreamTrack | null;
}

interface ParticipantTileProps {
  participant: CallParticipant;
  /** Local participant — labelled "You" and (optionally) mirrored. */
  isSelf?: boolean;
  /** Mirror the video (true for the local front camera). */
  mirror?: boolean;
  /** Highlight as the active speaker (green ring — web: ring-green-500). */
  highlighted?: boolean;
  /** Show the raised-hand badge + yellow ring (web: ring-yellow-500). */
  handRaised?: boolean;
  /** Promote to the main stage — blue ring (web: ring-primary). */
  pinned?: boolean;
  /** Stable seed for the camera-off color, kept identical across clients. */
  colorSeed?: string;
  style?: object;
}

export function ParticipantTile({
  participant,
  isSelf = false,
  mirror = false,
  highlighted = false,
  handRaised = false,
  pinned = false,
  colorSeed,
  style,
}: ParticipantTileProps) {
  const { mode } = useTheme();
  const colors = getCallColors(mode);
  const { videoTrack, videoEnabled, audioEnabled, name, picture } = participant;

  const displayName = isSelf ? 'You' : name || 'Participant';
  const theme = getPersonTheme(
    colorSeed ||
      String(participant.customParticipantId ?? participant.userId ?? participant.id ?? name ?? ''),
  );
  const initials = getInitials(name || displayName);

  const [stream, setStream] = useState<MediaStream | null>(null);
  const trackIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (videoEnabled && videoTrack) {
      if (trackIdRef.current !== videoTrack.id) {
        const s = new MediaStream(undefined);
        s.addTrack(videoTrack);
        setStream(s);
        trackIdRef.current = videoTrack.id;
      }
    } else {
      trackIdRef.current = null;
      setStream(null);
    }
  }, [videoEnabled, videoTrack]);

  const showVideo = !!(videoEnabled && videoTrack && stream);

  // Avatar sizing mirrors the web's `28cqmin` clamped between 40 and 128px.
  const [tileSize, setTileSize] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setTileSize(Math.min(width, height));
  };
  const avatarSize = Math.max(40, Math.min(128, tileSize * 0.28));

  // Ring priority matches the web tile: pinned > speaking > hand-raised.
  const ringColor = pinned
    ? colors.primary
    : highlighted
      ? colors.speakingRing
      : handRaised
        ? colors.handRing
        : 'transparent';

  return (
    <View
      onLayout={onLayout}
      style={[
        styles.tile,
        {
          backgroundColor: showVideo ? colors.muted : theme.tile,
          borderWidth: ringColor === 'transparent' ? 0 : 2,
          borderColor: ringColor,
        },
        style,
      ]}
    >
      {showVideo ? (
        <RTCView
          streamURL={stream!.toURL()}
          objectFit="cover"
          mirror={mirror}
          zOrder={0}
          style={styles.video}
        />
      ) : (
        <View style={styles.avatarWrap}>
          {picture ? (
            <Image
              source={{ uri: picture }}
              style={{ width: avatarSize, height: avatarSize, borderRadius: avatarSize * 0.2 }}
            />
          ) : (
            <View
              style={[
                styles.avatarFallback,
                {
                  width: avatarSize,
                  height: avatarSize,
                  borderRadius: avatarSize * 0.2,
                  backgroundColor: theme.avatar,
                },
              ]}
            >
              <Text style={[styles.avatarText, { fontSize: Math.max(14, avatarSize * 0.36) }]}>
                {initials}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* Hand-raise corner badge (web: bg-yellow-500, top-left). */}
      {handRaised && (
        <View style={[styles.handBadge, { backgroundColor: colors.handBadge }]}>
          <Hand size={16} color="#fff" strokeWidth={2.25} />
        </View>
      )}

      {/* Name tag — bottom-left pill, mirrors ParticipantNameTag. */}
      <View style={styles.nameTag}>
        {!audioEnabled && <MicOff size={14} color="#fff" strokeWidth={2.25} />}
        <Text style={styles.nameText} numberOfLines={1}>
          {displayName}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // rounded-lg (8px), overflow hidden, centered content.
  tile: { flex: 1, borderRadius: 8, overflow: 'hidden', justifyContent: 'center', alignItems: 'center' },
  video: { flex: 1, alignSelf: 'stretch' },
  avatarWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  avatarFallback: { justifyContent: 'center', alignItems: 'center' },
  // font-mono font-medium white — like the web avatar initials.
  avatarText: { color: '#fff', fontWeight: '500', fontVariant: ['tabular-nums'] },
  // absolute bottom-2 left-2, bg-black/50, text-[13px] font-medium, px-2.5 py-1, rounded-md.
  nameTag: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    maxWidth: '85%',
  },
  nameText: { color: '#fff', fontSize: 13, fontWeight: '500' },
  // absolute top-2 left-2, rounded-lg p-1.5, shadow.
  handBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    padding: 6,
    borderRadius: 8,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
});
