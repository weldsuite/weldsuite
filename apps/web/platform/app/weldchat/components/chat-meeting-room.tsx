'use client';

/**
 * WeldChat meeting-room adapter.
 *
 * Feeds the WeldChat call context (`useWeldChatCall`) into the SAME shared
 * `MeetingRoomView` / `PreviewView` the WeldMeet experience uses, so an ad-hoc
 * channel / DM call renders the exact polished meeting room.
 *
 * This is the WeldChat analogue of `app/weldmeet/components/meeting-overlay.tsx`
 * (`MeetingRoomAdapter` / `PreviewAdapter`). The two call contexts are twins —
 * same Cloudflare RealtimeKit client, same `ViewMode` union — so the mapping is
 * almost 1:1. Chat-call chrome is intentionally LEAN: no in-call chat (the
 * channel is the chat), no host-controls, no recording, no share-link.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useUser } from '@clerk/clerk-react';
import { toast } from 'sonner';
import { useWeldChatCall } from '@/contexts/weldchat-call-context';
import { useChannel, useChannelMembers } from '@/hooks/queries/use-weldchat-queries';
import { BackgroundEffectsPanel } from '@/components/virtual-background-picker';
import {
  playOutgoingRingSound,
  playCallJoinSound,
  playCallLeaveSound,
  playScreenShareSound,
} from '@/lib/utils/notification-sound';
import { MeetingRoomView } from '@weldsuite/weldmeet-ui';
import { useI18n } from '@/lib/i18n/provider';
import { ChannelChatPanel } from './channel-chat-panel';
import type { RTKParticipant, RTKSelf } from '@cloudflare/realtimekit';

interface CallMember {
  userId?: string;
  name?: string;
  email?: string;
  picture?: string;
}

/** A live RTK tile — either the local self or a joined remote participant. */
type CallParticipant = RTKParticipant | RTKSelf;

/** Synthetic "ringing" tile for a DM/group recipient who hasn't picked up yet. */
interface RingingParticipant {
  id: string;
  userId?: string;
  name?: string;
  picture?: string;
  audioEnabled: boolean;
  videoEnabled: boolean;
  screenShareEnabled: boolean;
  ringing: true;
  ringingLabel: string;
}

// ============================================================================
// Shared channel info — DM → other member; group → other members; title.
// Mirrors the logic previously inlined in the bespoke call header.
// ============================================================================

function useCallChannelInfo() {
  const { t } = useI18n();
  const { channelId, callType } = useWeldChatCall();
  const { user } = useUser();
  const { data: channelData } = useChannel(channelId ?? '');
  const { data: membersData } = useChannelMembers(channelId ?? '');

  const channel = channelData?.data as { type?: string; name?: string } | undefined;
  const isDm = channel?.type === 'dm';
  const isGroup = channel?.type === 'group';

  const otherMembers = useMemo<CallMember[]>(() => {
    const members = (membersData?.data || []) as CallMember[];
    return members.filter((m) => m.userId !== user?.id);
  }, [membersData, user?.id]);

  const dmOther = isDm ? otherMembers[0] ?? null : null;

  const title = isDm
    ? dmOther?.name || dmOther?.email || t.weldchat.callOverlay.directMessage
    : channel?.name || (callType === 'video' ? t.weldchat.callRoom.videoCall : t.weldchat.callRoom.voiceCall);

  return { isDm, isGroup, isDmOrGroup: isDm || isGroup, dmOther, otherMembers, title };
}

// ============================================================================
// Connected adapter — pulls live state and renders the shared MeetingRoomView.
//
// Discord-style outgoing call: the in-call layout is IDENTICAL whether or not
// the recipients have joined. Recipients who haven't picked up yet are injected
// as synthetic "ringing" participant tiles (avatar + pulsing halo) that the
// shared ParticipantTile renders via `participant.ringing`. Each placeholder is
// replaced by the recipient's real tile the moment they join.
// ============================================================================

