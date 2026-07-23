import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@weldsuite/ui/lib/utils';
import { Hand, Pin, EllipsisVertical, Monitor, Volume2, VolumeX, ZoomIn, RotateCcw } from 'lucide-react';
import { ParticipantNameTag } from './participant-name-tag';
import { ParticipantAvatar } from './participant-avatar';
import { ParticipantContextMenu } from './participant-context-menu';

// ─── Camera-off tile palette ─────────────────────────────────────────────────
// Deterministic colored background per participant, à la Google Meet. The
// tile gets the darker shade; the centered avatar circle gets the lighter
// shade so the initials stay legible.

const PERSON_THEMES = [
  { tile: '#3f6e58', avatar: '#578a72' }, // forest green
  { tile: '#5e4d83', avatar: '#7a67a3' }, // muted purple
  { tile: '#4d6c8f', avatar: '#6788ad' }, // slate blue
  { tile: '#8a5060', avatar: '#a8707e' }, // coral
  { tile: '#3f7878', avatar: '#5d9494' }, // teal
  { tile: '#8a7050', avatar: '#a88a6c' }, // sand
  { tile: '#5b5694', avatar: '#7770ab' }, // indigo
  { tile: '#874660', avatar: '#a26178' }, // rose
  { tile: '#4a6e3f', avatar: '#688a57' }, // moss
  { tile: '#7a4a3f', avatar: '#9c6857' }, // terracotta
] as const;

function hashString(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h) + input.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

export function getPersonTheme(seed: string) {
  return PERSON_THEMES[hashString(seed || 'guest') % PERSON_THEMES.length]!;
}

export function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
  return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase();
}

// ─── Audio-level speaking detection ──────────────────────────────────────────

export function useIsSpeaking(audioTrack: MediaStreamTrack | null | undefined): boolean {
  const [isSpeaking, setIsSpeaking] = useState(false);

  useEffect(() => {
    if (!audioTrack) { setIsSpeaking(false); return; }

    let ctx: AudioContext | null = null;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    try {
      ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.8;
      const data = new Uint8Array(analyser.frequencyBinCount);
      ctx.createMediaStreamSource(new MediaStream([audioTrack])).connect(analyser);

      ctx.resume();

      intervalId = setInterval(() => {
        if (ctx?.state === 'running') {
          analyser.getByteFrequencyData(data);
          const avg = data.reduce((s, v) => s + v, 0) / data.length;
          setIsSpeaking(avg > 12);
        }
      }, 80);
    } catch {
      // AudioContext unavailable
    }

    return () => {
      if (intervalId !== null) clearInterval(intervalId);
      ctx?.close();
      setIsSpeaking(false);
    };
  }, [audioTrack]);

  return isSpeaking;
}

// ─── Participant Tile ────────────────────────────────────────────────────────

export interface ParticipantTileProps {
  participant: any;
  isSelf?: boolean;
  isHandRaised?: boolean;
  meeting?: any;
  pinned?: boolean;
  onTogglePin?: (id: string) => void;
  /** When provided, "Send message" item navigates to this URL (used in platform). */
  onSendMessage?: (participant: any) => void;
  /**
   * When provided, clicking the tile (or "View profile" in the context menu)
   * invokes this callback. Used by the platform to open a side sheet showing
   * the linked CRM contact / team-member details.
   */
  onClickDetails?: (participant: any) => void;
  /**
   * Optional stable identifier used to derive the camera-off tile color theme.
   * When omitted, the theme is hashed from participant.id / userId / name.
   * The meeting-portal passes the same seed it used on its pre-join preview
   * screen so the guest's avatar color stays identical from preview → in-meeting.
   */
  colorSeed?: string;
  /**
   * Whether the local viewer is the host and may control others (mute for
   * everyone / turn off video / remove). Host-only — defaults to false so
   * guests (meeting portal) never get these actions.
   */
  canManageParticipants?: boolean;
}

