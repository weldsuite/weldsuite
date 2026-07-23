import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ParticipantTile, ScreenShareTile } from './participant-tile';
import { useIsMobile } from '../hooks/use-is-mobile';
import { CallControlsBar } from './call-controls-bar';
import { MeetingHeader } from './meeting-header';
import { MeetingRightPanel, type RightPanelKind } from './meeting-right-panel';
import { ShareLinkCard } from './share-link-card';
import { AdmitGuestsPill } from './admit-guests-pill';
import type { MeetingRoomViewProps } from '../types';

/**
 * Audio-only playback for a single remote participant.
 *
 * Remote sound is normally emitted by the `<audio>` element inside each
 * `ParticipantTile`. Some layouts (e.g. spotlight + screen-share) intentionally
 * hide every camera tile, which unmounts those elements and silences the call.
 * Rendering this hidden sink in such layouts keeps each remote participant
 * audible regardless of what's on screen.
 */
function RemoteParticipantAudio({ participant }: { participant: any }) {
  const ref = useRef<HTMLAudioElement>(null);
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
    peoplePanelSlot,
    hostControlsSlot,
    invitePopoverSlot,
    addPeopleDialogContent,
    onClickParticipantDetails,
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

  const showCaptions = !!hostControls?.enableCaptions && (captions?.length ?? 0) > 0;
  const isMobile = useIsMobile();

  // Resolve effective gating: when host management is on AND the viewer is
  // not the organizer, the policy hides / disables specific controls.
  const enforce = !!hostControls?.hostManagement && !isOrganizer;
  const gate = {
    screenShare: !enforce || hostControls?.allowScreenShare !== false,
    micToggle: !enforce || hostControls?.allowMicrophone !== false,
    videoToggle: !enforce || hostControls?.allowVideo !== false,
    handRaise: !enforce || hostControls?.allowHandRaise !== false,
    virtualBackgrounds: !enforce || hostControls?.allowVirtualBackgrounds !== false,
    record: isOrganizer || hostControls?.allowParticipantRecord === true,
  };

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
    return () => parts.off?.('activeSpeaker', sync);
  }, [meeting]);

  const toggleRightPanel = useCallback((panel: 'info' | 'people' | 'settings') => {
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

  const allParticipants = participants.map((p, i) => ({ p, isSelf: i === 0 }));

  // Derive screen-share pseudo-tiles from any participant (self or remote)
  // that currently has an active screen-share track.  RTK exposes
  // `participant.screenShareEnabled` and `participant.screenShareTracks.video`
  // on both `self` (participants[0]) and remote Participant objects.
  // We key these tiles as `<participantId>-screen` so they have stable React keys.
  const screenShareEntries = allParticipants.filter(
    ({ p }) => p?.screenShareEnabled && p?.screenShareTracks?.video,
  );

  // When anyone is sharing their screen, force a Google-Meet-style presenter
  // layout regardless of the user's selected viewMode. The shared screen fills
  // the main area; all participant camera tiles move into a compact strip.
  // This is a temporary override — when sharing stops, the user's viewMode
  // is restored automatically because this derived value returns false.
  const isScreenShareActive = screenShareEntries.length > 0;

  // Total grid cells = normal participant tiles + screen-share tiles.
  // (Only used in the plain tiled layout — not in the share-focused layout.)
  const totalTiles = participants.length + screenShareEntries.length;
  const gridCols =
    totalTiles <= 1 ? 'grid-cols-1' :
    totalTiles <= 2 ? 'grid-cols-2' :
    totalTiles <= 4 ? 'grid-cols-2' :
    'grid-cols-3';

  // Manual focus — clicking any tile (camera OR screen) promotes it to the main
  // stage; clicking it again returns to the grid. `pinnedId` holds either a
  // participant id or a screen-share id (`<id>-screen`).
  const focusedScreen = pinnedId
    ? screenShareEntries.find(({ p }) => `${p.id}-screen` === pinnedId) ?? null
    : null;
  const pinnedParticipant = pinnedId && !focusedScreen
    ? allParticipants.find(({ p }) => p.id === pinnedId) ?? null
    : null;

  // Camera focus = an explicit pin OR an auto-focus driven by the view mode.
  // A focused screen always takes the stage, so suppress camera focus while a
  // screen is focused.
  //   • spotlight / sidebar — statically focus the first remote participant.
  //   • speaker — dynamically follow the active speaker, falling back to the
  //     first remote until anyone has spoken (or if the active speaker has
  //     left and isn't in the current participant list).
  const focusedParticipant = (() => {
    if (focusedScreen) return null;
    if (pinnedParticipant) return pinnedParticipant;
    if (participants.length <= 1) return null;
    if (viewMode === 'speaker') {
      const active = activeSpeakerId
        ? allParticipants.find(({ p }) => p.id === activeSpeakerId)
        : null;
      return active ?? { p: participants[1], isSelf: false };
    }
    if (viewMode === 'spotlight' || viewMode === 'sidebar') {
      return { p: participants[1], isSelf: false };
    }
    return null;
  })();

  const otherScreens = focusedScreen
    ? screenShareEntries.filter(({ p }) => p.id !== focusedScreen.p.id)
    : [];

  const useFocusedLayout = !!focusedParticipant;
  const showChatButton = showChatButtonProp ?? !!chatPanelSlot;

  // Shared renderer for the camera-focus layout — one big tile plus a strip of
  // everyone else. Used both for an explicit pin and the spotlight/sidebar
  // viewMode auto-focus, so the markup lives in one place.
  const renderCameraFocus = (focused: { p: any; isSelf: boolean }) => {
    const others = allParticipants.filter(({ p }) => p.id !== focused.p.id);
    const isPinned = pinnedParticipant?.p.id === focused.p.id;
    const mainTile = (
      <ParticipantTile
        participant={focused.p}
        isSelf={focused.isSelf}
        isHandRaised={focused.isSelf ? handRaised : handRaisedParticipants?.has(focused.p.id)}
        meeting={meeting}
        pinned={isPinned}
        onTogglePin={handleTogglePin}
        onClickDetails={onClickParticipantDetails}
        colorSeed={focused.isSelf ? selfColorSeed : undefined}
        canManageParticipants={isOrganizer}
      />
    );

    if (viewMode === 'sidebar') {
      return (
        <div className="flex gap-2 p-4 h-full">
          <div className="flex-1 min-w-0">{mainTile}</div>
          {others.length > 0 && (
            <div className="flex flex-col gap-2 w-[240px] flex-shrink-0 overflow-y-auto overflow-x-hidden p-1">
              {others.map(({ p, isSelf: s }) => (
                <div key={p.id} className="h-[140px] flex-shrink-0">
                  <ParticipantTile participant={p} isSelf={s} isHandRaised={s ? handRaised : handRaisedParticipants?.has(p.id)} meeting={meeting} onTogglePin={handleTogglePin} onClickDetails={onClickParticipantDetails} colorSeed={s ? selfColorSeed : undefined} canManageParticipants={isOrganizer} />
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
            {others.map(({ p, isSelf: s }) => (
              <div key={p.id} className="w-[240px] flex-shrink-0">
                <ParticipantTile participant={p} isSelf={s} isHandRaised={s ? handRaised : handRaisedParticipants?.has(p.id)} meeting={meeting} onTogglePin={handleTogglePin} onClickDetails={onClickParticipantDetails} colorSeed={s ? selfColorSeed : undefined} canManageParticipants={isOrganizer} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  // Mobile in-call grid — mirrors the Google Meet phone layout:
  //   • 1–4 tiles  → single stacked column (one under another)
  //   • 5–8 tiles  → 2 columns (max 4 rows)
  //   • > 8 tiles  → only the first 8 are shown; the 8th carries an "N others"
  //                  badge so the user knows more participants are present.
  const MOBILE_MAX_TILES = 8;
  const renderMobileGrid = () => {
    const tiles: Array<{ key: string; node: ReactNode }> = [
      ...screenShareEntries.map(({ p, isSelf: s }) => ({
        key: `${p.id}-screen`,
        node: (
          <div className="rounded-xl overflow-hidden bg-[#1a1a1a] h-full w-full">
            <ScreenShareTile participant={p} isSelf={s} meeting={meeting} onClick={() => handleTogglePin(`${p.id}-screen`)} />
          </div>
        ),
      })),
      ...allParticipants.map(({ p, isSelf: s }) => ({
        key: p.id,
        node: (
          <ParticipantTile participant={p} isSelf={s} isHandRaised={s ? handRaised : handRaisedParticipants?.has(p.id)} meeting={meeting} onTogglePin={handleTogglePin} onClickDetails={onClickParticipantDetails} colorSeed={s ? selfColorSeed : undefined} canManageParticipants={isOrganizer} />
        ),
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
  };

  const content = (
    <div className="relative flex-1 flex min-h-0 bg-background">
      <div className="flex-1 flex flex-col min-w-0">
        <MeetingHeader
          meetingTitle={meetingTitle}
          duration={duration}
          isRecording={isRecording}
          recordingState={recordingState}
          waitlistedCount={waitlistedCount}
          participantsCount={participants.length}
          rightPanel={rightPanel}
          showChat={showChat}
          onToggleRightPanel={toggleRightPanel}
          onToggleChat={() => {
            const willOpen = !showChat;
            const isSwitching = !!rightPanel || externalPanelOpen;
            if (isSwitching) setSkipTransition(true);
            setShowChat(v => !v);
            setRightPanel(null);
            if (willOpen && externalPanelOpen) onActivatePanel?.();
            if (isSwitching) requestAnimationFrame(() => setSkipTransition(false));
          }}
          onRenameMeeting={onRenameMeeting}
          showInfoButton={showInfoButton}
          showPeopleButton={showPeopleButton}
          showChatButton={showChatButton}
          showHostControlsButton={showHostControlsButton}
          showToolsButton={showToolsButton}
        />

        <div className="flex-1 min-h-0 overflow-hidden relative">
          {focusedScreen ? (
            /*
             * ── Focused screen (explicit click) ───────────────────────────────
             * The clicked screen fills the main area; every camera tile and any
             * other shared screen drop into a strip below. Clicking the big
             * screen (or its strip thumbnail) toggles focus back off.
             */
            <div className="flex flex-col gap-2 p-4 h-full">
              <div className="flex-1 min-h-0 rounded-xl overflow-hidden bg-[#1a1a1a]">
                <ScreenShareTile
                  participant={focusedScreen.p}
                  isSelf={focusedScreen.isSelf}
                  meeting={meeting}
                  focused
                  onClick={() => handleTogglePin(`${focusedScreen.p.id}-screen`)}
                />
              </div>
              <div className="flex gap-2 h-[160px] flex-shrink-0 overflow-x-auto overflow-y-hidden p-1">
                {otherScreens.map(({ p, isSelf: s }) => (
                  <div key={`${p.id}-screen`} className="w-[240px] flex-shrink-0 rounded-xl overflow-hidden bg-[#1a1a1a]">
                    <ScreenShareTile participant={p} isSelf={s} meeting={meeting} onClick={() => handleTogglePin(`${p.id}-screen`)} />
                  </div>
                ))}
                {allParticipants.map(({ p, isSelf: s }) => (
                  <div key={p.id} className="w-[240px] flex-shrink-0">
                    <ParticipantTile participant={p} isSelf={s} isHandRaised={s ? handRaised : handRaisedParticipants?.has(p.id)} meeting={meeting} onTogglePin={handleTogglePin} onClickDetails={onClickParticipantDetails} colorSeed={s ? selfColorSeed : undefined} canManageParticipants={isOrganizer} />
                  </div>
                ))}
              </div>
            </div>
          ) : pinnedParticipant ? (
            /* An explicit camera pin wins over the auto screen-share presenter. */
            renderCameraFocus(pinnedParticipant)
          ) : participants.length === 1 && isScreenShareActive ? (
            /*
             * ── Solo presenter layout ─────────────────────────────────────────
             * Mirrors Google Meet's "you are the only one in this call" presenter
             * view: the shared screen fills the entire main area and the local
             * camera floats as a small PiP in the bottom-right corner.
             *
             * This branch fires BEFORE the viewMode branches so it overrides
             * Auto / Sidebar / Spotlight / Tiled when alone + sharing.
             * The PiP is hidden when the local camera is off (isVideoOff).
             */
            <div className="relative h-full w-full p-3">
              {/* Shared screen — full area (inside the p-3 wrapper so it
                  matches the inset of every other layout). */}
              <div className="relative h-full w-full rounded-xl overflow-hidden bg-[#1a1a1a]">
                <ScreenShareTile
                  participant={participants[0]}
                  isSelf
                  meeting={meeting}
                />

                {/* Local camera PiP — bottom-right, hidden when video is off */}
                {!isVideoOff && (
                  <div className="absolute bottom-4 right-4 z-10 w-[300px] h-[195px] rounded-lg shadow-lg overflow-hidden ring-1 ring-white/20">
                    <ParticipantTile
                      participant={participants[0]}
                      isSelf
                      isHandRaised={handRaised}
                      meeting={meeting}
                      colorSeed={selfColorSeed}
                      canManageParticipants={isOrganizer}
                    />
                  </div>
                )}
              </div>
            </div>
          ) : isScreenShareActive && (viewMode === 'sidebar' || viewMode === 'speaker') ? (
            /*
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
            <div className="flex max-md:flex-col-reverse gap-2 p-3 h-full">
              {/* Main share area */}
              <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-2">
                {screenShareEntries.map(({ p, isSelf: s }) => (
                  <div key={`${p.id}-screen`} className="flex-1 min-h-0 rounded-xl overflow-hidden bg-[#1a1a1a]">
                    <ScreenShareTile
                      participant={p}
                      isSelf={s}
                      meeting={meeting}
                    />
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
                {allParticipants.map(({ p, isSelf: s }) => (
                  <div
                    key={p.id}
                    className="flex-shrink-0 md:h-[120px] md:w-full max-md:h-full max-md:w-[160px]"
                  >
                    <ParticipantTile
                      participant={p}
                      isSelf={s}
                      isHandRaised={s ? handRaised : handRaisedParticipants?.has(p.id)}
                      meeting={meeting}
                      onTogglePin={handleTogglePin}
                      onClickDetails={onClickParticipantDetails}
                      colorSeed={s ? selfColorSeed : undefined}
                      canManageParticipants={isOrganizer}
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : isScreenShareActive && viewMode === 'spotlight' ? (
            /*
             * ── Spotlight + share: full-area share only ───────────────────────
             * Mirrors Google Meet's spotlight behaviour: when the user has chosen
             * Spotlight and someone is sharing, only the share tile(s) are shown
             * — participant cameras are hidden entirely. If multiple people share
             * simultaneously each share tile stacks vertically.
             */
            <div className="flex flex-col gap-2 p-3 h-full">
              {screenShareEntries.map(({ p, isSelf: s }) => (
                <div key={`${p.id}-screen`} className="flex-1 min-h-0 rounded-xl overflow-hidden bg-[#1a1a1a]">
                  <ScreenShareTile
                    participant={p}
                    isSelf={s}
                    meeting={meeting}
                  />
                </div>
              ))}
              {/* This layout hides every camera tile, which would unmount each
                  participant's <audio>. Keep remote audio alive with a hidden
                  sink so the user still hears everyone while watching a screen. */}
              <div className="sr-only" aria-hidden>
                {allParticipants
                  .filter(({ isSelf: s }) => !s)
                  .map(({ p }) => (
                    <RemoteParticipantAudio key={p.id} participant={p} />
                  ))}
              </div>
            </div>
          ) : useFocusedLayout ? (
            renderCameraFocus(focusedParticipant)
          ) : isMobile ? (
            renderMobileGrid()
          ) : (
            <div className={`grid ${gridCols} gap-2 p-4 h-full auto-rows-fr`}>
              {screenShareEntries.map(({ p, isSelf: s }) => (
                <div key={`${p.id}-screen`} className="rounded-xl overflow-hidden bg-[#1a1a1a]">
                  <ScreenShareTile
                    participant={p}
                    isSelf={s}
                    meeting={meeting}
                    onClick={() => handleTogglePin(`${p.id}-screen`)}
                  />
                </div>
              ))}
              {allParticipants.map(({ p, isSelf: s }) => (
                <ParticipantTile key={p.id} participant={p} isSelf={s} isHandRaised={s ? handRaised : handRaisedParticipants?.has(p.id)} meeting={meeting} onTogglePin={handleTogglePin} onClickDetails={onClickParticipantDetails} colorSeed={s ? selfColorSeed : undefined} canManageParticipants={isOrganizer} />
              ))}
            </div>
          )}

          {shareUrl && <ShareLinkCard shareUrl={shareUrl} addPeopleDialogContent={addPeopleDialogContent} />}

          {/* Chat-notification host — mirrors ShareLinkCard's bottom-6/left-6
              corner distance on the right edge. Toasts portal in here. */}
          <div
            ref={setNotificationHost}
            className="absolute bottom-6 right-6 z-10 flex flex-col items-end gap-2 pointer-events-none"
          />

          {meeting && <AdmitGuestsPill meeting={meeting} />}

          {showCaptions && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 max-w-[80%] pointer-events-none">
              <div className="rounded-2xl bg-black/70 px-4 py-2 text-white backdrop-blur shadow-lg ring-1 ring-white/10">
                {captions!.slice(-2).map((c) => (
                  <div key={c.id} className="text-[13px] leading-snug">
                    <span className="text-white/60 mr-2">{c.speakerName}:</span>
                    <span className={c.isPartial ? 'opacity-80' : ''}>{c.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <CallControlsBar
          meeting={meeting}
          isMuted={isMuted}
          isVideoOff={isVideoOff}
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
          onToggleEffects={onToggleEffects}
          effectsOpen={effectsOpen}
          backgroundType={backgroundType}
          isRecording={isRecording}
          recordingState={recordingState}
          startRecording={gate.record && showControlBarRecording ? startRecording : undefined}
          stopRecording={gate.record && showControlBarRecording ? stopRecording : undefined}
          pauseRecording={gate.record && showControlBarRecording ? pauseRecording : undefined}
          resumeRecording={gate.record && showControlBarRecording ? resumeRecording : undefined}
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
        startRecording={isOrganizer ? startRecording : undefined}
        stopRecording={isOrganizer ? stopRecording : undefined}
        recordingAvailable={isOrganizer}
      />

      {chatPanelSlot?.({ isOpen: showChat, onClose: () => setShowChat(false), onOpen: () => setShowChat(true), notificationHost, skipTransition })}
      {backgroundEffectsSlot}
    </div>
  );

  if (isFullscreen) {
    return (
      <div
        className="fixed inset-0 z-50 flex bg-background transition-[right] duration-200"
        style={rightReservation > 0 ? { right: `${rightReservation}px` } : undefined}
      >
        {content}
      </div>
    );
  }

  return content;
}