function ChatMeetingRoomAdapter() {
  const {
    meeting,
    callId,
    channelId,
    isMuted,
    isVideoOff,
    isScreenSharing,
    duration,
    handRaised,
    handRaisedParticipants,
    isFullscreen,
    viewMode,
    toggleMute,
    toggleVideo,
    startScreenShare,
    stopScreenShare,
    toggleHandRaise,
    toggleFullscreen,
    minimizeToPiP,
    setViewMode,
    leaveCall,
    backgroundType,
    backgroundValue,
    isBackgroundLoading,
    applyBlur,
    applyImage,
    removeBackground,
    isCallInitiator,
  } = useWeldChatCall();

  const { t } = useI18n();
  const { isDmOrGroup, otherMembers, title: meetingTitle } = useCallChannelInfo();

  const [participants, setParticipants] = useState<CallParticipant[]>([]);
  const [showEffects, setShowEffects] = useState(false);
  // Track whether any remote has joined. Once true the ringback stops.
  const [remoteEverJoined, setRemoteEverJoined] = useState(false);
  // After 30s of ringing with no pickup, drop the "calling" tiles and just
  // leave the local user alone in the room.
  const [ringingExpired, setRingingExpired] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setRingingExpired(true), 30_000);
    return () => clearTimeout(id);
  }, []);

  // RTK fires `screenShareUpdate` on `self` *before* its internal getter is
  // updated, so reading `meeting.self.screenShareTracks` inside the listener
  // picks up stale null tracks. Capture the values straight from the event
  // payload and merge them into the self snapshot below. (Same race + fix as
  // the WeldMeet adapter.)
  const [selfScreenShare, setSelfScreenShare] = useState<{
    enabled: boolean;
    videoTrack: MediaStreamTrack | null;
  }>({ enabled: false, videoTrack: null });

  // Peer ids of remote participants currently sharing their screen. Diffed on
  // each `screenShareUpdate` so the chime fires only on a genuine
  // not-sharing → sharing transition (robust against RTK's stale-getter race:
  // a momentarily stale read just delays the chime to the next event, it never
  // produces a false positive).
  const sharingPeersRef = useRef<Set<string>>(new Set());

  // Subscribe to RTK participant + media events; rebuild the [self, ...joined]
  // snapshot on every change so the shared view re-renders. Remote
  // join/leave/screen-share events also play a short audio cue so the user
  // hears what's happening without watching the grid.
  useEffect(() => {
    if (!meeting) return;

    const updateParticipants = () => {
      const joined = meeting.participants?.joined?.toArray?.() ?? [];
      setParticipants([meeting.self, ...joined]);
    };

    const sharingPeers = () =>
      new Set<string>(
        (meeting.participants?.joined?.toArray?.() ?? [])
          .filter((p) => p?.screenShareEnabled && p?.screenShareTracks?.video)
          .map((p) => p.id),
      );

    const onSelfScreenShareUpdate = (payload: {
      screenShareEnabled: boolean;
      screenShareTracks: { audio?: MediaStreamTrack; video?: MediaStreamTrack };
    }) => {
      setSelfScreenShare({
        enabled: payload.screenShareEnabled,
        videoTrack: payload.screenShareTracks?.video ?? null,
      });
      updateParticipants();
    };

    // A remote participant joined the call.
    const onParticipantJoined = () => {
      playCallJoinSound();
      updateParticipants();
    };

    // A remote participant left the call.
    const onParticipantLeft = () => {
      playCallLeaveSound();
      updateParticipants();
    };

    // A remote participant toggled their screen share — chime only on start.
    const onRemoteScreenShareUpdate = () => {
      const nowSharing = sharingPeers();
      const started = [...nowSharing].some((id) => !sharingPeersRef.current.has(id));
      sharingPeersRef.current = nowSharing;
      if (started) playScreenShareSound();
      updateParticipants();
    };

    // Seed the sharing set so a share already in progress when we join an
    // active call doesn't fire a spurious chime on the first event.
    sharingPeersRef.current = sharingPeers();

    // Seed self screen-share from the live RTK getters. `selfScreenShare` is
    // otherwise only populated by the `screenShareUpdate` event — which does
    // NOT re-fire on remount. So when this adapter remounts mid-share (toggling
    // inline ↔ fullscreen / PiP, navigating away + back, switching channel or
    // layout) the new instance resets to "not sharing" and the self tile shows
    // nothing, even though RTK is still publishing the screen (remotes keep
    // seeing it). Reading the getter on mount restores the local self-share
    // tile. Safe here: outside the brief start-event window the getter is
    // settled, so the stale-getter race the event handler guards against does
    // not apply.
    setSelfScreenShare({
      enabled: !!meeting.self?.screenShareEnabled,
      videoTrack: meeting.self?.screenShareTracks?.video ?? null,
    });

    updateParticipants();
    meeting.participants?.joined?.on?.('participantJoined', onParticipantJoined);
    meeting.participants?.joined?.on?.('participantLeft', onParticipantLeft);
    meeting.participants?.joined?.on?.('screenShareUpdate', onRemoteScreenShareUpdate);
    meeting.self?.on?.('audioUpdate', updateParticipants);
    meeting.self?.on?.('videoUpdate', updateParticipants);
    meeting.self?.on?.('screenShareUpdate', onSelfScreenShareUpdate);

    return () => {
      meeting.participants?.joined?.off?.('participantJoined', onParticipantJoined);
      meeting.participants?.joined?.off?.('participantLeft', onParticipantLeft);
      meeting.participants?.joined?.off?.('screenShareUpdate', onRemoteScreenShareUpdate);
      meeting.self?.off?.('audioUpdate', updateParticipants);
      meeting.self?.off?.('videoUpdate', updateParticipants);
      meeting.self?.off?.('screenShareUpdate', onSelfScreenShareUpdate);
    };
  }, [meeting]);

  // Build a self snapshot whose screen-share fields use the event-payload
  // values (beating the RTK getter race). Plain object literal — never spread
  // the RTK class instance (its screenShare* fields are getter-only).
  //
  // IMPORTANT: source the live media fields from `participants[0]` (which IS
  // `meeting.self`, re-snapshotted into a fresh array by updateParticipants on
  // every audioUpdate/videoUpdate) and key the memo on `participants`. The RTK
  // `meeting.self` object reference is STABLE for the whole call, so memoising
  // only on `[meeting?.self, selfScreenShare]` froze videoEnabled/videoTrack at
  // their first value — toggling the camera fired videoUpdate but never
  // refreshed this shim, so the self tile kept showing the avatar ("camera does
  // nothing"). Depending on `participants` recomputes on each media change.
  const localShim = useMemo(() => {
    const s = participants[0] ?? meeting?.self;
    if (!s) return null;
    return {
      id: s.id,
      name: s.name,
      picture: s.picture,
      userId: s.userId,
      customParticipantId: s.customParticipantId,
      audioEnabled: s.audioEnabled,
      audioTrack: s.audioTrack,
      videoEnabled: s.videoEnabled,
      videoTrack: s.videoTrack,
      // Prefer the event-captured state (it beats RTK's start-event getter
      // race), but fall back to the live getter so an already-running share
      // still renders locally before the next event arrives (e.g. right after
      // a remount, before the seed-from-getter effect above has committed).
      screenShareEnabled: selfScreenShare.enabled || !!s.screenShareEnabled,
      screenShareTracks: {
        video: selfScreenShare.videoTrack ?? s.screenShareTracks?.video ?? null,
        audio: s.screenShareTracks?.audio ?? null,
      },
      pin: s.pin?.bind(s),
      unpin: s.unpin?.bind(s),
      disableAudio: s.disableAudio?.bind(s),
      disableVideo: s.disableVideo?.bind(s),
    };
  }, [participants, meeting?.self, selfScreenShare]);

  const participantsWithSelfScreenShare = useMemo(() => {
    if (participants.length === 0 || !localShim) return participants;
    const [, ...rest] = participants;
    return [localShim, ...rest];
  }, [localShim, participants]);

  // WeldChat's hand-raise set is keyed by user id (realtime events). The shared
  // view keys remote raised-hands by RTK peer id (`participant.id`). Remap so
  // remote raised hands light up the correct tiles. (Self uses `handRaised`.)
  const handRaisedByPeerId = useMemo(() => {
    const out = new Set<string>();
    for (const p of participants) {
      const key = p?.customParticipantId || p?.userId;
      if (key && handRaisedParticipants.has(key)) out.add(p.id);
    }
    return out;
  }, [participants, handRaisedParticipants]);

  // participants = [self, ...joined]; >1 means a remote has joined.
  const remoteJoined = participants.length > 1;
  useEffect(() => {
    if (remoteJoined) setRemoteEverJoined(true);
  }, [remoteJoined]);

  // Discord-style outgoing call: recipients who haven't picked up yet are shown
  // as synthetic "ringing" tiles in the SAME grid as a joined call. Replaced by
  // their real RTK tile the moment they join (matched by userId). DM/group only.
  const ringingPlaceholders = useMemo((): RingingParticipant[] => {
    if (!isDmOrGroup || ringingExpired) return [];
    const joinedKeys = new Set(
      participants.slice(1).flatMap((p) => [p?.userId, p?.customParticipantId].filter(Boolean)),
    );
    return otherMembers
      .filter((m) => m.userId && !joinedKeys.has(m.userId))
      .map((m) => ({
        id: `calling:${m.userId}`,
        userId: m.userId,
        name: m.name || m.email,
        picture: m.picture,
        audioEnabled: false,
        videoEnabled: false,
        screenShareEnabled: false,
        ringing: true,
        ringingLabel: t.weldchat.calling.ringing,
      }));
  }, [isDmOrGroup, ringingExpired, participants, otherMembers, t]);

  const allParticipants = useMemo(
    () => [...participantsWithSelfScreenShare, ...ringingPlaceholders],
    [participantsWithSelfScreenShare, ringingPlaceholders],
  );

  // The caller hears a soft ringback while waiting for the first pickup.
  useEffect(() => {
    if (!isCallInitiator || remoteEverJoined || ringingPlaceholders.length === 0) return;
    playOutgoingRingSound();
    const iv = setInterval(() => playOutgoingRingSound(), 3000);
    return () => clearInterval(iv);
  }, [isCallInitiator, remoteEverJoined, ringingPlaceholders.length]);

  // Auto-end the call after 3 continuous minutes alone (nobody joined, or
  // everyone left). The timer restarts whenever the alone/occupied state flips.
  // The toast message is read from a ref so a locale change can't reset the timer.
  const autoEndedMsgRef = useRef('');
  autoEndedMsgRef.current = t.weldchat.calling.autoEnded;
  const isAlone = participants.length <= 1;
  useEffect(() => {
    if (!isAlone) return;
    const id = setTimeout(() => {
      leaveCall();
      toast(autoEndedMsgRef.current);
    }, 3 * 60_000);
    return () => clearTimeout(id);
  }, [isAlone, leaveCall]);

  const backgroundEffectsSlot = (
    <BackgroundEffectsPanel
      backgroundType={backgroundType}
      backgroundValue={backgroundValue}
      isLoading={isBackgroundLoading}
      isOpen={showEffects}
      localParticipant={meeting?.self}
      onApplyBlur={applyBlur}
      onApplyImage={applyImage}
      onRemove={removeBackground}
      onClose={() => setShowEffects(false)}
    />
  );

  return (
    <MeetingRoomView
      meetingId={callId ?? ''}
      meetingTitle={meetingTitle}
      meeting={meeting}
      participants={allParticipants}
      isMuted={isMuted}
      isVideoOff={isVideoOff}
      isScreenSharing={isScreenSharing}
      handRaised={handRaised}
      handRaisedParticipants={handRaisedByPeerId}
      duration={duration}
      isOrganizer={false}
      viewMode={viewMode}
      isFullscreen={isFullscreen}
      toggleMute={toggleMute}
      toggleVideo={toggleVideo}
      startScreenShare={startScreenShare}
      stopScreenShare={stopScreenShare}
      toggleHandRaise={toggleHandRaise}
      setViewMode={setViewMode}
      onLeave={leaveCall}
      onToggleFullscreen={toggleFullscreen}
      onPictureInPicture={minimizeToPiP}
      onToggleEffects={() => setShowEffects((v) => !v)}
      effectsOpen={showEffects}
      backgroundType={backgroundType}
      backgroundEffectsSlot={backgroundEffectsSlot}
      // In-call chat tab — shows the CURRENT channel's chat (the call always
      // belongs to a channel/DM). Rendered via the shared chat panel, wired to
      // the WeldChat channel data layer in ChannelChatPanel.
      chatPanelSlot={
        channelId
          ? ({ isOpen, onClose, onOpen, notificationHost, skipTransition }) => (
              <ChannelChatPanel
                channelId={channelId}
                isOpen={isOpen}
                onClose={onClose}
                onOpen={onOpen}
                notificationHost={notificationHost}
                skipTransition={skipTransition}
              />
            )
          : undefined
      }
      // Lean chat-call chrome otherwise: people panel + channel chat only. No
      // info / host / tools / recording / share-link — none apply to ad-hoc calls.
      showInfoButton={false}
      showHostControlsButton={false}
      showToolsButton={false}
      showControlBarRecording={false}
    />
  );
}

// ============================================================================
// Public export — consumed by call-overlay.tsx
// ============================================================================

/**
 * The connected meeting room (self-wraps fixed inset-0 when isFullscreen).
 * Chat calls join straight in — there is no pre-join preview step.
 */
export function ChatMeetingRoomView() {
  return <ChatMeetingRoomAdapter />;
}
