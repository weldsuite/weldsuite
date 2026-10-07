import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ParticipantTile, ScreenShareTile } from './participant-tile';
import { useIsMobile } from '../hooks/use-is-mobile';
import { useSpeakerOutput } from '../hooks/use-speaker-output';
import { CallControlsBar } from './call-controls-bar';
import { MeetingHeader } from './meeting-header';
import { MeetingRightPanel, type RightPanelKind } from './meeting-right-panel';
import { ShareLinkCard } from './share-link-card';
import { AdmitGuestsPill } from './admit-guests-pill';
import { StageIndicators } from './tools/stage-indicators';
import { filterBreakoutParticipants } from '../tools/tools-store';
import { useMeetingToolsController } from '../tools/use-meeting-tools-controller';
import type { MeetingRoomViewProps, ViewMode, MeetingPeer } from '../types';

/**
 * Audio-only playback for a single remote participant.
 *
 * Remote sound is normally emitted by the `<audio>` element inside each
 * `ParticipantTile`. Some layouts (e.g. spotlight + screen-share) intentionally
 * hide every camera tile, which unmounts those elements and silences the call.
 * Rendering this hidden sink in such layouts keeps each remote participant
 * audible regardless of what's on screen.
 */
function RemoteParticipantAudio({ participant }: { participant: MeetingPeer }) {
  const ref = useRef<HTMLAudioElement>(null);
  useSpeakerOutput(ref);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (participant.audioEnabled && participant.audioTrack) {
      el.srcObject = new MediaStream([participant.audioTrack]);
      // `autoPlay` only kicks in on the element's first mount; switching layout
      // mounts a fresh element, so call play() explicitly to resume the stream
      // (mirrors the per-tile audio fix).
      el.play().catch(() => { /* autoplay blocked / already playing */ });
    } else {
      el.srcObject = null;
    }
  }, [participant.audioEnabled, participant.audioTrack]);
  return <audio ref={ref} autoPlay />;
}

// ─── Shared layout helpers ───────────────────────────────────────────────────

/** A participant plus whether it is the local peer (always first in the list). */
interface Entry {
  p: MeetingPeer;
  isSelf: boolean;
}

/** Everything a tile needs from the room, bundled so layouts stay small. */
interface TileContext {
  meeting: MeetingRoomViewProps['meeting'];
  handRaised: boolean;
  handRaisedParticipants: Set<string> | undefined;
  onTogglePin: (id: string) => void;
  onClickParticipantDetails: MeetingRoomViewProps['onClickParticipantDetails'];
  selfColorSeed: string | undefined;
  isOrganizer: boolean;
  onRemoveParticipant: MeetingRoomViewProps['onRemoveParticipant'];
}

/** A camera tile wired to the room's pin / details / hand-raise state. */
function CameraTile({ ctx, entry, pinned }: { ctx: TileContext; entry: Entry; pinned?: boolean }) {
  const { p, isSelf } = entry;
  return (
    <ParticipantTile
      participant={p}
      isSelf={isSelf}
      isHandRaised={isSelf ? ctx.handRaised : ctx.handRaisedParticipants?.has(p.id)}
      meeting={ctx.meeting}
      pinned={pinned}
      onTogglePin={ctx.onTogglePin}
      onClickDetails={ctx.onClickParticipantDetails}
      colorSeed={isSelf ? ctx.selfColorSeed : undefined}
      canManageParticipants={ctx.isOrganizer}
      onRemoveParticipant={ctx.onRemoveParticipant}
    />
  );
}

/** A screen-share tile; `interactive` tiles toggle focus (`<id>-screen`) on click. */
function ScreenTile({
  ctx,
  entry,
  interactive = false,
  focused,
}: {
  ctx: TileContext;
  entry: Entry;
  interactive?: boolean;
  focused?: boolean;
}) {
  const { p, isSelf } = entry;
  return (
    <ScreenShareTile
      participant={p}
      isSelf={isSelf}
      meeting={ctx.meeting}
      focused={focused}
      onClick={interactive ? () => ctx.onTogglePin(`${p.id}-screen`) : undefined}
    />
  );
}

function gridColsClass(totalTiles: number): string {
  if (totalTiles <= 1) return 'grid-cols-1';
  if (totalTiles <= 4) return 'grid-cols-2';
  return 'grid-cols-3';
}

/**
 * Resolve effective gating: when host management is on AND the viewer is not
 * the organizer, the policy hides / disables specific controls.
 */
