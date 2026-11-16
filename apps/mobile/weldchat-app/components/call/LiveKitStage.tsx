/**
 * The call stage on LiveKit, the Kubernetes editions' video provider
 * (ADR CHAT-008).
 *
 * RealtimeKit's `RtkGrid` only draws RealtimeKit's own client, so on LiveKit
 * the cameras are drawn here, with the video view of the WebRTC this binary
 * already ships (`@cloudflare/react-native-webrtc`). Remote audio plays
 * without a view.
 *
 * Video call: the others fill the stage (in a grid when there are more than
 * one), your own camera sits in the corner, and fills the stage until someone
 * joins. Voice call: nothing to draw but `children` (the caller's avatar).
 */

import React, { useEffect, useReducer, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { MediaStream, RTCView } from '@cloudflare/react-native-webrtc';
import { BRAND } from '@/lib/brand';
import type { MeetingClient } from '@/lib/calls/types';

/** The part of a participant the stage reads (the LiveKit client's `LiveKitPeer`). */
interface StagePeer {
  id: string;
  name: string;
  picture?: string;
  videoEnabled: boolean;
  videoTrack: MediaStreamTrack | null;
}

interface StageEmitter {
  on(event: string, handler: () => void): unknown;
  off(event: string, handler: () => void): unknown;
}

interface StageMeeting {
  self: StageEmitter & { videoEnabled: boolean; videoTrack: MediaStreamTrack | null };
  participants: { joined: StageEmitter & { toArray(): StagePeer[] } };
}

const SELF_EVENTS = ['roomJoined', 'videoUpdate', 'deviceUpdate'];
const PEER_EVENTS = ['participantJoined', 'participantLeft', 'participantsCleared', 'videoUpdate'];

/** Re-render whenever who is here, or whose camera is on, changes. */
function useStageUpdates(meeting: StageMeeting): void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const { self } = meeting;
    const { joined } = meeting.participants;
    for (const event of SELF_EVENTS) self.on(event, bump);
    for (const event of PEER_EVENTS) joined.on(event, bump);
    return () => {
      for (const event of SELF_EVENTS) self.off(event, bump);
      for (const event of PEER_EVENTS) joined.off(event, bump);
    };
  }, [meeting]);
}

/** A camera track in a native video view. */
function TrackView({
  track,
  mirror,
  zOrder,
}: Readonly<{ track: MediaStreamTrack; mirror?: boolean; zOrder?: number }>) {
  const [streamURL, setStreamURL] = useState<string>();
  useEffect(() => {
    // The view plays a stream, so wrap the track in one of its own; releasing
    // it leaves the track running (LiveKit owns that).
    const stream = new MediaStream([track as never]);
    setStreamURL(stream.toURL());
    return () => {
      setStreamURL(undefined);
      stream.release(false);
    };
  }, [track]);
  if (!streamURL) return null;
  return (
    <RTCView streamURL={streamURL} objectFit="cover" mirror={mirror} zOrder={zOrder} style={StyleSheet.absoluteFill} />
  );
}

/** Mirror the front camera (what people expect of their own picture), not the back one. */
function isFrontCamera(track: MediaStreamTrack): boolean {
  try {
    return (track.getSettings?.() as { facingMode?: string } | undefined)?.facingMode !== 'environment';
  } catch {
    return true;
  }
}

function PeerTile({ peer }: Readonly<{ peer: StagePeer }>) {
  const showVideo = peer.videoEnabled && !!peer.videoTrack;
  const initial = peer.name.trim()[0]?.toUpperCase() ?? '?';
  return (
    <View style={styles.tile} accessibilityLabel={peer.name}>
      {showVideo ? (
        <TrackView track={peer.videoTrack as MediaStreamTrack} />
      ) : (
        <View style={styles.tileAvatarWrap}>
          {peer.picture ? (
            <Image source={{ uri: peer.picture }} style={styles.tileAvatar} />
          ) : (
            <View style={[styles.tileAvatar, styles.tileAvatarFallback]}>
              <Text style={styles.tileInitial}>{initial}</Text>
            </View>
          )}
        </View>
      )}
      <Text style={styles.tileName} numberOfLines={1}>
        {peer.name}
      </Text>
    </View>
  );
}

export function LiveKitStage({
  meeting,
  isVideo,
  background,
  children,
}: Readonly<{ meeting: MeetingClient; isVideo: boolean; background: string; children: React.ReactNode }>) {
  const stage = meeting as unknown as StageMeeting;
  useStageUpdates(stage);

  if (!isVideo) {
    return <View style={[styles.cover, { backgroundColor: background }]}>{children}</View>;
  }

  const peers = stage.participants.joined.toArray();
  const selfTrack = stage.self.videoEnabled ? stage.self.videoTrack : null;
  const columns = peers.length <= 2 ? 1 : 2;
  const tileWidth = `${100 / columns}%` as const;
  const tileHeight = `${100 / Math.ceil(peers.length / columns)}%` as const;

  return (
    <View style={[styles.cover, { backgroundColor: background }]}>
      {peers.length === 0 ? (
        selfTrack && <TrackView track={selfTrack} mirror={isFrontCamera(selfTrack)} />
      ) : (
        <>
          <View style={styles.grid}>
            {peers.map((peer) => (
              <View key={peer.id} style={{ width: tileWidth, height: tileHeight }}>
                <PeerTile peer={peer} />
              </View>
            ))}
          </View>
          {selfTrack && (
            <View style={styles.selfView}>
              <TrackView track={selfTrack} mirror={isFrontCamera(selfTrack)} zOrder={1} />
            </View>
          )}
        </>
      )}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { flex: 1, position: 'relative' },
  grid: { flex: 1, flexDirection: 'row', flexWrap: 'wrap' },
  tile: { flex: 1, margin: 2, borderRadius: 12, overflow: 'hidden', backgroundColor: '#1F2023' },
  tileAvatarWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tileAvatar: { width: 88, height: 88, borderRadius: 44 },
  tileAvatarFallback: { backgroundColor: BRAND, alignItems: 'center', justifyContent: 'center' },
  tileInitial: { color: '#fff', fontSize: 36, fontWeight: '600' },
  tileName: {
    position: 'absolute',
    left: 10,
    bottom: 8,
    right: 10,
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 4,
  },
  // Your own camera, in the corner, as in WhatsApp.
  selfView: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 104,
    height: 156,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
});
