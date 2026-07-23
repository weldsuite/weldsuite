/**
 * WeldChat call screen — a faithful React-Native port of the meeting-portal
 * in-call design (apps/web/meeting-portal → @weldsuite/weldmeet-ui
 * `MeetingRoomView`).
 *
 * Layout mirrors the web meeting room: a `MeetingHeader`-style bar (title on the
 * left, duration + people count on the right, bottom border), a
 * `renderMobileGrid` participant grid (1–4 tiles stack in one column; 5–8 use
 * two columns; beyond 8 the last tile carries an "N others" badge), and the
 * `CallControlsBar`-style control row.
 *
 * Built entirely on the RealtimeKit *core* hooks (useRealtimeKitMeeting /
 * useRealtimeKitSelector) + react-native-webrtc — NO RealtimeKit UI-kit
 * components. Must be rendered inside a <RealtimeKitProvider> (see
 * call-room.tsx).
 */

import React, { useEffect, useReducer } from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronDown, Users, UserPlus, Phone, Volume2, Mic, Video } from 'lucide-react-native';
import {
  useRealtimeKitMeeting,
  useRealtimeKitSelector,
} from '@cloudflare/realtimekit-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { getCallColors, getPersonTheme, getInitials } from './call-theme';
import { ParticipantTile, type CallParticipant } from './ParticipantTile';
import { CallControls } from './CallControls';

interface CallScreenProps {
  onLeave: () => void;
  onMinimize?: () => void;
  /** Direct (1:1) call → show the WhatsApp-style "calling…" screen while ringing. */
  isDirect?: boolean;
  /** Callee display name / avatar for the outgoing-call screen. */
  peerName?: string;
  peerAvatar?: string | null;
  callType?: 'voice' | 'video';
  /** "Add people to the call" action (top-right of the calling screen). */
  onAddPeople?: () => void;
  /** Whether the call has been answered. Owned by the host so it survives the
   *  call being minimized/expanded (which remounts this screen). */
  connected: boolean;
  /** Elapsed seconds since the call was answered. Owned by the host. */
  duration: number;
}

const MOBILE_MAX_TILES = 8;

