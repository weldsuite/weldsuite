import type { ReactNode } from 'react';

export type ViewMode = 'grid' | 'spotlight' | 'speaker' | 'sidebar';
export type RecordingState = 'IDLE' | 'STARTING' | 'RECORDING' | 'PAUSED' | 'STOPPING';

/**
 * Props for the shared MeetingRoomView. Pure presentational — no Clerk, no
 * workspace context, no query hooks. Everything flows in from the host app.
 */
export interface MeetingRoomViewProps {
  // ── Meeting identity / metadata ────────────────────────────────────────────
  meetingId: string;
  meetingTitle: string;
  /** When provided, the People panel shows the join code chip + invite popover at the top. */
  joinCode?: string;
  /** Public share URL (built by the host app — uses VITE_/NEXT_PUBLIC_ env vars). */
  shareUrl?: string;
  /** Description shown in the "Meeting details" right panel. */
  description?: string;
  /** Scheduled start time shown in details panel (ISO string). */
  scheduledStart?: string | null;

  // ── RTK / live meeting client ──────────────────────────────────────────────
  meeting: any;
  participants: any[];
  waitlistedCount?: number;

  // ── Self state ────────────────────────────────────────────────────────────
  isMuted: boolean;
  isVideoOff: boolean;
  isScreenSharing: boolean;
  handRaised: boolean;
  /** Set of peer ids (participant.id) whose hand is currently raised. Includes self when handRaised is true. */
  handRaisedParticipants?: Set<string>;
  duration: number;
  isOrganizer: boolean;
  viewMode: ViewMode;
  isFullscreen?: boolean;

  // ── Self actions ──────────────────────────────────────────────────────────
  toggleMute: () => void;
  toggleVideo: () => void;
  startScreenShare: (constraints?: DisplayMediaStreamOptions) => Promise<void>;
  stopScreenShare: () => void;
  toggleHandRaise: () => void;
  setViewMode: (mode: ViewMode) => void;
  onLeave: () => void;
  onToggleFullscreen?: () => void;
  onPictureInPicture?: () => void;

  // ── Title editing (omit to disable) ───────────────────────────────────────
  onRenameMeeting?: (newTitle: string) => void;

  // ── Recording (organizer-only — omit to hide) ─────────────────────────────
  isRecording?: boolean;
  recordingState?: RecordingState;
  startRecording?: () => void;
  stopRecording?: () => void;
  pauseRecording?: () => void;
  resumeRecording?: () => void;
  /**
   * Show the recording controls in the CallControlsBar overflow menu. Defaults
   * to true. Set false to keep recording out of the controls bar while still
   * surfacing it in the Meeting tools panel (the platform weldmeet experience).
   */
  showControlBarRecording?: boolean;

  // ── Background effects (omit to hide) ─────────────────────────────────────
  onToggleEffects?: () => void;
  effectsOpen?: boolean;
  backgroundType?: any;
  /** Slot — host app renders its BackgroundEffectsPanel here (always portaled). */
  backgroundEffectsSlot?: ReactNode;

  // ── Chat (omit to hide chat button) ───────────────────────────────────────
  /**
   * Render prop — receives the internal showChat state and a close callback.
   * Lets the host app render its chat panel with the correct open state while
   * MeetingRoomView still coordinates right-panel ⇄ chat-panel transitions.
   * When omitted, the chat button is hidden.
   */
  chatPanelSlot?: (args: { isOpen: boolean; onClose: () => void; onOpen: () => void; notificationHost: HTMLElement | null; skipTransition: boolean }) => ReactNode;
  showChatButton?: boolean;

  // ── Right-panel features (each omit to hide button) ───────────────────────
  showInfoButton?: boolean;
  showPeopleButton?: boolean;
  showHostControlsButton?: boolean;
  /** Show the wrench/Tools button in the header that opens the Meeting tools panel. */
  showToolsButton?: boolean;

  // ── People panel slot (replaces built-in PeoplePanel — host can render
  // its own, e.g. with workspace member data) ─────────────────────────────
  peoplePanelSlot?: ReactNode;