function resolveGates(hostControls: MeetingRoomViewProps['hostControls'], isOrganizer: boolean) {
  const enforce = !!hostControls?.hostManagement && !isOrganizer;
  return {
    screenShare: !enforce || hostControls?.allowScreenShare !== false,
    micToggle: !enforce || hostControls?.allowMicrophone !== false,
    videoToggle: !enforce || hostControls?.allowVideo !== false,
    handRaise: !enforce || hostControls?.allowHandRaise !== false,
    virtualBackgrounds: !enforce || hostControls?.allowVirtualBackgrounds !== false,
    record: isOrganizer || hostControls?.allowParticipantRecord === true,
  };
}

/**
 * Manual focus — clicking any tile (camera OR screen) promotes it to the main
 * stage; clicking it again returns to the grid. `pinnedId` holds either a
 * participant id or a screen-share id (`<id>-screen`).
 */
function resolvePinTargets(pinnedId: string | null, screenShareEntries: Entry[], allParticipants: Entry[]) {
  if (!pinnedId) return { focusedScreen: null, pinnedParticipant: null };
  const focusedScreen = screenShareEntries.find(({ p }) => `${p.id}-screen` === pinnedId) ?? null;
  if (focusedScreen) return { focusedScreen, pinnedParticipant: null };
  const pinnedParticipant = allParticipants.find(({ p }) => p.id === pinnedId) ?? null;
  return { focusedScreen: null, pinnedParticipant };
}

interface FocusInputs {
  focusedScreen: Entry | null;
  pinnedParticipant: Entry | null;
  allParticipants: Entry[];
  viewMode: ViewMode;
  activeSpeakerId: string | null;
}

/**
 * Camera focus = an explicit pin OR an auto-focus driven by the view mode.
 * A focused screen always takes the stage, so suppress camera focus while a
 * screen is focused.
 *   • spotlight / sidebar — statically focus the first remote participant.
 *   • speaker — dynamically follow the active speaker, falling back to the
 *     first remote until anyone has spoken (or if the active speaker has
 *     left and isn't in the current participant list).
 */
function resolveFocusedParticipant({
  focusedScreen,
  pinnedParticipant,
  allParticipants,
  viewMode,
  activeSpeakerId,
}: FocusInputs): Entry | null {
  if (focusedScreen) return null;
  if (pinnedParticipant) return pinnedParticipant;
  // The host app always hands us the local peer first, remotes after it.
  const firstRemote = allParticipants[1]?.p;
  if (allParticipants.length <= 1 || !firstRemote) return null;
  if (viewMode === 'speaker') {
    const active = activeSpeakerId
      ? allParticipants.find(({ p }) => p.id === activeSpeakerId)
      : null;
    return active ?? { p: firstRemote, isSelf: false };
  }
  if (viewMode === 'spotlight' || viewMode === 'sidebar') {
    return { p: firstRemote, isSelf: false };
  }
  return null;
}

// ─── Stage layouts ───────────────────────────────────────────────────────────

interface LayoutProps {
  ctx: TileContext;
  allParticipants: Entry[];
  screenShareEntries: Entry[];
}

/**
 * ── Focused screen (explicit click) ───────────────────────────────
 * The clicked screen fills the main area; every camera tile and any
 * other shared screen drop into a strip below. Clicking the big
 * screen (or its strip thumbnail) toggles focus back off.
 */