export function ParticipantTile({ participant, isSelf, isHandRaised, meeting, pinned, onTogglePin, onSendMessage, onClickDetails, colorSeed, canManageParticipants = false }: ParticipantTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [volume, setVolume] = useState(100);
  const [localMuted, setLocalMuted] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [contextPos, setContextPos] = useState({ x: 0, y: 0 });
  const name = participant.name || 'Participant';
  // Synthetic "ringing" placeholder for a callee who hasn't joined yet (Discord-
  // style outgoing call). The host app injects a pseudo-participant carrying
  // `ringing: true` (+ an optional localized `ringingLabel`). It renders as a
  // normal camera-off avatar tile with a pulsing halo, and is non-interactive.
  const ringing = !!participant.ringing;
  const isSpeaking = useIsSpeaking(participant.audioEnabled ? participant.audioTrack : null);
  const theme = useMemo(
    // Order matches the platform's call/participant-tile: customParticipantId
    // is stable across sessions (set by the host app when adding the
    // participant), userId is the auth-token identity, and id is the per-
    // session RTK-assigned id. Hash from the most stable available field so
    // every client viewing this participant computes the same color.
    () => getPersonTheme(colorSeed || String(participant.customParticipantId ?? participant.userId ?? participant.id ?? name)),
    [colorSeed, participant.customParticipantId, participant.userId, participant.id, name],
  );
  const initials = useMemo(() => getInitials(name), [name]);
  const showColoredTile = !participant.videoEnabled || !participant.videoTrack;

  useEffect(() => {
    if (videoRef.current && participant.videoEnabled && participant.videoTrack) {
      videoRef.current.srcObject = new MediaStream([participant.videoTrack]);
    } else if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, [participant.videoEnabled, participant.videoTrack]);

  useEffect(() => {
    if (isSelf || !audioRef.current) return;
    if (participant.audioEnabled && participant.audioTrack) {
      audioRef.current.srcObject = new MediaStream([participant.audioTrack]);
      // The <audio autoPlay> attribute reliably starts playback only on the
      // element's FIRST mount. Changing the view mode (e.g. grid → spotlight)
      // renders a different layout branch in MeetingRoomView, which remounts
      // this tile into a fresh <audio> element — and the attribute alone does
      // NOT resume MediaStream playback on that new element, leaving the remote
      // participant silent. Explicitly calling play() after attaching the
      // stream restores audio on every (re)mount (same fix as the PiP widget).
      audioRef.current.play().catch(() => { /* autoplay blocked / already playing */ });
    } else {
      audioRef.current.srcObject = null;
    }
  }, [isSelf, participant.audioEnabled, participant.audioTrack]);

  useEffect(() => {
    if (!audioRef.current || isSelf) return;
    audioRef.current.volume = localMuted ? 0 : volume / 100;
  }, [volume, localMuted, isSelf]);

  return (
    <div
      className={cn(
        'relative flex items-center justify-center rounded-lg overflow-hidden transition-shadow duration-150 group/tile h-full w-full [container-type:size]',
        !showColoredTile && 'bg-muted',
        !ringing && onTogglePin && 'cursor-pointer',
        pinned && 'ring-2 ring-primary ring-offset-1 ring-offset-background !aspect-auto h-full',
        isSpeaking && !pinned && 'ring-2 ring-green-500 ring-offset-1 ring-offset-background',
        isHandRaised && !isSpeaking && !pinned && 'ring-2 ring-yellow-500 ring-offset-1 ring-offset-background',
      )}
      // Clicking the tile body promotes this participant to the main stage (and
      // clicking again returns to the grid). Buttons, the name tag and the
      // context-menu overlay all stop propagation, so only "empty" tile clicks
      // toggle focus. Ringing placeholders stay inert.
      onClick={ringing || !onTogglePin ? undefined : () => onTogglePin(participant.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        if (ringing) return; // placeholder — no participant actions
        const menuW = 220;
        const menuH = 340;
        setContextPos({
          x: Math.min(e.clientX, window.innerWidth - menuW),
          y: e.clientY + menuH > window.innerHeight ? Math.max(0, e.clientY - menuH) : e.clientY,
        });
        setShowControls(true);
      }}
      style={showColoredTile ? { backgroundColor: theme.tile } : undefined}
    >
      {/* Outgoing-call ringing halo — a pulse emanating from the avatar. */}
      {ringing && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="h-[28cqmin] w-[28cqmin] min-h-10 min-w-10 max-h-32 max-w-32 rounded-[20%] ring-2 ring-primary/60 animate-ping" />
        </div>
      )}
      {ringing && participant.ringingLabel && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-medium text-white">
          {participant.ringingLabel}
        </div>
      )}

      {isHandRaised && (
        <div className="absolute top-2 left-2 z-10 bg-yellow-500 text-white rounded-lg p-1.5 shadow-md">
          <Hand className="h-4 w-4" />
        </div>
      )}

      {/* Top-right hover actions */}
      <div className={cn(
        'absolute top-2 right-2 z-10 flex items-center gap-1 opacity-0 group-hover/tile:opacity-100 transition-opacity',
        ringing && 'hidden',
      )}>
        {pinned && (
          <button
            onClick={(e) => { e.stopPropagation(); onTogglePin?.(participant.id); participant.unpin?.().catch(() => {}); }}
            className="bg-primary hover:bg-primary/80 text-primary-foreground rounded-lg p-1.5 shadow-md transition-colors cursor-pointer"
            title="Unpin"
          >
            <Pin className="h-3.5 w-3.5" fill="currentColor" />
          </button>
        )}
        <button
            onClick={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              setContextPos({ x: rect.right - 220, y: rect.bottom + 4 });
              setShowControls(true);
            }}
            className="bg-black/60 hover:bg-black/80 text-white rounded-[7.5px] p-1.5 transition-colors cursor-pointer"
            title="More options"
          >
            <EllipsisVertical className="h-3.5 w-3.5" />
          </button>
      </div>
      {participant.videoEnabled && participant.videoTrack ? (
        // Auto Picture-in-Picture is owned exclusively by the off-screen video
        // in MeetingPiPWidget so tab-switch always enters PiP via that single
        // candidate — adding `autopictureinpicture` here would create
        // competing candidates and Chrome's heuristic then auto-PiPs nothing.
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-cover"
        />
      ) : (
        <ParticipantAvatar
          initials={initials}
          color={theme.avatar}
          picture={participant.picture}
        />
      )}
      {!isSelf && <audio ref={audioRef} autoPlay />}

      {/* Name tag — shared so platform tile + portal preview stay in sync.
          Clicking the name tag (not the tile body) opens the participant
          details panel, leaving the tile body free for future interactions. */}
      <ParticipantNameTag
        name={isSelf ? 'You' : name}
        audioEnabled={ringing ? undefined : participant.audioEnabled}
        localMuted={localMuted}
        onClick={!ringing && onClickDetails ? () => onClickDetails(participant) : undefined}
      />

      {/* Participant context menu */}
      {showControls && !ringing && (
        <ParticipantContextMenu
          participant={participant}
          isSelf={isSelf}
          meeting={meeting}
          pinned={pinned}
          position={contextPos}
          onClose={() => setShowControls(false)}
          onTogglePin={onTogglePin}
          onSendMessage={onSendMessage}
          onClickDetails={onClickDetails}
          volume={volume}
          localMuted={localMuted}
          onVolumeChange={setVolume}
          onLocalMutedChange={setLocalMuted}
          canManageParticipants={canManageParticipants}
        />
      )}
    </div>
  );
}

