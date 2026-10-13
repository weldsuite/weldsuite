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
function RemoteParticipantAudio({ participant }: Readonly<{ participant: MeetingPeer }>) {
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
function CameraTile({ ctx, entry, pinned }: Readonly<{ ctx: TileContext; entry: Entry; pinned?: boolean }>) {
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
}: Readonly<{
  ctx: TileContext;
  entry: Entry;
  interactive?: boolean;
  focused?: boolean;
}>) {
  const { p, isSelf } = entry;
  return (
    <ScreenShareTile
      participant={p}
      isSelf={isSelf}
      focused={focused}
      onClick={interactive ? () => ctx.onTogglePin(`${p.id}-screen`) : undefined}
    />
  );
}

/** The row of thumbnails under a focused tile: compact on phones. */
const STRIP_CLASS = 'flex gap-2 h-[96px] md:h-[160px] flex-shrink-0 overflow-x-auto overflow-y-hidden p-1';
const STRIP_TILE_CLASS = 'w-[128px] md:w-[240px] flex-shrink-0';


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
    <div className="flex flex-col gap-2 p-2 md:p-4 h-full">
      <div className="flex-1 min-h-0 rounded-xl overflow-hidden bg-[#1a1a1a]">
        <ScreenTile ctx={ctx} entry={focusedScreen} interactive focused />
      </div>
      <div className={STRIP_CLASS}>
        {otherScreens.map((entry) => (
          <div key={`${entry.p.id}-screen`} className={`${STRIP_TILE_CLASS} rounded-xl overflow-hidden bg-[#1a1a1a]`}>
            <ScreenTile ctx={ctx} entry={entry} interactive />
          </div>
        ))}
        {allParticipants.map((entry) => (
          <div key={entry.p.id} className={STRIP_TILE_CLASS}>
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
  isMobile,
}: Readonly<{
  ctx: TileContext;
  focused: Entry;
  allParticipants: Entry[];
  viewMode: ViewMode;
  pinnedParticipantId: string | undefined;
  isMobile: boolean;
}>) {
  const others = allParticipants.filter(({ p }) => p.id !== focused.p.id);
  const mainTile = (
    <CameraTile ctx={ctx} entry={focused} pinned={pinnedParticipantId === focused.p.id} />
  );

  // A phone is too narrow for a side strip: sidebar falls back to the row below.
  if (viewMode === 'sidebar' && !isMobile) {
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
    <div className="flex flex-col gap-2 p-2 md:p-4 h-full">
      <div className="flex-1 min-h-0">{mainTile}</div>
      {others.length > 0 && (
        <div className={STRIP_CLASS}>
          {others.map((entry) => (
            <div key={entry.p.id} className={STRIP_TILE_CLASS}>
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
}: Readonly<{
  ctx: TileContext;
  selfPeer: MeetingPeer;
  isVideoOff: boolean;
}>) {
  return (
    <div className="relative h-full w-full p-2 md:p-3">
      {/* Shared screen — full area (inside the padded wrapper so it
          matches the inset of every other layout). */}
      <div className="relative h-full w-full rounded-xl overflow-hidden bg-[#1a1a1a]">
        <ScreenTile ctx={ctx} entry={{ p: selfPeer, isSelf: true }} />

        {/* Local camera PiP — bottom-right, hidden when video is off */}
        {!isVideoOff && (
          <div className="absolute bottom-2 right-2 z-10 w-[132px] h-[88px] md:bottom-4 md:right-4 md:w-[300px] md:h-[195px] rounded-lg shadow-lg overflow-hidden ring-1 ring-white/20">
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
function PresenterLayout({ ctx, allParticipants, screenShareEntries }: Readonly<LayoutProps>) {
  return (
    <div className="flex max-md:flex-col-reverse gap-2 p-2 md:p-3 h-full">
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
function SpotlightShareLayout({ ctx, allParticipants, screenShareEntries }: Readonly<LayoutProps>) {
  return (
    <div className="flex flex-col gap-2 p-2 md:p-3 h-full">
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

/** The local tile floating over the stage on phones, bottom-right. Square, like every phone tile. */
const MOBILE_SELF_THUMBNAIL_CLASS =
  'absolute bottom-4 right-4 z-10 h-[104px] w-[104px] rounded-lg shadow-lg ring-1 ring-white/20';

/** Gap between phone tiles and around the grid, in px (Tailwind's `2`). */
const MOBILE_GRID_GAP = 8;

/**
 * Phone stage where every tile is a square. The tiles take the largest side
 * that fits both ways (the stage is a size container, so `cqw` / `cqh` are its
 * width and height) and the block of tiles is centred in what is left over.
 */
function MobileSquareGrid({ cols, count, children }: Readonly<{ cols: number; count: number; children: ReactNode }>) {
  const rows = Math.max(1, Math.ceil(count / cols));
  const across = `(100cqw - ${MOBILE_GRID_GAP * (cols + 1)}px) / ${cols}`;
  const down = `(100cqh - ${MOBILE_GRID_GAP * (rows + 1)}px) / ${rows}`;
  const side = `min(${across}, ${down})`;
  return (
    <div className="relative h-full w-full [container-type:size]">
      <div
        className="grid h-full w-full place-content-center"
        style={{ gap: MOBILE_GRID_GAP, gridTemplateColumns: `repeat(${cols}, ${side})`, gridAutoRows: side }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Mobile one-to-one layout, as phone call apps do it: one person takes the
 * stage and the other floats as a thumbnail in the corner. Tapping the
 * thumbnail pins that tile, which swaps the two.
 */
function MobileDuoLayout({
  ctx,
  main,
  thumbnail,
  pinned,
}: Readonly<{ ctx: TileContext; main: Entry; thumbnail: Entry; pinned: boolean }>) {
  return (
    <div className="relative h-full w-full">
      <MobileSquareGrid cols={1} count={1}>
        <CameraTile ctx={ctx} entry={main} pinned={pinned} />
      </MobileSquareGrid>
      <div className={MOBILE_SELF_THUMBNAIL_CLASS}>
        <CameraTile ctx={ctx} entry={thumbnail} />
      </div>
    </div>
  );
}

/**
 * Mobile in-call grid, laid out like the Google Meet phone app, with every
 * tile a square:
 *   • your own tile floats in the bottom-right corner, over the grid
 *   • everyone else fills the stage: 1–3 tiles stacked in one column,
 *     4–8 tiles in two columns (2 × 4 at most)
 *   • > 8 tiles  → only the first 8 are shown; the 8th carries an "N others"
 *                  badge so the user knows more participants are present.
 * Alone in the call, your own tile takes the stage instead of floating.
 */
const MOBILE_MAX_TILES = 8;
function MobileGridLayout({ ctx, allParticipants, screenShareEntries }: Readonly<LayoutProps>) {
  const self = allParticipants.find((entry) => entry.isSelf);
  const others = allParticipants.filter((entry) => !entry.isSelf);
  const tiles: Array<{ key: string; node: ReactNode }> = [
    ...screenShareEntries.map((entry) => ({
      key: `${entry.p.id}-screen`,
      node: (
        <div className="rounded-xl overflow-hidden bg-[#1a1a1a] h-full w-full">
          <ScreenTile ctx={ctx} entry={entry} interactive />
        </div>
      ),
    })),
    ...others.map((entry) => ({
      key: entry.p.id,
      node: <CameraTile ctx={ctx} entry={entry} />,
    })),
  ];
  // Nothing else to show: the local tile is the stage, not a thumbnail.
  const selfFloats = !!self && tiles.length > 0;
  if (self && !selfFloats) tiles.push({ key: self.p.id, node: <CameraTile ctx={ctx} entry={self} /> });

  const overflow = tiles.length - MOBILE_MAX_TILES;
  const shown = overflow > 0 ? tiles.slice(0, MOBILE_MAX_TILES) : tiles;
  const cols = shown.length <= 3 ? 1 : 2;

  return (
    <div className="relative h-full w-full">
      <MobileSquareGrid cols={cols} count={shown.length}>
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
      </MobileSquareGrid>
      {selfFloats && (
        <div className={MOBILE_SELF_THUMBNAIL_CLASS}>
          <CameraTile ctx={ctx} entry={self} />
        </div>
      )}
    </div>
  );
}

// ─── Desktop tiled grid ──────────────────────────────────────────────────────

/** Gap between desktop tiles, in px (Tailwind's `2`). */
const GRID_GAP = 8;
/** Padding around the desktop grid, in px (Tailwind's `4`). */
const GRID_PADDING = 16;
/** The shape a tile is laid out for. Tiles then stretch to fill the stage. */
const GRID_TILE_ASPECT = 16 / 9;
/** Google Meet's own ceiling for one screen of tiles. */
const GRID_MAX_TILES = 49;

/** Column count used until the stage has been measured. */
function fallbackGridCols(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  return 3;
}

/**
 * How many columns show `count` tiles largest on a `width` × `height` stage,
 * the way Google Meet picks its grid: for each possible column count, take the
 * biggest 16:9 tile that still fits both ways, and keep the count that gives
 * the widest one. A wide stage therefore gets more columns as people join
 * (10 people: 4 × 3, 20 people: 5 × 4) instead of ever-flatter rows.
 */
export function pickGridColumns(count: number, width: number, height: number): number {
  if (count <= 1) return 1;
  if (width <= 0 || height <= 0) return fallbackGridCols(count);
  let best = 1;
  let bestTileWidth = 0;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const widthFromColumns = (width - GRID_GAP * (cols - 1)) / cols;
    const widthFromRows = ((height - GRID_GAP * (rows - 1)) / rows) * GRID_TILE_ASPECT;
    const tileWidth = Math.min(widthFromColumns, widthFromRows);
    if (tileWidth > bestTileWidth) {
      bestTileWidth = tileWidth;
      best = cols;
    }
  }
  return best;
}

/** Content-box size of an element, kept current as it is resized. */
function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

/**
 * Plain tiled grid: screen shares first, then every camera tile. The column
 * count follows the stage size and head-count (see `pickGridColumns`); the
 * rows share the height, and a short last row is centred, as in Google Meet.
 * Past 49 tiles the last one carries an "N others" badge.
 */
function TiledGridLayout({ ctx, allParticipants, screenShareEntries }: Readonly<LayoutProps>) {
  const [stageRef, stage] = useElementSize<HTMLDivElement>();
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
  const overflow = tiles.length - GRID_MAX_TILES;
  const shown = overflow > 0 ? tiles.slice(0, GRID_MAX_TILES) : tiles;
  const cols = pickGridColumns(shown.length, stage.width, stage.height);
  const rows: Array<typeof shown> = [];
  for (let i = 0; i < shown.length; i += cols) rows.push(shown.slice(i, i + cols));
  const tileWidth = `calc((100% - ${GRID_GAP * (cols - 1)}px) / ${cols})`;

  return (
    <div className="h-full w-full" style={{ padding: GRID_PADDING }}>
      <div ref={stageRef} className="flex h-full w-full flex-col" style={{ gap: GRID_GAP }}>
        {rows.map((row, rowIndex) => (
          <div key={row[0]!.key} className="flex min-h-0 flex-1 justify-center" style={{ gap: GRID_GAP }}>
            {row.map((t, i) => {
              const showBadge = overflow > 0 && rowIndex === rows.length - 1 && i === row.length - 1;
              return (
                <div key={t.key} className="relative h-full min-w-0" style={{ width: tileWidth }}>
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
        ))}
      </div>
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
function StageLayout(props: Readonly<StageLayoutProps>) {
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
      isMobile={isMobile}
    />
  );
  // Two people on a phone, nobody sharing: full-stage tile + floating thumbnail.
  const [first, second] = allParticipants;
  if (isMobile && first && second && allParticipants.length === 2 && screenShareEntries.length === 0) {
    const main = pinnedParticipant ?? focusedParticipant ?? second;
    return (
      <MobileDuoLayout
        ctx={ctx}
        main={main}
        thumbnail={main.p.id === first.p.id ? second : first}
        pinned={pinnedParticipant?.p.id === main.p.id}
      />
    );
  }
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
function CaptionsOverlay({ captions }: Readonly<{ captions: NonNullable<MeetingRoomViewProps['captions']> }>) {
  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 max-w-[80%] max-md:w-max max-md:max-w-[calc(100%-1rem)] pointer-events-none">
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
}: Readonly<{
  isFullscreen?: boolean;
  rightReservation: number;
  children: ReactNode;
}>) {
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
export function MeetingRoomView(props: Readonly<MeetingRoomViewProps>) {
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
    headerLabels,
    onToggleEffects,
    effectsOpen,
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
  const hideShareCard = isMobile && allParticipants.length > 1;

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
          isRecording={isRecording}
          recordingState={recordingState}
          recordingStartElapsedSeconds={recordingStartElapsedSeconds}
          recordingLabels={recordingLabels}
          headerLabels={headerLabels}
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
          showToolsButton={showToolsButton}
          mobileOverflowActions
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

          {/* On a phone the card spans the stage, so it steps aside while
              someone else is in the call (the link stays in Meeting details).
              Hidden rather than unmounted, so a dismissed card stays dismissed. */}
          {shareUrl && (
            <div hidden={hideShareCard} className={hideShareCard ? undefined : 'contents'}>
              <ShareLinkCard shareUrl={shareUrl} addPeopleDialogContent={addPeopleDialogContent} />
            </div>
          )}

          {/* Chat-notification host — mirrors ShareLinkCard's corner distance
              on the right edge. Toasts portal in here. */}
          <div
            ref={setNotificationHost}
            className="absolute bottom-2 right-2 md:bottom-6 md:right-6 z-10 flex flex-col items-end gap-2 pointer-events-none"
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
          isRecording={isRecording}
          recordingState={recordingState}
          {...controlBarRecording}
          isFullscreen={isFullscreen}
          onToggleFullscreen={onToggleFullscreen}
          onPictureInPicture={onPictureInPicture}
          onOpenSettings={showHostControlsButton ? () => toggleRightPanel('settings') : undefined}
          onOpenInfo={showInfoButton ? () => toggleRightPanel('info') : undefined}
          onOpenTools={showToolsButton ? () => toggleRightPanel('tools') : undefined}
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
        duration={duration}
        durationLabel={headerLabels?.duration}
        participants={participants}
        meeting={meeting}
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
