'use client';

/**
 * Connected room view. Delegates entirely to the shared MeetingRoomView so the
 * in-call design matches apps/web/platform/weldmeet exactly.
 */

import type RealtimeKitClient from '@cloudflare/realtimekit';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  MeetingRoomView,
  PeopleEntityListPanel,
  type ViewMode,
} from '@weldsuite/weldmeet-ui';

import type { GuestHostControls } from '@/lib/schemas';
import { playHandRaiseSound, playHandLowerSound, playMuteSound, playUnmuteSound, playCameraToggleSound } from '@/lib/call-sounds';

import { GuestChatPanel } from '../guest-chat-panel';
import { useGuestPiP, type PiPFocused } from './guest-pip';

interface GuestMeetingRoomProps {
  rtkClient: RealtimeKitClient | null;
  meetingTitle: string;
  duration: number;
  isMuted: boolean;
  isVideoOff: boolean;
  toggleMute: () => void;
  toggleVideo: () => void;
  handleLeave: () => void;
  joinCode: string;
  colorSeed: string;
  meetingId: string;
  orgId: string;
  guestName: string;
  guestEmail: string;
  hostControls: GuestHostControls;
  onHostControlsBroadcast: React.Dispatch<React.SetStateAction<GuestHostControls>>;
}

export function GuestMeetingRoom({
  rtkClient,
  meetingTitle,
  duration,
  isMuted,
  isVideoOff,
  toggleMute,
  toggleVideo,
  handleLeave,
  joinCode,
  colorSeed,
  meetingId,
  orgId,
  guestName,
  guestEmail,
  hostControls,
  onHostControlsBroadcast,
}: GuestMeetingRoomProps) {
  const [participants, setParticipants] = useState<unknown[]>([]);
  const [handRaised, setHandRaised] = useState(false);
  const [captions, setCaptions] = useState<Array<{
    id: string; peerId: string; speakerName: string; text: string; isPartial: boolean; at: number;
  }>>([]);
  const [handRaisedParticipants, setHandRaisedParticipants] = useState<Set<string>>(new Set());
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (!rtkClient) return;
    const client = rtkClient as unknown as any;

    const updateParticipants = () => {
      const joined = client.participants?.joined?.toArray?.() ?? [];
      setParticipants([client.self, ...joined]);
    };

    updateParticipants();
    client.self?.on?.('audioUpdate', updateParticipants);
    client.self?.on?.('videoUpdate', updateParticipants);
    // Re-render when the local user's screen share starts or stops so the
    // ScreenShareTile appears / disappears in the grid immediately.
    client.self?.on?.('screenShareUpdate', updateParticipants);

    const attachRemoteScreenShareListeners = () => {
      const joined = client.participants?.joined?.toArray?.() ?? [];
      for (const p of joined) {
        p?.on?.('screenShareUpdate', updateParticipants);
      }
    };
    const detachRemoteScreenShareListeners = () => {
      const joined = client.participants?.joined?.toArray?.() ?? [];
      for (const p of joined) {
        p?.off?.('screenShareUpdate', updateParticipants);
      }
    };

    const handleParticipantChange = () => {
      detachRemoteScreenShareListeners();
      updateParticipants();
      attachRemoteScreenShareListeners();
    };

    attachRemoteScreenShareListeners();
    client.participants?.joined?.on?.('participantJoined', handleParticipantChange);
    client.participants?.joined?.on?.('participantLeft', handleParticipantChange);

    const ai = client.ai;
    const onTranscript = (t: any) => {
      if (!t?.transcript || !t.peerId) return;
      setCaptions((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.peerId === t.peerId && last.isPartial) {
          next[next.length - 1] = {
            ...last,
            text: t.transcript ?? '',
            isPartial: t.isPartialTranscript !== false,
            at: Date.now(),
          };
          return next;
        }
        next.push({
          id: t.id ?? `cap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          peerId: t.peerId ?? '',
          speakerName: t.name ?? 'Speaker',
          text: t.transcript ?? '',
          isPartial: t.isPartialTranscript !== false,
          at: Date.now(),
        });
        return next.length > 5 ? next.slice(-5) : next;
      });
    };
    try { ai?.on?.('transcript', onTranscript); } catch { /* ignore */ }

    const onBroadcast = (msg: { type: string; payload: Record<string, unknown> }) => {
      if (msg.type === 'call:hand-raised' || msg.type === 'call:hand-lowered') {
        const peerId = typeof msg.payload?.peerId === 'string' ? msg.payload.peerId : null;
        if (!peerId) return;
        // RTK echoes broadcastMessage back to the sender, so this handler also
        // fires for our OWN hand-raise. toggleHandRaise already played the sound
        // and updated state optimistically — re-handling the echo here is what
        // produced the double chime. Ignore our own peerId.
        if (peerId === client.self?.id) return;
        // Audible cue for the guest when another participant raises/lowers a
        // hand — parity with the platform app (weldmeet-call-context).
        if (msg.type === 'call:hand-raised') playHandRaiseSound();
        else playHandLowerSound();
        setHandRaisedParticipants((prev) => {
          const next = new Set(prev);
          if (msg.type === 'call:hand-raised') next.add(peerId);
          else next.delete(peerId);
          return next;
        });
        return;
      }
      if (msg.type === 'call:host-controls-updated') {
        const json = typeof msg.payload?.controlsJson === 'string' ? msg.payload.controlsJson : null;
        if (!json) return;
        let controls: Partial<GuestHostControls>;
        try {
          controls = JSON.parse(json) as Partial<GuestHostControls>;
        } catch {
          return;
        }
        onHostControlsBroadcast((prev) => ({ ...prev, ...controls }));
        return;
      }
    };
    try { client.participants?.on?.('broadcastedMessage', onBroadcast); } catch { /* ignore */ }

    return () => {
      client.participants?.joined?.off?.('participantJoined', handleParticipantChange);
      client.participants?.joined?.off?.('participantLeft', handleParticipantChange);
      detachRemoteScreenShareListeners();
      client.self?.off?.('audioUpdate', updateParticipants);
      client.self?.off?.('videoUpdate', updateParticipants);
      client.self?.off?.('screenShareUpdate', updateParticipants);
      try { client.participants?.off?.('broadcastedMessage', onBroadcast); } catch { /* ignore */ }
      try { ai?.off?.('transcript', onTranscript); } catch { /* ignore */ }
    };
  }, [rtkClient, onHostControlsBroadcast]);

  const startScreenShare = useCallback(async (constraints?: DisplayMediaStreamOptions) => {
    if (!rtkClient) return;
    const client = rtkClient as unknown as any;
    try {
      // RTK's enableScreenShare() takes no arguments — it calls getDisplayMedia
      // internally. We apply the picked resolution/framerate via
      // updateScreenshareConstraints (the SDK's supported way) after the track
      // is live, then set contentHint='detail' for spatial sharpness.
      await client.self.enableScreenShare();

      const videoConstraints = (constraints?.video && typeof constraints.video === 'object')
        ? (constraints.video as MediaTrackConstraints)
        : undefined;
      const pickIdeal = (v: unknown): number | undefined => {
        if (typeof v === 'number') return v;
        if (v && typeof v === 'object' && 'ideal' in (v as any) && typeof (v as any).ideal === 'number') {
          return (v as any).ideal as number;
        }
        return undefined;
      };
      const width = pickIdeal(videoConstraints?.width);
      const height = pickIdeal(videoConstraints?.height);
      const frameRate = pickIdeal(videoConstraints?.frameRate);

      if (width && height) {
        try {
          await client.self.updateScreenshareConstraints({
            width: { ideal: width },
            height: { ideal: height },
            ...(frameRate ? { frameRate: { ideal: frameRate } } : {}),
          });
        } catch (err) {
          console.warn('[GuestMeetingRoom] updateScreenshareConstraints failed:', err);
        }
      }

      try {
        const track = client.self.screenShareTracks?.video as MediaStreamTrack | undefined;
        if (track && 'contentHint' in track) {
          track.contentHint = 'detail';
        }
      } catch { /* ignore */ }

      // Mirror the user stopping via the browser's native "Stop sharing" bar
      // back into React state so the button label stays accurate.
      const onScreenShareUpdate = (update: { screenShareEnabled: boolean }) => {
        if (!update?.screenShareEnabled) {
          setIsScreenSharing(false);
          try { client.self.off?.('screenShareUpdate', onScreenShareUpdate); } catch { /* ignore */ }
        }
      };
      try { client.self.on?.('screenShareUpdate', onScreenShareUpdate); } catch { /* ignore */ }

      setIsScreenSharing(true);
    } catch (err: any) {
      const name = err?.name as string | undefined;
      if (name !== 'NotAllowedError' && name !== 'AbortError') {
        console.error('[GuestMeetingRoom] startScreenShare failed:', err);
      }
    }
  }, [rtkClient]);

  const stopScreenShare = useCallback(() => {
    if (!rtkClient) return;
    const client = rtkClient as unknown as any;
    try { client.self.disableScreenShare?.(); } catch { /* ignore */ }
    setIsScreenSharing(false);
  }, [rtkClient]);

  const toggleHandRaise = useCallback(() => {
    if (!rtkClient) return;
    const client = rtkClient as unknown as any;
    const selfPeerId: string | undefined = client.self?.id;
    if (!selfPeerId) return;
    setHandRaised((prev) => {
      const newState = !prev;
      setHandRaisedParticipants((set) => {
        const next = new Set(set);
        if (newState) next.add(selfPeerId); else next.delete(selfPeerId);
        return next;
      });
      if (newState) playHandRaiseSound(); else playHandLowerSound();
      try {
        client.participants?.broadcastMessage?.(
          newState ? 'call:hand-raised' : 'call:hand-lowered',
          { peerId: selfPeerId },
        );
      } catch (err) {
        console.error('[meeting-portal] broadcast hand-raise failed:', err);
      }
      return newState;
    });
  }, [rtkClient]);

  // Keep `isFullscreen` in sync with the browser's actual state so exiting via
  // the Escape key (or any other native exit) flips the three-dots menu back to
  // "Full screen" instead of leaving it stuck on "Minimize".
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    onChange();
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    // Don't set state optimistically — the `fullscreenchange` listener above is
    // the single source of truth, so a rejected request can't desync the label.
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }, []);

  // Participants (minus self) offered in the chat composer's @-mention picker.
  const selfId = (rtkClient as unknown as { self?: { id?: string } } | null)?.self?.id;
  const mentionParticipants = useMemo(
    () =>
      (participants as Array<{ id?: string; name?: string; picture?: string }>)
        .filter((p) => p?.id && p.id !== selfId)
        .map((p) => ({ id: p.id as string, name: p.name || 'Guest', avatar: p.picture ?? null })),
    [participants, selfId],
  );

  // Out-of-browser Picture-in-Picture: focus the first remote (active-speaker
  // proxy) or fall back to self, mirroring the platform PiP widget.
  const pipParts = participants as Array<{ id?: string; name?: string; videoEnabled?: boolean; videoTrack?: MediaStreamTrack | null }>;
  const focusedRemote = pipParts.find((p) => p?.id && p.id !== selfId);
  const focusedP = focusedRemote ?? pipParts.find((p) => p?.id === selfId) ?? pipParts[0] ?? null;
  const pipFocused: PiPFocused = {
    name: focusedP?.name || 'Guest',
    videoTrack: focusedP?.videoEnabled ? (focusedP?.videoTrack ?? null) : null,
    isSelf: !focusedRemote,
  };
  // Play the same mic/camera cues a platform participant hears. isMuted /
  // isVideoOff reflect the CURRENT state, so toggling flips to !current.
  const handleToggleMute = useCallback(() => {
    if (isMuted) playUnmuteSound(); else playMuteSound();
    toggleMute();
  }, [isMuted, toggleMute]);
  const handleToggleVideo = useCallback(() => {
    playCameraToggleSound();
    toggleVideo();
  }, [toggleVideo]);

  const { openPiP, pipNode } = useGuestPiP({
    focused: pipFocused,
    meetingTitle,
    isMuted,
    isVideoOff,
    onToggleMute: handleToggleMute,
    onToggleVideo: handleToggleVideo,
    onLeave: handleLeave,
  });

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <MeetingRoomView
        meetingId={joinCode}
        meetingTitle={meetingTitle}
        meeting={rtkClient as any}
        participants={participants as any}
        isMuted={isMuted}
        isVideoOff={isVideoOff}
        isScreenSharing={isScreenSharing}
        handRaised={handRaised}
        handRaisedParticipants={handRaisedParticipants}
        duration={duration}
        isOrganizer={false}
        viewMode={viewMode}
        isFullscreen={isFullscreen}
        hostControls={hostControls}
        captions={captions}
        toggleMute={handleToggleMute}
        toggleVideo={handleToggleVideo}
        startScreenShare={startScreenShare}
        stopScreenShare={stopScreenShare}
        toggleHandRaise={toggleHandRaise}
        setViewMode={setViewMode}
        onLeave={handleLeave}
        onToggleFullscreen={toggleFullscreen}
        onPictureInPicture={openPiP}
        showHostControlsButton={false}
        showToolsButton={false}
        selfColorSeed={colorSeed}
        peoplePanelSlot={
          <PeopleEntityListPanel
            meeting={rtkClient as any}
            participants={participants as any}
            selfIsHost={false}
          />
        }
        chatPanelSlot={meetingId && guestEmail ? ({ isOpen, onClose, onOpen, notificationHost }) => (
          <GuestChatPanel
            meetingId={meetingId}
            orgId={orgId}
            guestName={guestName}
            guestEmail={guestEmail}
            guestUserId={`guest:${guestEmail.toLowerCase()}`}
            isOpen={isOpen}
            onClose={onClose}
            onOpen={onOpen}
            notificationHost={notificationHost}
            participants={mentionParticipants}
          />
        ) : undefined}
      />
      {pipNode}
    </div>
  );
}