// ─── Screen Share Tile ───────────────────────────────────────────────────────

export interface ScreenShareTileProps {
  /** The RTK participant object (self or remote) whose screen share to display. */
  participant: any;
  /** True when the participant is the local user. */
  isSelf?: boolean;
  /** RTK meeting handle. */
  meeting?: any;
  /** When provided, clicking the tile fires this — used to focus the screen
   *  onto the main stage (and to toggle focus back off). */
  onClick?: () => void;
  /** Highlights the tile (primary ring) when this screen is the focused one. */
  focused?: boolean;
}

// ─── Zoom + pan helpers (module-scope so they're stable across renders) ───────
const SCREEN_MAX_SCALE = 6;
const clampNum = (val: number, min: number, max: number) => Math.max(min, Math.min(max, val));
/** Clamp a pan offset so the (center-origin, scaled) content never reveals edges. */
function clampScreenOffset(x: number, y: number, scale: number, w: number, h: number) {
  const maxX = (w * (scale - 1)) / 2;
  const maxY = (h * (scale - 1)) / 2;
  return { x: clampNum(x, -maxX, maxX), y: clampNum(y, -maxY, maxY) };
}

/**
 * Renders a participant's screen-share track as a standalone grid tile.
 *
 * RTK exposes `participant.screenShareTracks.video` (a `MediaStreamTrack`) on
 * both `self` and remote participants when screen sharing is active.  This tile
 * attaches that track to a `<video>` element and labels it so viewers know
 * whose screen is being shared.
 *
 * Viewers can scroll to zoom toward the cursor and drag to pan around the shared
 * screen (DeskCode-style) — purely local-visual, so each viewer zooms
 * independently. The presenter gets a mute/unmute control for the screen-share
 * AUDIO track (the one captured when they tick "share audio" in the browser
 * picker), and remote viewers actually hear that audio here.
 */