function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function CallScreen({ onLeave, onMinimize, isDirect, peerName, peerAvatar, callType, onAddPeople, connected, duration }: CallScreenProps) {
  const { mode } = useTheme();
  const colors = getCallColors(mode);
  const insets = useSafeAreaInsets();
  const { meeting } = useRealtimeKitMeeting();

  // Re-render whenever participants or their media state change. The participant
  // objects are mutable, so we bump a tick on each relevant event and re-read
  // them fresh on render.
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const onAny = () => force();
    type Emitter = { on: (e: string, cb: () => void) => void; off: (e: string, cb: () => void) => void };
    const participants = meeting.participants as unknown as Emitter;
    const self = meeting.self as unknown as Emitter;
    const pEvents = ['participantJoined', 'participantLeft', 'videoUpdate', 'audioUpdate', 'activeSpeaker', 'pinned', 'screenShareUpdate'];
    const sEvents = ['videoUpdate', 'audioUpdate'];
    pEvents.forEach((e) => participants.on(e, onAny));
    sEvents.forEach((e) => self.on(e, onAny));
    return () => {
      pEvents.forEach((e) => participants.off(e, onAny));
      sEvents.forEach((e) => self.off(e, onAny));
    };
  }, [meeting]);

  const selfVideo = useRealtimeKitSelector((m) => m.self.videoEnabled);
  const remote = meeting.participants.joined.toArray() as unknown as CallParticipant[];
  const self = meeting.self as unknown as CallParticipant;
  const activeSpeakerId = (meeting.participants as unknown as { lastActiveSpeaker?: string }).lastActiveSpeaker;

  // The WhatsApp-style avatar screen is used for a direct call while ringing
  // (always) and, once answered, whenever there's no video to show. The moment
  // anyone's camera is on — including the local user upgrading a voice call via
  // the camera button — we switch to the participant grid so the video appears.
  const remoteVideo = remote.some((p) => p.videoEnabled && !!p.videoTrack);
  const anyVideo = selfVideo || remoteVideo;
  const showCallingScreen = !!isDirect && (!connected || !anyVideo);

  // self first, then remotes — matches the web `[self, ...joined]` ordering.
  const all = [self, ...remote];
  const participantCount = all.length;
  const title =
    remote.length === 1
      ? remote[0]?.name ?? 'Call'
      : remote.length === 0
        ? 'Waiting for others…'
        : `${participantCount} people`;

  // ── Mobile grid (mirrors MeetingRoomView.renderMobileGrid) ──────────────────
  const overflow = all.length - MOBILE_MAX_TILES;
  const shown = overflow > 0 ? all.slice(0, MOBILE_MAX_TILES) : all;
  const twoCols = shown.length > 4;

  const renderTile = (p: CallParticipant, badge: number | null) => (
    <View style={styles.cell}>
      <ParticipantTile
        participant={p}
        isSelf={p.id === self.id}
        mirror={p.id === self.id ? selfVideo : false}
        highlighted={activeSpeakerId === p.id}
        style={styles.fill}
      />
      {badge !== null && (
        <View style={styles.overflowBadge}>
          <Text style={styles.overflowText}>
            {badge} {badge === 1 ? 'other' : 'others'}
          </Text>
        </View>
      )}
    </View>
  );

  let grid: React.ReactNode;
  if (!twoCols) {
    // 1–4 tiles → single stacked column, equal heights.
    grid = (
      <View style={styles.gridColumn}>
        {shown.map((p, i) => {
          const badge = overflow > 0 && i === shown.length - 1 ? overflow : null;
          return <React.Fragment key={p.id}>{renderTile(p, badge)}</React.Fragment>;
        })}
      </View>
    );
  } else {
    // 5–8 tiles → two columns, equal rows. Pad an odd final row so the last
    // tile stays half-width (matching CSS grid-cols-2 auto-rows-fr).
    const rows: CallParticipant[][] = [];
    for (let i = 0; i < shown.length; i += 2) rows.push(shown.slice(i, i + 2));
    grid = (
      <View style={styles.gridColumn}>
        {rows.map((row, ri) => (
          <View key={ri} style={styles.gridRow}>
            {row.map((p, ci) => {
              const idx = ri * 2 + ci;
              const badge = overflow > 0 && idx === shown.length - 1 ? overflow : null;
              return <React.Fragment key={p.id}>{renderTile(p, badge)}</React.Fragment>;
            })}
            {row.length === 1 && <View style={styles.cell} />}
          </View>
        ))}
      </View>
    );
  }

  // ── WhatsApp-style call screen ──────────────────────────────────────────────
  // Direct call: avatar centered, name + status in the top bar. Shows while
  // ringing ("Calling…") and for the whole of an answered voice call (the live
  // duration). See `showCallingScreen` above for exactly when it's used.
  if (showCallingScreen) {
    const displayName = peerName || 'Unknown';
    const theme = getPersonTheme(peerName || '');
    const callingStatus = connected ? formatDuration(duration) : 'Calling…';
    // On a video call, show the live self-camera preview full-bleed behind the
    // calling UI (like WhatsApp/FaceTime) the moment the local camera is on — so
    // the user sees themselves while the call rings, instead of just an avatar.
    const showSelfPreview = callType === 'video' && selfVideo;
    const headerFg = showSelfPreview ? '#fff' : colors.foreground;
    const headerSub = showSelfPreview ? 'rgba(255,255,255,0.85)' : colors.mutedForeground;
    return (
      <View style={[styles.root, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        {/* Live self-camera preview, behind everything else. */}
        {showSelfPreview && (
          <ParticipantTile
            participant={self}
            isSelf
            mirror
            style={[StyleSheet.absoluteFill, styles.selfPreview]}
          />
        )}

        {/* WhatsApp-style top bar: minimize · name+status · add people. A dark
            scrim sits behind it over the live preview so the text stays legible. */}
        <View style={[styles.callingHeader, showSelfPreview && styles.callingHeaderScrim]}>
          <TouchableOpacity style={styles.callingHeaderBtn} hitSlop={10} onPress={onMinimize} accessibilityLabel="Minimize call">
            <ChevronDown size={26} color={headerFg} />
          </TouchableOpacity>
          <View style={styles.callingHeaderCenter}>
            <Text style={[styles.callingHeaderName, { color: headerFg }]} numberOfLines={1}>
              {displayName}
            </Text>
            <Text style={[styles.callingHeaderStatus, { color: headerSub }]} numberOfLines={1}>
              {callingStatus}
            </Text>
          </View>
          <TouchableOpacity style={styles.callingHeaderBtn} hitSlop={10} onPress={onAddPeople} accessibilityLabel="Add people to the call">
            <UserPlus size={24} color={headerFg} />
          </TouchableOpacity>
        </View>

        {/* Body: the live preview fills the screen, so just hold the space and
            keep the controls pinned to the bottom. With no camera (voice call or
            camera off) fall back to the centered peer avatar. */}
        {showSelfPreview ? (
          <View style={styles.callingBody} />
        ) : (
          <View style={styles.callingBody}>
            {peerAvatar ? (
              <Image source={{ uri: peerAvatar }} style={styles.callingAvatar} />
            ) : (
              <View style={[styles.callingAvatar, styles.callingAvatarFallback, { backgroundColor: theme.avatar }]}>
                <Text style={styles.callingAvatarText}>{getInitials(peerName || '?')}</Text>
              </View>
            )}
          </View>
        )}

        <CallControls onLeave={onLeave} callType={callType} />
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header — mirrors MeetingHeader */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View style={styles.headerLeft}>
          {onMinimize && (
            <TouchableOpacity style={styles.minimizeBtn} hitSlop={12} onPress={onMinimize}>
              <ChevronDown size={22} color={colors.foreground} />
            </TouchableOpacity>
          )}
          <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
            {title}
          </Text>
        </View>
        <View style={styles.headerRight}>
          <Text style={[styles.duration, { color: colors.mutedForeground }]}>{formatDuration(duration)}</Text>
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <View style={styles.peopleBtn}>
            <Users size={16} color={colors.mutedForeground} />
            <Text style={[styles.peopleCount, { color: colors.mutedForeground }]}>{participantCount}</Text>
          </View>
        </View>
      </View>

      {/* Stage */}
      <View style={styles.stage}>{grid}</View>

      {/* Controls */}
      <CallControls onLeave={onLeave} callType={callType} />
    </View>
  );
}

/**
 * Instant "Calling…" screen shown for a direct (1:1) call the moment it's
 * placed — before the RealtimeKit client has finished initializing. Visually
 * identical to <CallScreen>'s calling state (same header + centered avatar) so
 * the swap to the live screen is seamless and the user never sees a spinner.
 * Only renders a hang-up button; the full mic/speaker controls need the live
 * meeting and appear once <CallScreen> takes over.
 */
export function OutgoingCallPlaceholder({
  peerName,
  peerAvatar,
  callType,
  onLeave,
  onMinimize,
}: {
  peerName?: string;
  peerAvatar?: string | null;
  callType?: 'voice' | 'video';
  onLeave: () => void;
  onMinimize?: () => void;
}) {
  const { mode } = useTheme();
  const colors = getCallColors(mode);
  const insets = useSafeAreaInsets();
  const displayName = peerName || 'Unknown';
  const theme = getPersonTheme(peerName || '');
  const speakerOn = callType === 'video';
  return (
    <View style={[styles.root, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={styles.callingHeader}>
        <TouchableOpacity style={styles.callingHeaderBtn} hitSlop={10} onPress={onMinimize} accessibilityLabel="Minimize call">
          <ChevronDown size={26} color={colors.foreground} />
        </TouchableOpacity>
        <View style={styles.callingHeaderCenter}>
          <Text style={[styles.callingHeaderName, { color: colors.foreground }]} numberOfLines={1}>
            {displayName}
          </Text>
          <Text style={[styles.callingHeaderStatus, { color: colors.mutedForeground }]} numberOfLines={1}>
            Calling…
          </Text>
        </View>
        <View style={styles.callingHeaderBtn} />
      </View>

      <View style={styles.callingBody}>
        {peerAvatar ? (
          <Image source={{ uri: peerAvatar }} style={styles.callingAvatar} />
        ) : (
          <View style={[styles.callingAvatar, styles.callingAvatarFallback, { backgroundColor: theme.avatar }]}>
            <Text style={styles.callingAvatarText}>{getInitials(peerName || '?')}</Text>
          </View>
        )}
      </View>

      {/* Full control row, shown instantly. Visual-only until the live meeting
          loads (a beat later) and the interactive CallControls take over —
          except the hang-up button, which works immediately. */}
      <View style={[styles.placeholderControls, { paddingBottom: insets.bottom + 16 }]}>
        <View
          style={[
            styles.placeholderPill,
            {
              backgroundColor: speakerOn ? colors.secondaryForeground : colors.secondary,
              borderColor: speakerOn ? colors.secondaryForeground : colors.border,
            },
          ]}
        >
          <Volume2 size={24} color={speakerOn ? colors.background : colors.secondaryForeground} />
        </View>
        <View style={[styles.placeholderPill, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
          <Mic size={24} color={colors.secondaryForeground} />
        </View>
        <View style={[styles.placeholderPill, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
          <Video size={24} color={colors.secondaryForeground} />
        </View>
        <TouchableOpacity
          style={[styles.placeholderLeave, { backgroundColor: colors.destructive }]}
          activeOpacity={0.85}
          onPress={onLeave}
          accessibilityLabel="Leave call"
        >
          <View style={styles.placeholderLeaveIcon}>
            <Phone size={24} color="#fff" fill="#fff" />
          </View>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // Instant "Calling…" placeholder control bar (mirrors CallControls' layout).
  placeholderControls: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 13, paddingTop: 16, paddingHorizontal: 16 },
  placeholderPill: { width: 53, height: 53, borderRadius: 20, borderWidth: 1, justifyContent: 'center', alignItems: 'center' },
  placeholderLeave: { width: 78, height: 53, borderRadius: 20, justifyContent: 'center', alignItems: 'center' },
  placeholderLeaveIcon: { transform: [{ rotate: '135deg' }] },
  // WhatsApp-style outgoing call.
  // Top bar: minimize (left) · name + "Calling…" (center) · add people (right).
  callingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    height: 56,
  },
  callingHeaderBtn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
  // Live self-camera preview filling the calling screen — square corners (the
  // tile defaults to a rounded 8px radius meant for grid cells).
  selfPreview: { borderRadius: 0 },
  // Dark scrim behind the top bar so its white text/icons stay legible over the
  // live camera preview.
  callingHeaderScrim: { backgroundColor: 'rgba(0,0,0,0.28)' },
  callingHeaderCenter: { flex: 1, alignItems: 'center', paddingHorizontal: 8 },
  callingHeaderName: { fontSize: 17, fontWeight: '600' },
  callingHeaderStatus: { fontSize: 13, marginTop: 2 },
  // Avatar centered in the body.
  callingBody: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 },
  // rounded-square — a softer ~28% radius so the calling-screen avatar reads
  // as noticeably more rounded than the participant-tile avatar.
  callingAvatar: { width: 152, height: 152, borderRadius: 42 },
  callingAvatarFallback: { justifyContent: 'center', alignItems: 'center' },
  callingAvatarText: { color: '#fff', fontSize: 48, fontWeight: '600' },
  // flex items-center justify-between px-4 border-b h-[53px]
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    height: 53,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 },
  minimizeBtn: { width: 28, height: 28, justifyContent: 'center', alignItems: 'center', marginLeft: -4 },
  title: { fontSize: 16, fontWeight: '600', flexShrink: 1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 },
  duration: { fontSize: 14, fontVariant: ['tabular-nums'], marginRight: 4 },
  divider: { width: StyleSheet.hairlineWidth, height: 16, marginHorizontal: 2 },
  // ghost "People" button — Users icon + count
  peopleBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, height: 32, borderRadius: 8 },
  peopleCount: { fontSize: 13, fontWeight: '500', fontVariant: ['tabular-nums'] },
  // grid p-4 gap-2
  stage: { flex: 1, padding: 16 },
  gridColumn: { flex: 1, gap: 8 },
  gridRow: { flex: 1, flexDirection: 'row', gap: 8 },
  cell: { flex: 1, position: 'relative' },
  fill: { flex: 1 },
  // overflow badge — absolute top-2 right-2 rounded-[7px] bg-black/70
  overflowBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 7,
  },
  overflowText: { color: '#fff', fontSize: 13, fontWeight: '500' },
});
