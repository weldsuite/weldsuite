/**
 * Participant Context Menu — shared right-click / "more options" menu.
 *
 * Extracted from ParticipantTile so the exact same menu can be raised from the
 * meeting tiles AND the People panel rows. Pure presentational: positioned with
 * fixed coordinates, all actions drive the RTK participant/meeting handles.
 *
 * Local-playback controls (volume slider + "Mute for me") only render when the
 * caller wires `volume` / `localMuted` + their setters — i.e. where an actual
 * <audio> element exists (the tile). The People panel omits them.
 */

'use client';

import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  Maximize,
  Pin,
  MessageSquare,
  PhoneOff,
  UserX,
  UserCircle2,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { cn } from '@weldsuite/ui/lib/utils';

export interface ParticipantContextMenuProps {
  participant: any;
  isSelf?: boolean;
  meeting?: any;
  pinned?: boolean;
  /**
   * Whether the local viewer may control other participants (mute for everyone,
   * turn off video, remove from call). Host-only — defaults to false so guests
   * (e.g. the meeting portal, which passes isOrganizer=false) never see these.
   */
  canManageParticipants?: boolean;
  /** Viewport coordinates for the top-left of the menu. */
  position: { x: number; y: number };
  onClose: () => void;
  onTogglePin?: (id: string) => void;
  onSendMessage?: (participant: any) => void;
  onClickDetails?: (participant: any) => void;
  /** Local-playback controls — when omitted the volume slider + "Mute for me"
   *  row are hidden (e.g. in the People panel, which has no audio element). */
  volume?: number;
  localMuted?: boolean;
  onVolumeChange?: (v: number) => void;
  onLocalMutedChange?: (muted: boolean) => void;
}