export function ScreenShareTile({ participant, isSelf, onClick, focused }: ScreenShareTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const shareAudioRef = useRef<HTMLAudioElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const name = participant?.name || 'Participant';

  // ─── Screen-share VIDEO track → <video> ─────────────────────────────────────
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const track: MediaStreamTrack | undefined = participant?.screenShareTracks?.video;
    if (track) {
      el.srcObject = new MediaStream([track]);
    } else {
      el.srcObject = null;
    }
    return () => {
      if (el) el.srcObject = null;
    };
  }, [participant?.screenShareTracks?.video]);

  // ─── Screen-share AUDIO ─────────────────────────────────────────────────────
  // RTK captures a screen-share audio track when the presenter ticks "share
  // audio" in the browser picker. It was never played, so viewers heard nothing.
  // Play the REMOTE presenter's share audio here (never the local one — that
  // would echo). The presenter mutes/unmutes it with the button below.
  const shareAudioTrack: MediaStreamTrack | undefined = participant?.screenShareTracks?.audio;
  useEffect(() => {
    const el = shareAudioRef.current;
    if (!el || isSelf) return;
    if (shareAudioTrack) {
      el.srcObject = new MediaStream([shareAudioTrack]);
      el.play().catch(() => { /* autoplay blocked / already playing */ });
    } else {
      el.srcObject = null;
    }
  }, [isSelf, shareAudioTrack]);

  // Presenter-side local mute of their own shared audio (toggles track.enabled,
  // which makes every viewer hear silence without stopping the share).
  const [audioMuted, setAudioMuted] = useState(false);
  useEffect(() => {
    if (shareAudioTrack) setAudioMuted(!shareAudioTrack.enabled);
  }, [shareAudioTrack]);
  const toggleShareAudio = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!shareAudioTrack) return;
    shareAudioTrack.enabled = !shareAudioTrack.enabled;
    setAudioMuted(!shareAudioTrack.enabled);
  }, [shareAudioTrack]);

  // ─── Zoom + pan ─────────────────────────────────────────────────────────────
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const zoomed = view.scale > 1;

  // Native, non-passive wheel listener — React's onWheel is passive, so calling
  // preventDefault() there warns and doesn't stop the page from scrolling.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      setView((v) => {
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const scale = clampNum(v.scale * factor, 1, SCREEN_MAX_SCALE);
        if (scale === 1) return { scale: 1, x: 0, y: 0 };
        // Keep the content point under the cursor fixed while zooming.
        const efx = (cx - v.x) / v.scale;
        const efy = (cy - v.y) / v.scale;
        const { x, y } = clampScreenOffset(cx - scale * efx, cy - scale * efy, scale, rect.width, rect.height);
        return { scale, x, y };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (view.scale <= 1) return;
    if ((e.target as HTMLElement).closest('button')) return; // let overlay buttons click
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const el = containerRef.current;
    if (!d || !el) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
    const rect = el.getBoundingClientRect();
    setView((v) => {
      const { x, y } = clampScreenOffset(d.ox + dx, d.oy + dy, v.scale, rect.width, rect.height);
      return { ...v, x, y };
    });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
    setDragging(false);
  };
  const handleClick = () => {
    // When zoomed you're "inspecting" — clicks pan/idle, they don't toggle
    // focus. Also swallow the click that ends a drag.
    if (zoomed || dragRef.current?.moved) return;
    onClick?.();
  };
  const resetZoom = (e: React.MouseEvent) => {
    e.stopPropagation();
    setView({ scale: 1, x: 0, y: 0 });
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative flex items-center justify-center rounded-lg overflow-hidden bg-black h-full w-full [container-type:size]',
        onClick && !zoomed && 'cursor-pointer',
        focused && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
      )}
      onClick={handleClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(e) => { e.stopPropagation(); setView({ scale: 1, x: 0, y: 0 }); }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="w-full h-full object-contain select-none"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          transformOrigin: 'center center',
          transition: dragging ? 'none' : 'transform 90ms ease-out',
          cursor: zoomed ? (dragging ? 'grabbing' : 'grab') : undefined,
        }}
      />

      {/* Remote presenter's screen-share audio (never the local one — echo). */}
      {!isSelf && shareAudioTrack && <audio ref={shareAudioRef} autoPlay />}

      {/* Zoom badge + reset — only while zoomed in. */}
      {zoomed && (
        <div className="absolute top-2 left-2 z-10 flex items-center gap-1">
          <span className="flex items-center gap-1 rounded-md bg-black/60 px-2 py-1 text-[11px] font-medium text-white">
            <ZoomIn className="h-3.5 w-3.5" />
            {Math.round(view.scale * 100)}%
          </span>
          <button
            onClick={resetZoom}
            title="Reset zoom"
            className="flex items-center justify-center rounded-md bg-black/60 hover:bg-black/80 p-1.5 text-white transition-colors"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Presenter: mute/unmute the audio shared alongside the screen. */}
      {isSelf && shareAudioTrack && (
        <button
          onClick={toggleShareAudio}
          title={audioMuted ? 'Unmute shared audio' : 'Mute shared audio'}
          className={cn(
            'absolute top-2 right-2 z-10 flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-medium text-white transition-colors',
            audioMuted ? 'bg-red-500/80 hover:bg-red-500' : 'bg-black/60 hover:bg-black/80',
          )}
        >
          {audioMuted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
          {audioMuted ? 'Audio muted' : 'Audio on'}
        </button>
      )}

      {/* Label — same pill design/sizing as the participant name tags, with a
          leading screen icon. */}
      <ParticipantNameTag
        name={isSelf ? 'You are presenting' : `${name}'s screen`}
        icon={<Monitor className="h-3.5 w-3.5 flex-shrink-0" />}
      />
    </div>
  );
}