function FocusedScreenLayout({
  ctx,
  focusedScreen,
  screenShareEntries,
  allParticipants,
}: LayoutProps & { focusedScreen: Entry }) {
  const otherScreens = screenShareEntries.filter(({ p }) => p.id !== focusedScreen.p.id);
  return (
    <div className="flex flex-col gap-2 p-4 h-full">
      <div className="flex-1 min-h-0 rounded-xl overflow-hidden bg-[#1a1a1a]">
        <ScreenTile ctx={ctx} entry={focusedScreen} interactive focused />
      </div>
      <div className="flex gap-2 h-[160px] flex-shrink-0 overflow-x-auto overflow-y-hidden p-1">
        {otherScreens.map((entry) => (
          <div key={`${entry.p.id}-screen`} className="w-[240px] flex-shrink-0 rounded-xl overflow-hidden bg-[#1a1a1a]">
            <ScreenTile ctx={ctx} entry={entry} interactive />
          </div>
        ))}
        {allParticipants.map((entry) => (
          <div key={entry.p.id} className="w-[240px] flex-shrink-0">
            <CameraTile ctx={ctx} entry={entry} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Camera-focus layout — one big tile plus a strip of everyone else. Used both
 * for an explicit pin and the spotlight/sidebar viewMode auto-focus, so the
 * markup lives in one place.
 */
function CameraFocusLayout({
  ctx,
  focused,
  allParticipants,
  viewMode,
  pinnedParticipantId,
}: {
  ctx: TileContext;
  focused: Entry;
  allParticipants: Entry[];
  viewMode: ViewMode;
  pinnedParticipantId: string | undefined;
}) {
  const others = allParticipants.filter(({ p }) => p.id !== focused.p.id);
  const mainTile = (
    <CameraTile ctx={ctx} entry={focused} pinned={pinnedParticipantId === focused.p.id} />
  );

  if (viewMode === 'sidebar') {
    return (
      <div className="flex gap-2 p-4 h-full">
        <div className="flex-1 min-w-0">{mainTile}</div>
        {others.length > 0 && (
          <div className="flex flex-col gap-2 w-[240px] flex-shrink-0 overflow-y-auto overflow-x-hidden p-1">
            {others.map((entry) => (
              <div key={entry.p.id} className="h-[140px] flex-shrink-0">
                <CameraTile ctx={ctx} entry={entry} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-4 h-full">
      <div className="flex-1 min-h-0">{mainTile}</div>
      {others.length > 0 && (
        <div className="flex gap-2 h-[160px] flex-shrink-0 overflow-x-auto overflow-y-hidden p-1">
          {others.map((entry) => (
            <div key={entry.p.id} className="w-[240px] flex-shrink-0">
              <CameraTile ctx={ctx} entry={entry} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * ── Solo presenter layout ─────────────────────────────────────────
 * Mirrors Google Meet's "you are the only one in this call" presenter
 * view: the shared screen fills the entire main area and the local
 * camera floats as a small PiP in the bottom-right corner.
 *
 * This layout is chosen BEFORE the viewMode layouts so it overrides
 * Auto / Sidebar / Spotlight / Tiled when alone + sharing.
 * The PiP is hidden when the local camera is off (isVideoOff).
 */
function SoloPresenterLayout({
  ctx,
  selfPeer,
  isVideoOff,
}: {
  ctx: TileContext;
  selfPeer: MeetingPeer;
  isVideoOff: boolean;
}) {
  return (
    <div className="relative h-full w-full p-3">
      {/* Shared screen — full area (inside the p-3 wrapper so it
          matches the inset of every other layout). */}
      <div className="relative h-full w-full rounded-xl overflow-hidden bg-[#1a1a1a]">
        <ScreenTile ctx={ctx} entry={{ p: selfPeer, isSelf: true }} />

        {/* Local camera PiP — bottom-right, hidden when video is off */}
        {!isVideoOff && (
          <div className="absolute bottom-4 right-4 z-10 w-[300px] h-[195px] rounded-lg shadow-lg overflow-hidden ring-1 ring-white/20">
            <ParticipantTile
              participant={selfPeer}
              isSelf
              isHandRaised={ctx.handRaised}
              meeting={ctx.meeting}
              colorSeed={ctx.selfColorSeed}
              canManageParticipants={ctx.isOrganizer}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * ── Presenter layout (Sidebar / Speaker) ─────────────────────────
 * Mirrors Google Meet's default / sidebar presenter view:
 *   • Wide (≥ 768px): shared content fills the main area; participant
 *     cameras sit in a vertical strip on the right (180px, scrollable).
 *   • Narrow (< 768px): participant strip moves to the top as a
 *     horizontal scrolling row; shared content takes the rest.
 *
 * Active when viewMode is 'sidebar' OR 'speaker' AND a share is live
 * (during a share the speaker stays visible in the strip alongside
 * the shared content). Grid falls into the normal grid; Spotlight
 * renders the share full-bleed below.
 */
function PresenterLayout({ ctx, allParticipants, screenShareEntries }: LayoutProps) {
  return (
    <div className="flex max-md:flex-col-reverse gap-2 p-3 h-full">
      {/* Main share area */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-2">
        {screenShareEntries.map((entry) => (
          <div key={`${entry.p.id}-screen`} className="flex-1 min-h-0 rounded-xl overflow-hidden bg-[#1a1a1a]">
            <ScreenTile ctx={ctx} entry={entry} />
          </div>
        ))}
      </div>

      {/* Participant strip — vertical on wide, horizontal on narrow */}
      <div
        className={[
          'flex-shrink-0 overflow-auto p-1',
          // Wide: vertical strip on the right
          'md:flex-col md:w-[180px] md:max-h-full md:overflow-y-auto md:overflow-x-hidden',
          // Narrow: horizontal row on top
          'max-md:flex-row max-md:h-[120px] max-md:w-full max-md:overflow-x-auto max-md:overflow-y-hidden',
          'flex gap-2',
        ].join(' ')}
      >
        {allParticipants.map((entry) => (
          <div
            key={entry.p.id}
            className="flex-shrink-0 md:h-[120px] md:w-full max-md:h-full max-md:w-[160px]"
          >
            <CameraTile ctx={ctx} entry={entry} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * ── Spotlight + share: full-area share only ───────────────────────
 * Mirrors Google Meet's spotlight behaviour: when the user has chosen
 * Spotlight and someone is sharing, only the share tile(s) are shown
 * — participant cameras are hidden entirely. If multiple people share
 * simultaneously each share tile stacks vertically.
 */
function SpotlightShareLayout({ ctx, allParticipants, screenShareEntries }: LayoutProps) {
  return (
    <div className="flex flex-col gap-2 p-3 h-full">
      {screenShareEntries.map((entry) => (
        <div key={`${entry.p.id}-screen`} className="flex-1 min-h-0 rounded-xl overflow-hidden bg-[#1a1a1a]">
          <ScreenTile ctx={ctx} entry={entry} />
        </div>
      ))}
      {/* This layout hides every camera tile, which would unmount each
          participant's <audio>. Keep remote audio alive with a hidden
          sink so the user still hears everyone while watching a screen. */}
      <div className="sr-only" aria-hidden>
        {allParticipants
          .filter(({ isSelf }) => !isSelf)
          .map(({ p }) => (
            <RemoteParticipantAudio key={p.id} participant={p} />
          ))}
      </div>
    </div>
  );
}

/**
 * Mobile in-call grid — mirrors the Google Meet phone layout:
 *   • 1–4 tiles  → single stacked column (one under another)
 *   • 5–8 tiles  → 2 columns (max 4 rows)
 *   • > 8 tiles  → only the first 8 are shown; the 8th carries an "N others"
 *                  badge so the user knows more participants are present.
 */
const MOBILE_MAX_TILES = 8;
function MobileGridLayout({ ctx, allParticipants, screenShareEntries }: LayoutProps) {
  const tiles: Array<{ key: string; node: ReactNode }> = [
    ...screenShareEntries.map((entry) => ({
      key: `${entry.p.id}-screen`,
      node: (
        <div className="rounded-xl overflow-hidden bg-[#1a1a1a] h-full w-full">
          <ScreenTile ctx={ctx} entry={entry} interactive />
        </div>
      ),
    })),
    ...allParticipants.map((entry) => ({
      key: entry.p.id,
      node: <CameraTile ctx={ctx} entry={entry} />,
    })),
  ];

  const overflow = tiles.length - MOBILE_MAX_TILES;
  const shown = overflow > 0 ? tiles.slice(0, MOBILE_MAX_TILES) : tiles;
  const cols = shown.length <= 4 ? 'grid-cols-1' : 'grid-cols-2';

  return (
    <div className={`grid ${cols} gap-2 p-4 h-full auto-rows-fr`}>
      {shown.map((t, i) => {
        const showBadge = overflow > 0 && i === shown.length - 1;
        return (
          <div key={t.key} className="relative min-h-0 h-full w-full">
            {t.node}
            {showBadge && (
              <div className="absolute top-2 right-2 z-10 rounded-[7px] bg-black/70 px-3 py-1 text-[13px] font-medium text-white backdrop-blur pointer-events-none">
                {overflow} {overflow === 1 ? 'other' : 'others'}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Plain tiled grid: screen shares first, then every camera tile. */
function TiledGridLayout({ ctx, allParticipants, screenShareEntries }: LayoutProps) {
  // Total grid cells = normal participant tiles + screen-share tiles.
  const gridCols = gridColsClass(allParticipants.length + screenShareEntries.length);
  return (
    <div className={`grid ${gridCols} gap-2 p-4 h-full auto-rows-fr`}>
      {screenShareEntries.map((entry) => (
        <div key={`${entry.p.id}-screen`} className="rounded-xl overflow-hidden bg-[#1a1a1a]">
          <ScreenTile ctx={ctx} entry={entry} interactive />
        </div>
      ))}
      {allParticipants.map((entry) => (
        <CameraTile key={entry.p.id} ctx={ctx} entry={entry} />
      ))}
    </div>
  );
}

interface StageLayoutProps extends LayoutProps {
  focusedScreen: Entry | null;
  pinnedParticipant: Entry | null;
  focusedParticipant: Entry | null;
  viewMode: ViewMode;
  isMobile: boolean;
  isVideoOff: boolean;
}

/** Layouts used while somebody is sharing their screen and nothing is pinned. */
function resolveScreenShareStage(props: StageLayoutProps): ReactNode | null {
  const { ctx, allParticipants, screenShareEntries, viewMode, isVideoOff } = props;
  // The host app always hands us the local peer first, remotes after it.
  const selfPeer = allParticipants[0]?.p;
  if (allParticipants.length === 1 && selfPeer) {
    return <SoloPresenterLayout ctx={ctx} selfPeer={selfPeer} isVideoOff={isVideoOff} />;
  }
  if (viewMode === 'sidebar' || viewMode === 'speaker') {
    return <PresenterLayout ctx={ctx} allParticipants={allParticipants} screenShareEntries={screenShareEntries} />;
  }
  if (viewMode === 'spotlight') {
    return <SpotlightShareLayout ctx={ctx} allParticipants={allParticipants} screenShareEntries={screenShareEntries} />;
  }
  return null;
}

/**
 * Picks the stage layout. When anyone is sharing their screen, a Google-Meet-
 * style presenter layout is forced regardless of the user's selected viewMode
 * (the shared screen fills the main area; camera tiles move into a compact
 * strip). This is a temporary override — when sharing stops, the user's
 * viewMode is restored automatically.
 */
function StageLayout(props: StageLayoutProps) {
  const { ctx, allParticipants, screenShareEntries, focusedScreen, pinnedParticipant, focusedParticipant, viewMode, isMobile } = props;
  if (focusedScreen) {
    return (
      <FocusedScreenLayout
        ctx={ctx}
        focusedScreen={focusedScreen}
        screenShareEntries={screenShareEntries}
        allParticipants={allParticipants}
      />
    );
  }
  const cameraFocus = (focused: Entry) => (
    <CameraFocusLayout
      ctx={ctx}
      focused={focused}
      allParticipants={allParticipants}
      viewMode={viewMode}
      pinnedParticipantId={pinnedParticipant?.p.id}
    />
  );
  // An explicit camera pin wins over the auto screen-share presenter.
  if (pinnedParticipant) return cameraFocus(pinnedParticipant);

  const screenShareStage = screenShareEntries.length > 0 ? resolveScreenShareStage(props) : null;
  if (screenShareStage) return screenShareStage;

  if (focusedParticipant) return cameraFocus(focusedParticipant);
  if (isMobile) {
    return <MobileGridLayout ctx={ctx} allParticipants={allParticipants} screenShareEntries={screenShareEntries} />;
  }
  return <TiledGridLayout ctx={ctx} allParticipants={allParticipants} screenShareEntries={screenShareEntries} />;
}

/** Live captions overlay (last two lines). */
function CaptionsOverlay({ captions }: { captions: NonNullable<MeetingRoomViewProps['captions']> }) {
  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 max-w-[80%] pointer-events-none">
      <div className="rounded-2xl bg-black/70 px-4 py-2 text-white backdrop-blur shadow-lg ring-1 ring-white/10">
        {captions.slice(-2).map((c) => (
          <div key={c.id} className="text-[13px] leading-snug">
            <span className="text-white/60 mr-2">{c.speakerName}:</span>
            <span className={c.isPartial ? 'opacity-80' : ''}>{c.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Wraps the room in a fixed full-screen overlay when fullscreen is on. */
function FullscreenFrame({
  isFullscreen,
  rightReservation,
  children,
}: {
  isFullscreen?: boolean;
  rightReservation: number;
  children: ReactNode;
}) {
  if (!isFullscreen) return <>{children}</>;
  return (
    <div
      className="fixed inset-0 z-50 flex bg-background transition-[right] duration-200"
      style={rightReservation > 0 ? { right: `${rightReservation}px` } : undefined}
    >
      {children}
    </div>
  );
}

/**
 * Pure presentational meeting-room view.
 *
 * Both the platform's signed-in weldmeet experience and the meeting-portal's
 * guest experience render this same component — design changes here flow to
 * both apps.
 */
export function MeetingRoomView(props: MeetingRoomViewProps) {
  const {
    meeting,
    meetingTitle,
    joinCode,
    shareUrl,
    description,
    scheduledStart,
    participants,
    waitlistedCount = 0,
    isMuted,
    isVideoOff,
    micBlocked,
    cameraBlocked,
    permissionHelpLabels,
    isScreenSharing,
    handRaised,
    handRaisedParticipants,
    duration,
    isOrganizer,
    viewMode,
    isFullscreen,
    toggleMute,
    toggleVideo,
    startScreenShare,
    stopScreenShare,
    toggleHandRaise,
    setViewMode,
    onLeave,
    onEndForAll,
    leaveLabels,
    onToggleFullscreen,
    onPictureInPicture,
    onRenameMeeting,
    isRecording,
    recordingState,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    showControlBarRecording = true,
    recordingStartElapsedSeconds,
    recordingLabels,
    onToggleEffects,
    effectsOpen,
    backgroundType,
    backgroundEffectsSlot,
    chatPanelSlot,
    showChatButton: showChatButtonProp,
    showInfoButton = true,
    showPeopleButton = true,
    showHostControlsButton = true,
    showToolsButton = true,
    toolsLabels,
    peoplePanelSlot,
    hostControlsSlot,
    addPeopleDialogContent,
    onClickParticipantDetails,
    onRemoveParticipant,
    selfColorSeed,
    externalPanelOpen = false,
    onActivatePanel,
    onInternalPanelChange,
    hostControls,
    captions,
    rightReservation = 0,
    pinnedId: controlledPinnedId,
    onTogglePin: onTogglePinProp,
  } = props;

  const isMobile = useIsMobile();

  const gate = resolveGates(hostControls, isOrganizer);

  // Mid-call enforcement: when the host flips a permission OFF while a
  // non-organizer is using it, immediately stop the offending activity on
  // the local client. Mic + video stop are pushed by the host directly via
  // RTK's disableAllAudio/disableAllVideo (called inline from the host's
  // toggle in HostControlsPanel), so we only have to self-stop screen-share
  // and hand-raise locally.
  useEffect(() => {
    if (!gate.screenShare && isScreenSharing) {
      try { stopScreenShare(); } catch { /* ignore */ }
    }
  }, [gate.screenShare, isScreenSharing, stopScreenShare]);
  useEffect(() => {
    if (!gate.handRaise && handRaised) {
      try { toggleHandRaise(); } catch { /* ignore */ }
    }
  }, [gate.handRaise, handRaised, toggleHandRaise]);

  // Pin can be *controlled* by the host app (so it survives this component
  // being remounted across mount points, e.g. inline ↔ fullscreen overlay) or
  // fall back to internal state when the host doesn't manage it.
  const isPinControlled = onTogglePinProp !== undefined;
  const [internalPinnedId, setInternalPinnedId] = useState<string | null>(null);
  const pinnedId = isPinControlled ? (controlledPinnedId ?? null) : internalPinnedId;
  // Active-speaker tracking — drives the "Speaker" view. RTK computes a
  // server-side dominant speaker and persists the last one in
  // `participants.lastActiveSpeaker` (a peer id), firing `activeSpeaker` on
  // each change. Unlike Spotlight (which statically focuses the first remote),
  // Speaker view re-focuses the big tile on whoever is currently talking. The
  // value never goes empty between turns, so the focus doesn't flicker.
  const [activeSpeakerId, setActiveSpeakerId] = useState<string | null>(null);
  const [rightPanel, setRightPanel] = useState<RightPanelKind>(null);
  const [showChat, setShowChat] = useState(false);
  const [skipTransition, setSkipTransition] = useState(false);
  // Positioned host for the chat-notification toasts — anchored in the video
  // area at the exact same corner distance as the "Your meeting's ready" card
  // (mirrored to the right). The chat panel slot portals its toasts into this.
  const [notificationHost, setNotificationHost] = useState<HTMLDivElement | null>(null);

  // When the host app opens its own side panel (e.g. WeldAgent), instantly
  // close any internal panel without animation so only one panel is visible.
  const prevExternalRef = useRef(externalPanelOpen);
  useEffect(() => {
    if (externalPanelOpen && !prevExternalRef.current) {
      if (rightPanel || showChat) {
        setSkipTransition(true);
        setRightPanel(null);
        setShowChat(false);
        requestAnimationFrame(() => setSkipTransition(false));
      }
    }
    prevExternalRef.current = externalPanelOpen;
  }, [externalPanelOpen, rightPanel, showChat]);

  // Publish internal panel state so the host app can coordinate other drawers.
  useEffect(() => {
    onInternalPanelChange?.(rightPanel !== null || showChat);
  }, [rightPanel, showChat, onInternalPanelChange]);

  // Reset the published flag on unmount so it doesn't leak across navigations.
  useEffect(() => {
    return () => onInternalPanelChange?.(false);
  }, [onInternalPanelChange]);

  // Subscribe to RTK's dominant-speaker signal. Done here (not in the host
  // adapters) so both the weldmeet and weldchat experiences get Speaker view
  // for free. `lastActiveSpeaker` seeds the initial value before any event.
  useEffect(() => {
    if (!meeting) return;
    const parts = meeting.participants;
    if (!parts) return;
    const sync = () => setActiveSpeakerId(parts.lastActiveSpeaker ?? null);
    sync();
    parts.on?.('activeSpeaker', sync);
    return () => {
      parts.off?.('activeSpeaker', sync);
    };
  }, [meeting]);

  // Timer, polls, Q&A, breakout rooms, transcript, translation, live stream.
  const openToolsPanel = useCallback(() => {
    setShowChat(false);
    setRightPanel('tools');
    // One panel at a time: ask the host app to close its own (e.g. WeldAgent).
    if (externalPanelOpen) onActivatePanel?.();
  }, [externalPanelOpen, onActivatePanel]);
  const tools = useMeetingToolsController({
    // A host app that hides the tools button (WeldChat calls) has no tools:
    // nothing is synced, and nobody in such a call could start one anyway.
    meeting: showToolsButton ? meeting : null,
    participants,
    isOrganizer,
    meetingTitle,
    labels: toolsLabels,
    captions,
    panelOpen: rightPanel === 'tools',
    onOpenPanel: openToolsPanel,
  });
  const captionLines = tools?.captions ?? captions ?? [];
  const showCaptions =
    (!!hostControls?.enableCaptions || !!tools?.wantsCaptions) && captionLines.length > 0;

  const toggleRightPanel = useCallback((panel: 'info' | 'people' | 'settings' | 'tools') => {
    const isSwitching = showChat || externalPanelOpen;
    if (isSwitching) setSkipTransition(true);
    setRightPanel(prev => prev === panel ? null : panel);
    setShowChat(false);
    if (externalPanelOpen) onActivatePanel?.();
    if (isSwitching) requestAnimationFrame(() => setSkipTransition(false));
  }, [showChat, externalPanelOpen, onActivatePanel]);

  const handleTogglePin = useCallback((id: string) => {
    if (onTogglePinProp) onTogglePinProp(id);
    else setInternalPinnedId(prev => prev === id ? null : id);
  }, [onTogglePinProp]);

  // While breakout rooms are open the stage only holds the people in the
  // local participant's room; a tile that is not rendered is not heard either.
  const stageParticipants = tools ? filterBreakoutParticipants(tools.state.breakout, participants) : participants;
  const allParticipants = stageParticipants.map((p, i) => ({ p, isSelf: i === 0 }));

  // Derive screen-share pseudo-tiles from any participant (self or remote)
  // that currently has an active screen-share track.  RTK exposes
  // `participant.screenShareEnabled` and `participant.screenShareTracks.video`
  // on both `self` (participants[0]) and remote Participant objects.
  // We key these tiles as `<participantId>-screen` so they have stable React keys.
  const screenShareEntries = allParticipants.filter(
    ({ p }) => p?.screenShareEnabled && p?.screenShareTracks?.video,
  );

  const { focusedScreen, pinnedParticipant } = resolvePinTargets(pinnedId, screenShareEntries, allParticipants);
  const focusedParticipant = resolveFocusedParticipant({
    focusedScreen,
    pinnedParticipant,
    allParticipants,
    viewMode,
    activeSpeakerId,
  });

  const showChatButton = showChatButtonProp ?? !!chatPanelSlot;

  const tileContext: TileContext = {
    meeting,
    handRaised,
    handRaisedParticipants,
    onTogglePin: handleTogglePin,
    onClickParticipantDetails,
    selfColorSeed,
    isOrganizer,
    onRemoveParticipant,
  };

  const handleToggleChat = () => {
    const willOpen = !showChat;
    const isSwitching = !!rightPanel || externalPanelOpen;
    if (isSwitching) setSkipTransition(true);
    setShowChat(v => !v);
    setRightPanel(null);
    if (willOpen && externalPanelOpen) onActivatePanel?.();
    if (isSwitching) requestAnimationFrame(() => setSkipTransition(false));
  };

  const controlBarRecording = gate.record && showControlBarRecording
    ? { startRecording, stopRecording, pauseRecording, resumeRecording }
    : {};
  const rightPanelRecording = isOrganizer ? { startRecording, stopRecording } : {};

  const content = (
    <div className="relative flex-1 flex min-h-0 bg-background">
      <div className="flex-1 flex flex-col min-w-0">
        <MeetingHeader
          meetingTitle={meetingTitle}
          duration={duration}
          isRecording={isRecording}
          recordingState={recordingState}
          recordingStartElapsedSeconds={recordingStartElapsedSeconds}
          recordingLabels={recordingLabels}
          waitlistedCount={waitlistedCount}
          participantsCount={participants.length}
          rightPanel={rightPanel}
          showChat={showChat}
          onToggleRightPanel={toggleRightPanel}
          onToggleChat={handleToggleChat}
          onRenameMeeting={onRenameMeeting}
          showInfoButton={showInfoButton}
          showPeopleButton={showPeopleButton}
          showChatButton={showChatButton}
          showHostControlsButton={showHostControlsButton}
          showToolsButton={showToolsButton}
        />

        <div className="flex-1 min-h-0 overflow-hidden relative">
          <StageLayout
            ctx={tileContext}
            allParticipants={allParticipants}
            screenShareEntries={screenShareEntries}
            focusedScreen={focusedScreen}
            pinnedParticipant={pinnedParticipant}
            focusedParticipant={focusedParticipant}
            viewMode={viewMode}
            isMobile={isMobile}
            isVideoOff={isVideoOff}
          />

          {shareUrl && <ShareLinkCard shareUrl={shareUrl} addPeopleDialogContent={addPeopleDialogContent} />}

          {/* Chat-notification host — mirrors ShareLinkCard's bottom-6/left-6
              corner distance on the right edge. Toasts portal in here. */}
          <div
            ref={setNotificationHost}
            className="absolute bottom-6 right-6 z-10 flex flex-col items-end gap-2 pointer-events-none"
          />

          {meeting && <AdmitGuestsPill meeting={meeting} />}

          {tools && <StageIndicators tools={tools} />}

          {showCaptions && <CaptionsOverlay captions={captionLines} />}
        </div>

        <CallControlsBar
          meeting={meeting}
          isMuted={isMuted}
          isVideoOff={isVideoOff}
          micBlocked={micBlocked}
          cameraBlocked={cameraBlocked}
          permissionHelpLabels={permissionHelpLabels}
          isScreenSharing={isScreenSharing}
          handRaised={handRaised}
          viewMode={viewMode}
          toggleMute={toggleMute}
          toggleVideo={toggleVideo}
          startScreenShare={startScreenShare}
          stopScreenShare={stopScreenShare}
          toggleHandRaise={toggleHandRaise}
          setViewMode={setViewMode}
          onLeave={onLeave}
          onEndForAll={onEndForAll}
          leaveLabels={leaveLabels}
          onToggleEffects={onToggleEffects}
          effectsOpen={effectsOpen}
          backgroundType={backgroundType}
          isRecording={isRecording}
          recordingState={recordingState}
          {...controlBarRecording}
          isFullscreen={isFullscreen}
          onToggleFullscreen={onToggleFullscreen}
          onPictureInPicture={onPictureInPicture}
          onOpenSettings={showHostControlsButton ? () => toggleRightPanel('settings') : undefined}
          gates={{
            screenShare: gate.screenShare,
            handRaise: gate.handRaise,
            virtualBackgrounds: gate.virtualBackgrounds,
          }}
        />
      </div>

      <MeetingRightPanel
        panel={rightPanel}
        onClose={() => setRightPanel(null)}
        meetingTitle={meetingTitle}
        joinCode={joinCode}
        shareUrl={shareUrl}
        description={description}
        scheduledStart={scheduledStart}
        participants={participants}
        meeting={meeting}
        skipTransition={skipTransition}
        peoplePanelSlot={peoplePanelSlot}
        hostControlsSlot={hostControlsSlot}
        onClickParticipantDetails={onClickParticipantDetails}
        isRecording={isRecording}
        recordingState={recordingState}
        {...rightPanelRecording}
        recordingStartElapsedSeconds={recordingStartElapsedSeconds}
        recordingLabels={recordingLabels}
        recordingAvailable={isOrganizer}
        tools={tools}
      />

      {chatPanelSlot?.({ isOpen: showChat, onClose: () => setShowChat(false), onOpen: () => setShowChat(true), notificationHost, skipTransition })}
      {backgroundEffectsSlot}
    </div>
  );

  return (
    <FullscreenFrame isFullscreen={isFullscreen} rightReservation={rightReservation}>
      {content}
    </FullscreenFrame>
  );
}