  // ── Host controls panel slot ──────────────────────────────────────────────
  hostControlsSlot?: ReactNode;

  /**
   * Rolling caption buffer from RTK transcription. Rendered as a bottom-of-
   * frame subtitle when `hostControls.enableCaptions === true`. Omit to hide.
   */
  captions?: Array<{
    id: string;
    peerId: string;
    speakerName: string;
    text: string;
    isPartial: boolean;
    at: number;
  }>;

  // ── Host-control policy — gates which controls render for non-organizers ──
  /**
   * Active host-control policy. When `hostManagement` is true, certain buttons
   * (screen share, hand raise, virtual backgrounds, etc.) are hidden or
   * disabled for non-organizers. Omit on the meeting-portal preview / when no
   * meeting policy is loaded — the controls will then render permissively.
   */
  hostControls?: {
    hostManagement: boolean;
    allowScreenShare: boolean;
    allowMicrophone: boolean;
    allowVideo: boolean;
    allowHandRaise: boolean;
    allowReactions: boolean;
    allowAnnotations: boolean;
    allowVirtualBackgrounds: boolean;
    allowParticipantRecord: boolean;
    enableCaptions?: boolean;
  };

  // ── Invite (workspace member list) — slot for the popover content ─────────
  /** Replaces built-in invite popover (which only shows the share-URL). */
  invitePopoverSlot?: ReactNode;

  // ── Add-people dialog (rendered inside the floating ShareLinkCard) ────────
  /** Slot — when omitted the "Add people" button on the share-link card is hidden. */
  addPeopleDialogContent?: ReactNode;

  // ── Camera-off color seed for the SELF tile (omit to use participant.id) ──
  /**
   * Optional stable seed used to derive the local participant's camera-off
   * color theme. Pass the same seed used on the host app's pre-join preview
   * so the avatar color stays identical across preview → in-meeting.
   */
  selfColorSeed?: string;

  // ── Per-participant click-to-open-details (omit to disable) ───────────────
  /**
   * When provided, clicking a participant tile (or "View profile" in its
   * context menu) invokes this callback. The platform uses it to open a
   * side sheet showing the linked CRM contact / team-member details.
   */
  onClickParticipantDetails?: (participant: any) => void;

  // ── Host-app right-edge reservation (fullscreen only) ─────────────────────
  /**
   * Pixels reserved on the right edge of the fullscreen meeting wrapper so a
   * host-app side panel (e.g. platform object-panel) sits next to the meeting
   * instead of overlaying it. Omit / pass 0 when no panel is open. Only
   * applied in fullscreen mode — inline meeting views are sized by the parent
   * layout already.
   */
  rightReservation?: number;

  // ── External-panel coordination ───────────────────────────────────────────
  /**
   * When `true`, the host app has its own side panel open (e.g. WeldAgent
   * drawer). The meeting view will instantly close any of its internal panels
   * (chat, info, people, settings) without animation so only one panel is
   * visible at a time.
   */
  externalPanelOpen?: boolean;
  /**
   * Called whenever the user opens an internal meeting panel (chat, info,
   * people, settings). The host app should use this to close its own external
   * panel so only one panel is active.
   */
  onActivatePanel?: () => void;
  /**
   * Fired whenever an internal panel (chat, info, people, settings) opens or
   * closes. The host app uses this to publish the state globally so that other
   * drawers (e.g. WeldAgent) can skip their slide-in animation when the user
   * switches directly from a meeting panel.
   */
  onInternalPanelChange?: (anyOpen: boolean) => void;

  // ── Controlled pin (optional) ─────────────────────────────────────────────
  /**
   * Pinned participant id (or `<participantId>-screen` for a pinned screen
   * share). When provided together with `onTogglePin`, pinning is *controlled*
   * by the host app so the pin survives a remount of this component — e.g. the
   * platform moving the meeting between its inline page view and the global
   * fullscreen overlay (two different mount points). Omit BOTH to fall back to
   * the component's internal pin state.
   */
  pinnedId?: string | null;
  /** Toggle handler for the controlled pin; see `pinnedId`. */
  onTogglePin?: (id: string) => void;
}