export function ParticipantContextMenu({
  participant,
  isSelf,
  meeting,
  pinned,
  position,
  onClose,
  onTogglePin,
  onSendMessage,
  onClickDetails,
  volume,
  localMuted,
  onVolumeChange,
  onLocalMutedChange,
  canManageParticipants = false,
}: ParticipantContextMenuProps) {
  const name = participant?.name || 'Participant';
  const showLocalPlayback =
    !isSelf && typeof volume === 'number' && !!onVolumeChange && !!onLocalMutedChange;

  return (
    <>
      <div
        className="fixed inset-0 z-30"
        onClick={(e) => {
          // Stop the click bubbling to the tile beneath, which would otherwise
          // toggle its focus while the user is merely dismissing this menu.
          e.stopPropagation();
          onClose();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
      />
      <div
        className="fixed z-40 bg-popover border border-border rounded-md shadow-md min-w-[200px] animate-in fade-in-0 zoom-in-95 duration-100 overflow-hidden"
        style={{ top: position.y, left: position.x }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-2 py-2.5">
          <Avatar className="h-5 w-5 !rounded-[6px]">
            {participant.picture && <AvatarImage src={participant.picture} className="!rounded-[6px]" />}
            <AvatarFallback className="text-[9px] !rounded-[6px]">{name[0]?.toUpperCase() ?? '?'}</AvatarFallback>
          </Avatar>
          <span className="text-sm font-semibold truncate">{isSelf ? 'You' : name}</span>
        </div>

        <div className="-mx-px h-px bg-border" />

        {/* Volume slider (remote only, local playback) */}
        {showLocalPlayback && (
          <>
            <div className="px-2 py-1.5">
              <div className="flex items-center gap-2 px-2 py-1 rounded-sm">
                <button
                  onClick={() => onLocalMutedChange!(!localMuted)}
                  className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors -ml-[3px]"
                >
                  {localMuted || volume === 0 ? (
                    <VolumeX className="h-3.5 w-3.5 text-red-500" />
                  ) : (
                    <Volume2 className="h-3.5 w-3.5" />
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={localMuted ? 0 : volume}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    onVolumeChange!(v);
                    if (v > 0 && localMuted) onLocalMutedChange!(false);
                    if (v === 0) onLocalMutedChange!(true);
                  }}
                  className="flex-1 h-1 accent-primary cursor-pointer"
                />
                <span className="text-[10px] text-muted-foreground tabular-nums w-7 text-right flex-shrink-0">
                  {localMuted ? 0 : volume}%
                </span>
              </div>
            </div>
            <div className="-mx-px h-px bg-border" />
          </>
        )}

        {/* Actions */}
        <div className="p-1">
          {isSelf && (
            <>
              <button
                onClick={() => {
                  meeting?.self?.audioEnabled ? meeting.self.disableAudio() : meeting?.self?.enableAudio();
                  onClose();
                }}
                className="relative flex items-center gap-2 w-full text-sm px-2 py-1.5 rounded-sm cursor-default select-none outline-none hover:bg-accent hover:text-accent-foreground transition-colors"
              >
                {participant.audioEnabled ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4 text-red-500" />}
                {participant.audioEnabled ? 'Mute' : 'Unmute'}
              </button>
              <button
                onClick={() => {
                  meeting?.self?.videoEnabled ? meeting.self.disableVideo() : meeting?.self?.enableVideo();
                  onClose();
                }}
                className="relative flex items-center gap-2 w-full text-sm px-2 py-1.5 rounded-sm cursor-default select-none outline-none hover:bg-accent hover:text-accent-foreground transition-colors"
              >
                {participant.videoEnabled ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4 text-red-500" />}
                {participant.videoEnabled ? 'Turn off camera' : 'Turn on camera'}
              </button>
            </>
          )}

          {showLocalPlayback && (
            <button
              onClick={() => {
                onLocalMutedChange!(!localMuted);
                onClose();
              }}
              className="relative flex items-center gap-2 w-full text-sm px-2 py-1.5 rounded-sm cursor-default select-none outline-none hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              {localMuted ? <VolumeX className="h-4 w-4 text-red-500" /> : <Volume2 className="h-4 w-4" />}
              {localMuted ? 'Unmute for me' : 'Mute for me'}
            </button>
          )}

          <button
            onClick={() => {
              onTogglePin?.(participant.id);
              onClose();
              (!pinned ? participant.pin() : participant.unpin()).catch((err: any) => console.warn('Pin failed:', err));
            }}
            className="relative flex items-center gap-2 w-full text-sm px-2 py-1.5 rounded-sm cursor-default select-none outline-none hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <Pin className={cn('h-4 w-4', pinned && 'text-primary fill-primary')} />
            {pinned ? 'Unpin' : 'Pin'}
          </button>

          <button
            onClick={() => {
              onTogglePin?.(participant.id);
              onClose();
              participant.pin().catch((err: any) => console.warn('Spotlight failed:', err));
            }}
            className="relative flex items-center gap-2 w-full text-sm px-2 py-1.5 rounded-sm cursor-default select-none outline-none hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <Maximize className="h-4 w-4" />
            Spotlight
          </button>

          {!isSelf && onSendMessage && (
            <button
              onClick={() => {
                onSendMessage(participant);
                onClose();
              }}
              className="relative flex items-center gap-2 w-full text-sm px-2 py-1.5 rounded-sm cursor-default select-none outline-none hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              <MessageSquare className="h-4 w-4" />
              Send message
            </button>
          )}

          {onClickDetails && (
            <button
              onClick={() => {
                onClickDetails(participant);
                onClose();
              }}
              className="relative flex items-center gap-2 w-full text-sm px-2 py-1.5 rounded-sm cursor-default select-none outline-none hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              <UserCircle2 className="h-4 w-4" />
              View profile
            </button>
          )}
        </div>

        {/* Destructive actions — "Leave call" for yourself; host-only controls
            (mute for everyone / turn off video / remove) for others. The host
            controls are gated on `canManageParticipants` so guests (meeting
            portal) never see them. */}
        {(isSelf || canManageParticipants) && (
        <>
        <div className="-mx-px h-px bg-border" />

        <div className="p-1">
          {isSelf ? (
            <button
              onClick={() => {
                meeting?.leave?.();
                onClose();
              }}
              className="relative flex items-center gap-2 w-full text-sm px-2 py-1.5 rounded-sm cursor-default select-none outline-none text-destructive hover:bg-destructive/10 hover:text-destructive transition-colors"
            >
              <PhoneOff className="h-4 w-4" />
              Leave call
            </button>
          ) : (
            <>
              <button
                onClick={async () => {
                  try {
                    await participant.disableAudio();
                  } catch (err) {
                    console.warn('Mute for everyone failed:', err);
                  }
                  onClose();
                }}
                disabled={!participant.audioEnabled}
                className={cn(
                  'relative flex items-center gap-2 w-full text-sm px-2 py-1.5 rounded-sm cursor-default select-none outline-none text-destructive hover:bg-destructive/10 hover:text-destructive transition-colors',
                  !participant.audioEnabled && 'opacity-40 pointer-events-none',
                )}
              >
                <MicOff className="h-4 w-4" />
                Mute for everyone
              </button>
              <button
                onClick={async () => {
                  try {
                    await participant.disableVideo();
                  } catch (err) {
                    console.warn('Disable video failed:', err);
                  }
                  onClose();
                }}
                disabled={!participant.videoEnabled}
                className={cn(
                  'relative flex items-center gap-2 w-full text-sm px-2 py-1.5 rounded-sm cursor-default select-none outline-none text-destructive hover:bg-destructive/10 hover:text-destructive transition-colors',
                  !participant.videoEnabled && 'opacity-40 pointer-events-none',
                )}
              >
                <VideoOff className="h-4 w-4" />
                Turn off video
              </button>
              <button
                onClick={async () => {
                  try {
                    await participant.kick();
                  } catch (err) {
                    console.warn('Kick failed:', err);
                  }
                  onClose();
                }}
                className="relative flex items-center gap-2 w-full text-sm px-2 py-1.5 rounded-sm cursor-default select-none outline-none text-destructive hover:bg-destructive/10 hover:text-destructive transition-colors"
              >
                <UserX className="h-4 w-4" />
                Remove from call
              </button>
            </>
          )}
        </div>
        </>
        )}
      </div>
    </>
  );
}
