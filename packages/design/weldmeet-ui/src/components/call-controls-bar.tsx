import { useEffect, useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, Mic, MicOff, VideoOff, MonitorUp, MonitorX, Phone, ChevronUp, Check, Hand, Image, Circle, Square, Pause, Play, EllipsisVertical, Maximize, Minimize, PictureInPicture2, Settings, Volume2, VolumeX, LogOut } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '@weldsuite/ui/components/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import type { ViewMode, RecordingState, MeetingClient, LeaveLabels } from '../types';
import {
  DEFAULT_PERMISSION_HELP_LABELS,
  PermissionHelp,
  type PermissionHelpLabels,
  type PermissionKind,
} from './permission-help';
import { refreshSpeakerDevices, useSpeakerDevices } from '../hooks/use-speaker-output';
import { useIsMobile } from '../hooks/use-is-mobile';
import { CallControlsMoreSheet } from './call-controls-more-sheet';
import { LAYOUT_OPTIONS, stopRecordingWithToast, toggleRecordingPause } from './call-controls-shared';

// ─── Tooltip ─────────────────────────────────────────────────────────────────

function CallTooltip({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hovering = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);

  const hasOpenDropdown = useCallback(() => {
    return !!triggerRef.current?.querySelector('[data-state="open"]');
  }, []);

  const startTimer = useCallback(() => {
    clearTimer();
    if (!hovering.current || hasOpenDropdown()) return;
    timerRef.current = setTimeout(() => {
      if (!hovering.current || hasOpenDropdown()) return;
      if (triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        setPos({ x: rect.left + rect.width / 2, y: rect.top - 8 });
      }
      setShow(true);
    }, 600);
  }, [clearTimer, hasOpenDropdown]);

  useEffect(() => {
    const el = triggerRef.current;
    if (!el) return;
    const observer = new MutationObserver(() => {
      if (hasOpenDropdown()) {
        clearTimer();
        setShow(false);
      }
    });
    observer.observe(el, { attributes: true, attributeFilter: ['data-state'], subtree: true });
    return () => observer.disconnect();
  }, [clearTimer, hasOpenDropdown]);

  return (
    <div
      ref={triggerRef}
      onMouseEnter={() => { hovering.current = true; startTimer(); }}
      onMouseLeave={() => { hovering.current = false; clearTimer(); setShow(false); }}
      onMouseDown={() => { clearTimer(); setShow(false); }}
    >
      {children}
      {createPortal(
        <div
          className="fixed px-2 py-1 bg-primary text-primary-foreground text-[11px] rounded-md whitespace-nowrap pointer-events-none z-[9999] -translate-x-1/2 -translate-y-full transition-opacity duration-150"
          style={{ left: pos.x, top: pos.y, opacity: show ? 1 : 0 }}
        >
          {label}
        </div>,
        document.body,
      )}
    </div>
  );
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CallControlsBarProps {
  // Required state
  meeting: MeetingClient | null;
  isMuted: boolean;
  isVideoOff: boolean;
  isScreenSharing: boolean;
  handRaised: boolean;
  viewMode: ViewMode;

  // Required actions
  toggleMute: () => void;
  toggleVideo: () => void;
  startScreenShare: (constraints?: DisplayMediaStreamOptions) => Promise<void>;
  stopScreenShare: () => void;
  toggleHandRaise: () => void;
  setViewMode: (mode: ViewMode) => void;
  onLeave: () => void;
  /**
   * Optional "end the meeting for everyone" action (host only). When provided
   * the red leave button becomes a menu with "Leave meeting" (calls `onLeave`)
   * and a destructive "End meeting for all" (calls this). When omitted the
   * button is a plain single-action leave button.
   */
  onEndForAll?: () => void;
  /** Overrides for the leave-button labels (English defaults when omitted). */
  leaveLabels?: LeaveLabels;

  // Browser permission blocked (optional). When true the button renders in
  // the off state with a warning badge, and clicking it explains how to grant
  // access instead of toggling (toggling can't succeed while blocked).
  micBlocked?: boolean;
  cameraBlocked?: boolean;
  /** Copy for the blocked tooltip + help popover. English when omitted. */
  permissionHelpLabels?: PermissionHelpLabels;

  // Background effects (optional)
  onToggleEffects?: () => void;
  effectsOpen?: boolean;

  // Recording (optional — weldmeet organizer only)
  isRecording?: boolean;
  recordingState?: RecordingState;
  startRecording?: () => void;
  stopRecording?: () => void;
  pauseRecording?: () => void;
  resumeRecording?: () => void;

  // Fullscreen & PiP (optional)
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onPictureInPicture?: () => void;

  // Host controls / settings (optional — when provided adds an item to the
  // More-options dropdown that opens the right-side settings panel).
  onOpenSettings?: () => void;

  // Meeting details / meeting tools panels (optional). Only offered in the
  // phone "More options" sheet: on wider screens the header has these buttons.
  onOpenInfo?: () => void;
  onOpenTools?: () => void;

  /**
   * Per-control visibility gates. When a gate is `false` the corresponding
   * button is hidden entirely (e.g. host disabled "Share their screen" for
   * non-organizers). Default permissive: every gate defaults to true.
   */
  gates?: {
    screenShare?: boolean;
    handRaise?: boolean;
    virtualBackgrounds?: boolean;
  };

  // Extra controls to render (slot)
  extraControls?: React.ReactNode;
}

// ─── Resolutions ─────────────────────────────────────────────────────────────

// Quality-first presets. WeldMeet UX policy is quality > smoothness > delay,
// so the picker leads with high-resolution / sharp-text options. RTK's
// server-side preset is configured at fhd/30fps (see packages/cloudflare-
// -realtime seedPresets) — these client-side constraints will only be honored
// up to that cap. Higher entries here exist for monitor selection only; they
// still capture at the requested resolution, but RTK will downscale for
// transmission.
const SCREEN_RESOLUTIONS = [
  { label: '1080p · 30 fps (recommended)', width: 1920, height: 1080, frameRate: 30 },
  { label: '1440p · 30 fps (sharp)', width: 2560, height: 1440, frameRate: 30 },
  { label: '4K · 30 fps (sharpest)', width: 3840, height: 2160, frameRate: 30 },
  { label: '1080p · 60 fps (high motion)', width: 1920, height: 1080, frameRate: 60 },
  { label: '720p · 30 fps (low bandwidth)', width: 1280, height: 720, frameRate: 30 },
] as const;

// ─── Hooks ───────────────────────────────────────────────────────────────────

/** Active device id: the currently selected one, else the first available. */
function pickActiveDeviceId(currentId: string | undefined, devices: MediaDeviceInfo[]): string | undefined {
  if (currentId) return currentId;
  return devices[0]?.deviceId;
}

/** Runs `fn`, swallowing any error (APIs not available in this environment). */
function tryIgnore(fn: () => void): void {
  try { fn(); } catch { /* not available in this environment */ }
}

/**
 * Loads the audio/video input devices of the meeting, keeps them fresh on
 * device changes and exposes handlers to switch the active device.
 */
function useMeetingDevices(meeting: MeetingClient | null) {
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string>('');
  const [activeVideoDeviceId, setActiveVideoDeviceId] = useState<string>('');

  useEffect(() => {
    if (!meeting) return;
    // Bound locally so the nested async closure keeps the non-null narrowing.
    const rtk = meeting;

    let cancelled = false;
    async function loadDevices() {
      // The speaker list only fills in once the site has device permission,
      // which RTK may obtain without the browser firing `devicechange`.
      void refreshSpeakerDevices();
      try {
        const all = await rtk.self.getAllDevices();
        if (cancelled) return;
        const inputs = (all ?? []).filter((d) => d.kind === 'audioinput');
        const videos = (all ?? []).filter((d) => d.kind === 'videoinput');
        setAudioDevices(inputs);
        setVideoDevices(videos);

        const current = rtk.self.getCurrentDevices();
        const audioId = pickActiveDeviceId(current?.audio?.deviceId, inputs);
        if (audioId) setActiveDeviceId(audioId);
        const videoId = pickActiveDeviceId(current?.video?.deviceId, videos);
        if (videoId) setActiveVideoDeviceId(videoId);
      } catch { /* devices not available */ }
    }

    void loadDevices();

    // Refresh device list whenever the OS reports a change — covers OBS
    // Virtual Camera starting after meeting join, USB cam plug/unplug,
    // bluetooth headset connect, etc. Without this, the dropdown is frozen
    // at whatever was available at meeting-connect time.
    const onDeviceChange = () => { void loadDevices(); };
    tryIgnore(() => navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange));

    // RTK also surfaces device updates via its own event. Subscribing to
    // both is harmless (loadDevices is idempotent) and catches cases where
    // RTK observes a change before the browser fires devicechange.
    tryIgnore(() => meeting.self.on?.('deviceListUpdate', onDeviceChange));

    return () => {
      cancelled = true;
      tryIgnore(() => navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange));
      tryIgnore(() => meeting.self.off?.('deviceListUpdate', onDeviceChange));
    };
  }, [meeting]);

  async function switchDevice(
    devices: MediaDeviceInfo[],
    deviceId: string,
    setActive: (id: string) => void,
  ) {
    if (!meeting) return;
    const device = devices.find((d) => d.deviceId === deviceId);
    if (!device) return;
    try {
      await meeting.self.setDevice(device);
      setActive(deviceId);
    } catch { /* ignore */ }
  }

  return {
    audioDevices,
    videoDevices,
    activeDeviceId,
    activeVideoDeviceId,
    handleDeviceChange: (deviceId: string) => switchDevice(audioDevices, deviceId, setActiveDeviceId),
    handleVideoDeviceChange: (deviceId: string) => switchDevice(videoDevices, deviceId, setActiveVideoDeviceId),
  };
}

/**
 * Whether the audio captured alongside the screen share (system / tab audio)
 * is forwarded to other participants. RTK always requests `audio: true` when
 * it calls getDisplayMedia internally, so an audio track exists whenever the
 * user ticked "share audio" in the browser's source picker. This toggle, in
 * the screen-share options dropdown, lets the user mute/unmute that captured
 * audio live without re-prompting — we just flip the track's `enabled` flag.
 * Defaults to on, preserving the previous behaviour (captured audio shared).
 */
function useShareScreenAudio(meeting: MeetingClient | null, isScreenSharing: boolean) {
  const [shareScreenAudio, setShareScreenAudio] = useState(true);

  // Apply the share-audio preference to the screen-share audio track. Used both
  // when toggling live (during an active share) and when a share starts.
  const applyScreenShareAudio = useCallback((enabled: boolean) => {
    if (!meeting) return;
    try {
      const track = meeting.self.screenShareTracks?.audio;
      if (track) track.enabled = enabled;
    } catch { /* track not available */ }
  }, [meeting]);

  const toggleShareScreenAudio = useCallback(() => {
    setShareScreenAudio((prev) => {
      const next = !prev;
      if (isScreenSharing) applyScreenShareAudio(next);
      return next;
    });
  }, [isScreenSharing, applyScreenShareAudio]);

  // When a share starts, apply the current preference to the freshly-captured
  // audio track. RTK fires `screenShareUpdate` before its `screenShareTracks`
  // getter is populated, so the track may not be readable on the first tick —
  // retry briefly until it appears.
  useEffect(() => {
    if (!isScreenSharing || !meeting) return;
    let cancelled = false;
    let tries = 0;
    const apply = () => {
      if (cancelled) return;
      const track = meeting.self.screenShareTracks?.audio;
      if (track) { track.enabled = shareScreenAudio; return; }
      if (tries++ < 10) setTimeout(apply, 100);
    };
    apply();
    return () => { cancelled = true; };
  }, [isScreenSharing, meeting, shareScreenAudio]);

  return { shareScreenAudio, toggleShareScreenAudio };
}

/**
 * Whether this browser can capture a screen at all. Phone browsers cannot
 * (no `getDisplayMedia`), so the share button is left out there instead of
 * failing on tap. Starts `true` so the server and first client render agree.
 */
function useCanShareScreen(): boolean {
  const [canShare, setCanShare] = useState(true);
  useEffect(() => {
    setCanShare(typeof navigator.mediaDevices?.getDisplayMedia === 'function');
  }, []);
  return canShare;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

// The icon buttons and dropdown arrows keep a flat background on hover;
// IconHighlight / ArrowChevron draw the highlight as a rounded square around
// the icon (also shown while the button's menu / popover is open) instead.
const OFF_STATE_CLASSES =
  'bg-red-100 hover:bg-red-100 text-red-500 dark:bg-red-500/20 dark:hover:bg-red-500/20 dark:text-red-400';

type HighlightTone = 'default' | 'off' | 'active';

const ICON_HIGHLIGHT_CLASSES: Record<HighlightTone, string> = {
  default: 'group-hover/icon:bg-foreground/10 group-data-[state=open]/icon:bg-foreground/10',
  off: 'group-hover/icon:bg-red-200 group-data-[state=open]/icon:bg-red-200 dark:group-hover/icon:bg-red-500/20 dark:group-data-[state=open]/icon:bg-red-500/20',
  active: 'group-hover/icon:bg-primary-foreground/15 group-data-[state=open]/icon:bg-primary-foreground/15',
};

const ARROW_HIGHLIGHT_CLASSES: Record<HighlightTone, string> = {
  default: 'group-hover/arrow:bg-foreground/10 group-data-[state=open]/arrow:bg-foreground/10',
  off: 'group-hover/arrow:bg-red-200 group-data-[state=open]/arrow:bg-red-200 dark:group-hover/arrow:bg-red-500/20 dark:group-data-[state=open]/arrow:bg-red-500/20',
  active: 'group-hover/arrow:bg-primary-foreground/15 group-data-[state=open]/arrow:bg-primary-foreground/15',
};

/** Wraps the icon of a `group/icon` button. `fill` highlights the whole
 *  button instead of a square around the icon. */
function IconHighlight({ tone, fill, children }: Readonly<{ tone: HighlightTone; fill?: boolean; children: React.ReactNode }>) {
  return (
    <span className={cn("flex items-center justify-center transition-colors", fill ? "h-full w-full" : "h-8 w-8 rounded-lg", ICON_HIGHLIGHT_CLASSES[tone])}>
      {children}
    </span>
  );
}

/** Chevron inside a `group/arrow` dropdown trigger. */
function ArrowChevron({ tone }: Readonly<{ tone: HighlightTone }>) {
  return (
    <span className={cn("flex h-6 w-6 -translate-x-[6px] items-center justify-center rounded-md transition-colors", ARROW_HIGHLIGHT_CLASSES[tone])}>
      <ChevronUp className="h-4 w-4 transition-transform duration-200 group-data-[state=open]/arrow:rotate-180" />
    </span>
  );
}

/** Mic / camera button while the browser blocks that device: opens the
 *  permission help instead of toggling. */
function BlockedMediaButton({
  kind,
  labels,
  children,
}: Readonly<{
  kind: PermissionKind;
  labels: PermissionHelpLabels;
  children: React.ReactNode;
}>) {
  const label = kind === 'microphone' ? labels.microphoneBlockedAction : labels.cameraBlockedAction;
  return (
    <Popover>
      <CallTooltip label={label}>
        <PopoverTrigger asChild>
          <Button
            variant="secondary"
            size="icon"
            aria-label={label}
            className={cn("group/icon relative h-12 w-12 rounded-none rounded-l-[18px] border-0 transition-all", OFF_STATE_CLASSES)}
          >
            <IconHighlight tone="off">{children}</IconHighlight>
            <CircleAlert
              aria-hidden="true"
              className="pointer-events-none absolute top-[5px] right-[5px] !h-[14px] !w-[14px] text-amber-500 fill-background"
              strokeWidth={2.5}
            />
          </Button>
        </PopoverTrigger>
      </CallTooltip>
      <PopoverContent side="top" align="center" sideOffset={10} className="w-72 p-4">
        <PermissionHelp kind={kind} labels={labels} />
      </PopoverContent>
    </Popover>
  );
}

/** One list of devices inside a `DeviceMenu`, with a check on the selected one. */
function DeviceList({
  devices,
  activeId,
  onChange,
  fallbackPrefix,
}: Readonly<{
  devices: MediaDeviceInfo[];
  activeId: string;
  onChange: (deviceId: string) => void;
  fallbackPrefix: string;
}>) {
  return (
    <>
      {devices.map((d) => (
        <DropdownMenuItem
          key={d.deviceId}
          onClick={() => onChange(d.deviceId)}
          className="flex items-center justify-between"
        >
          <span className="truncate">{d.label || `${fallbackPrefix} ${d.deviceId.slice(0, 8)}`}</span>
          {d.deviceId === activeId && <Check className="h-4 w-4 text-primary" />}
        </DropdownMenuItem>
      ))}
    </>
  );
}

/**
 * Chevron dropdown listing input devices (microphone / camera). The microphone
 * menu also lists the speakers (`output`), where the browser can switch them.
 */
function DeviceMenu({
  tooltip,
  off,
  devices,
  activeId,
  onChange,
  fallbackPrefix,
  output,
}: Readonly<{
  tooltip: string;
  off: boolean;
  devices: MediaDeviceInfo[];
  activeId: string;
  onChange: (deviceId: string) => void;
  fallbackPrefix: string;
  output?: {
    devices: MediaDeviceInfo[];
    activeId: string;
    onChange: (deviceId: string) => void;
  };
}>) {
  const hasOutputs = !!output && output.devices.length > 0;
  if (devices.length === 0 && !hasOutputs) return null;
  return (
    <DropdownMenu>
      <CallTooltip label={tooltip}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          size="icon"
          aria-label={tooltip}
          className={cn("group/arrow relative h-12 w-[30px] rounded-none rounded-r-[18px] border-0 border-l border-border/30 px-0 hidden md:flex items-center justify-center transition-colors", off ? `${OFF_STATE_CLASSES} border-l-0` : "hover:bg-secondary")}
        >
          <ArrowChevron tone={off ? 'off' : 'default'} />
        </Button>
      </DropdownMenuTrigger>
      </CallTooltip>
      <DropdownMenuContent side="top" align="start" sideOffset={7} className="w-64">
        {hasOutputs && devices.length > 0 && (
          <DropdownMenuLabel className="text-xs text-muted-foreground font-medium">Microphone</DropdownMenuLabel>
        )}
        <DeviceList devices={devices} activeId={activeId} onChange={onChange} fallbackPrefix={fallbackPrefix} />
        {hasOutputs && (
          <>
            {devices.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-xs text-muted-foreground font-medium">Speaker</DropdownMenuLabel>
            <DeviceList
              devices={output.devices}
              activeId={output.activeId}
              onChange={output.onChange}
              fallbackPrefix="Speaker"
            />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Screen share button + audio / quality options dropdown. */
function ScreenShareControl({
  meeting,
  isScreenSharing,
  startScreenShare,
  stopScreenShare,
  selectedResolutionIdx,
  setSelectedResolutionIdx,
  shareScreenAudio,
  toggleShareScreenAudio,
}: Readonly<{
  meeting: MeetingClient | null;
  isScreenSharing: boolean;
  startScreenShare: (constraints?: DisplayMediaStreamOptions) => Promise<void>;
  stopScreenShare: () => void;
  selectedResolutionIdx: number;
  setSelectedResolutionIdx: (idx: number) => void;
  shareScreenAudio: boolean;
  toggleShareScreenAudio: () => void;
}>) {
  async function selectResolution(idx: number) {
    const res = SCREEN_RESOLUTIONS[idx]!;
    setSelectedResolutionIdx(idx);
    // If already sharing, retune the active track in place via
    // RTK's updateScreenshareConstraints — no need to restart
    // the share or re-prompt for the source picker.
    if (!isScreenSharing || !meeting) return;
    try {
      await meeting.self.updateScreenshareConstraints({
        width: { ideal: res.width },
        height: { ideal: res.height },
        frameRate: { ideal: res.frameRate },
      });
    } catch (err) {
      console.warn('[CallControlsBar] updateScreenshareConstraints failed:', err);
    }
  }

  return (
    <div className="flex items-center rounded-[18px] overflow-hidden ring-1 ring-border">
      <CallTooltip label={isScreenSharing ? 'Stop sharing screen' : 'Share screen'}>
        <Button
          variant={isScreenSharing ? 'default' : 'secondary'}
          size="icon"
          aria-label={isScreenSharing ? 'Stop sharing screen' : 'Share screen'}
          className={cn("group/icon h-12 w-12 rounded-none rounded-l-[18px] border-0 transition-all", isScreenSharing ? "hover:bg-primary" : "hover:bg-secondary")}
          onClick={isScreenSharing ? stopScreenShare : () => {
            const res = SCREEN_RESOLUTIONS[selectedResolutionIdx]!;
            void startScreenShare({
              video: { width: { ideal: res.width }, height: { ideal: res.height }, frameRate: { ideal: res.frameRate } },
              audio: shareScreenAudio,
            }).catch((err: unknown) => {
              console.warn('[CallControlsBar] startScreenShare failed:', err);
            });
          }}
        >
          <IconHighlight tone={isScreenSharing ? 'active' : 'default'}>
            {isScreenSharing ? <MonitorX className="!h-[20px] !w-[20px]" /> : <MonitorUp className="!h-[20px] !w-[20px]" />}
          </IconHighlight>
        </Button>
      </CallTooltip>
      <DropdownMenu>
        <CallTooltip label="Screen share options">
        <DropdownMenuTrigger asChild>
          <Button
            variant={isScreenSharing ? 'default' : 'secondary'}
            size="icon"
            className={cn(
              "group/arrow relative h-12 w-[30px] rounded-none rounded-r-[18px] border-0 px-0 hidden md:flex items-center justify-center transition-colors",
              isScreenSharing
                ? "border-l border-primary-foreground/20 text-primary-foreground/80 hover:bg-primary"
                : "border-l border-border/30 hover:bg-secondary",
            )}
          >
            <ArrowChevron tone={isScreenSharing ? 'active' : 'default'} />
          </Button>
        </DropdownMenuTrigger>
        </CallTooltip>
        <DropdownMenuContent side="top" align="start" sideOffset={7} className="w-64">
          {/* Share-audio toggle — controls whether the captured system/tab
              audio is forwarded. Keep the menu open on click so the user can
              toggle without it dismissing. */}
          <DropdownMenuLabel className="text-xs text-muted-foreground font-medium">Audio</DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={(e) => e.preventDefault()}
            onClick={toggleShareScreenAudio}
            className="flex items-center justify-between"
          >
            <span className="flex items-center gap-2">
              {shareScreenAudio ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
              Share system audio
            </span>
            {shareScreenAudio && <Check className="h-4 w-4 text-primary" />}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs text-muted-foreground font-medium">Quality</DropdownMenuLabel>
          {SCREEN_RESOLUTIONS.map((res, idx) => (
            <DropdownMenuItem
              key={res.label}
              onClick={() => selectResolution(idx)}
              className="flex items-center justify-between"
            >
              <span>{res.label}</span>
              {selectedResolutionIdx === idx && <Check className="h-4 w-4 text-primary" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Recording section of the More-options dropdown. */
function RecordingMenuSection({
  isRecording,
  recordingState,
  startRecording,
  stopRecording,
  pauseRecording,
  resumeRecording,
  runAfterClose,
}: Readonly<Pick<
  CallControlsBarProps,
  'isRecording' | 'recordingState' | 'startRecording' | 'stopRecording' | 'pauseRecording' | 'resumeRecording'
> & {
  /** Closes the menu, then runs the action on the next frame (see `CallControlsBar`). */
  runAfterClose: (action: () => void) => void;
}>) {
  if (!startRecording) return null;
  const paused = recordingState === 'PAUSED';
  return (
    <>
      <DropdownMenuLabel className="text-xs text-muted-foreground font-medium">Recording</DropdownMenuLabel>
      {isRecording ? (
        <>
          <DropdownMenuItem onClick={() => toggleRecordingPause(paused, pauseRecording, resumeRecording)}>
            {paused ? <Play className="h-4 w-4 mr-0.5" /> : <Pause className="h-4 w-4 mr-0.5" />}
            {paused ? 'Resume recording' : 'Pause recording'}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => stopRecordingWithToast(stopRecording)} className="text-red-500 focus:text-red-500">
            <Square className="h-4 w-4 mr-0.5 fill-current" />
            Stop recording
          </DropdownMenuItem>
        </>
      ) : (
          // No "started" toast here: the click only *requests* the recording. The
          // host app confirms it (toast) once the recorder actually reports
          // RECORDING, so a failed or slow start never claims success.
          <DropdownMenuItem
            onClick={() => runAfterClose(() => startRecording?.())}
            disabled={recordingState === 'STARTING' || recordingState === 'STOPPING'}
          >
            <Circle className="h-4 w-4 mr-0.5 text-red-500 fill-red-500" />
            Start recording
          </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
    </>
  );
}

/** Layout section of the More-options dropdown. */
function LayoutMenuSection({ viewMode, setViewMode }: Readonly<{ viewMode: ViewMode; setViewMode: (mode: ViewMode) => void }>) {
  return (
    <>
      <DropdownMenuLabel className="text-xs text-muted-foreground font-medium">Layout</DropdownMenuLabel>
      {LAYOUT_OPTIONS.map(({ value, label, icon: Icon }) => {
        const selected = viewMode === value;
        return (
          <DropdownMenuItem
            key={value}
            onClick={() => setViewMode(value)}
            className={cn(
              'flex items-center justify-between',
              selected && 'bg-accent text-accent-foreground',
            )}
          >
            <span className="flex items-center gap-2">
              <Icon className="h-4 w-4" />
              {label}
            </span>
            {selected && <Check className="h-4 w-4 text-primary" />}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

/** Fullscreen / picture-in-picture section of the More-options dropdown. */
function ViewOptionsMenuSection({
  isFullscreen,
  onToggleFullscreen,
  onPictureInPicture,
}: Readonly<Pick<CallControlsBarProps, 'isFullscreen' | 'onToggleFullscreen' | 'onPictureInPicture'>>) {
  if (!onToggleFullscreen && !onPictureInPicture) return null;
  return (
    <>
      <DropdownMenuSeparator />
      {onToggleFullscreen && (
        <DropdownMenuItem onClick={onToggleFullscreen}>
          {isFullscreen ? <Minimize className="h-4 w-4 mr-0.5" /> : <Maximize className="h-4 w-4 mr-0.5" />}
          {isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        </DropdownMenuItem>
      )}
      {onPictureInPicture && (
        <DropdownMenuItem onClick={onPictureInPicture}>
          <PictureInPicture2 className="h-4 w-4 mr-0.5" />
          Picture in picture
        </DropdownMenuItem>
      )}
    </>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

/** Microphone toggle (or the blocked-permission button) with its device chooser. */
function MicControl({
  isMuted,
  micBlocked,
  toggleMute,
  permissionHelpLabels,
  audioDevices,
  activeDeviceId,
  handleDeviceChange,
  speaker,
}: Readonly<{
  isMuted: boolean;
  micBlocked: boolean;
  toggleMute: () => void;
  permissionHelpLabels: PermissionHelpLabels;
  audioDevices: MediaDeviceInfo[];
  activeDeviceId: string;
  handleDeviceChange: (deviceId: string) => void;
  speaker: ReturnType<typeof useSpeakerDevices>;
}>) {
  return (
    <div className={cn("flex items-center rounded-[18px] overflow-hidden", !(isMuted || micBlocked) && "ring-1 ring-border")}>
      {micBlocked ? (
        <BlockedMediaButton kind="microphone" labels={permissionHelpLabels}>
          <MicOff className="!h-[20px] !w-[20px]" />
        </BlockedMediaButton>
      ) : (
        <CallTooltip label={isMuted ? 'Turn on microphone' : 'Turn off microphone'}>
          <Button
            variant="secondary"
            size="icon"
            aria-label={isMuted ? 'Turn on microphone' : 'Turn off microphone'}
            className={cn("group/icon h-12 w-12 rounded-none rounded-l-[18px] border-0 transition-all", isMuted ? OFF_STATE_CLASSES : "hover:bg-secondary")}
            onClick={toggleMute}
          >
            <IconHighlight tone={isMuted ? 'off' : 'default'}>
              {isMuted ? <MicOff className="!h-[20px] !w-[20px]" /> : <Mic className="!h-[20px] !w-[20px]" />}
            </IconHighlight>
          </Button>
        </CallTooltip>
      )}

      <DeviceMenu
        tooltip="Microphone options"
        off={isMuted || micBlocked}
        devices={audioDevices}
        activeId={activeDeviceId}
        onChange={handleDeviceChange}
        fallbackPrefix="Microphone"
        output={{ devices: speaker.devices, activeId: speaker.activeDeviceId, onChange: speaker.setDeviceId }}
      />
    </div>
  );
}

/** Camera toggle (or the blocked-permission button) with its device chooser. */
function CameraControl({
  isVideoOff,
  cameraBlocked,
  toggleVideo,
  permissionHelpLabels,
  videoDevices,
  activeVideoDeviceId,
  handleVideoDeviceChange,
}: Readonly<{
  isVideoOff: boolean;
  cameraBlocked: boolean;
  toggleVideo: () => void;
  permissionHelpLabels: PermissionHelpLabels;
  videoDevices: MediaDeviceInfo[];
  activeVideoDeviceId: string;
  handleVideoDeviceChange: (deviceId: string) => void;
}>) {
  return (
    <div className={cn("flex items-center rounded-[18px] overflow-hidden", !(isVideoOff || cameraBlocked) && "ring-1 ring-border")}>
      {cameraBlocked ? (
        <BlockedMediaButton kind="camera" labels={permissionHelpLabels}>
          <VideoOff className="!h-[20px] !w-[20px]" />
        </BlockedMediaButton>
      ) : (
        <CallTooltip label={isVideoOff ? 'Turn on camera' : 'Turn off camera'}>
          <Button
            variant="secondary"
            size="icon"
            aria-label={isVideoOff ? 'Turn on camera' : 'Turn off camera'}
            className={cn("group/icon h-12 w-12 rounded-none rounded-l-[18px] border-0 transition-all", isVideoOff ? OFF_STATE_CLASSES : "hover:bg-secondary")}
            onClick={toggleVideo}
          >
            <IconHighlight tone={isVideoOff ? 'off' : 'default'}>
              {isVideoOff ? (
                <VideoOff className="!h-[20px] !w-[20px]" />
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                  className="!h-[22px] !w-[22px]"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"
                  />
                </svg>
              )}
            </IconHighlight>
          </Button>
        </CallTooltip>
      )}
      <DeviceMenu
        tooltip="Camera options"
        off={isVideoOff || cameraBlocked}
        devices={videoDevices}
        activeId={activeVideoDeviceId}
        onChange={handleVideoDeviceChange}
        fallbackPrefix="Camera"
      />
    </div>
  );
}

export function CallControlsBar({
  meeting,
  isMuted,
  isVideoOff,
  isScreenSharing,
  handRaised,
  viewMode,
  toggleMute,
  toggleVideo,
  startScreenShare,
  stopScreenShare,
  toggleHandRaise,
  setViewMode,
  onLeave,
  onEndForAll,
  leaveLabels,
  micBlocked = false,
  cameraBlocked = false,
  permissionHelpLabels = DEFAULT_PERMISSION_HELP_LABELS,
  onToggleEffects,
  effectsOpen,
  isRecording,
  recordingState,
  startRecording,
  stopRecording,
  pauseRecording,
  resumeRecording,
  isFullscreen,
  onToggleFullscreen,
  onPictureInPicture,
  onOpenSettings,
  onOpenInfo,
  onOpenTools,
  gates,
  extraControls,
}: Readonly<CallControlsBarProps>) {
  const isMobile = useIsMobile();
  const canShareScreen = useCanShareScreen();
  const showScreenShare = gates?.screenShare !== false && canShareScreen;
  const showHandRaise = gates?.handRaise !== false;
  const showVirtualBackgrounds = gates?.virtualBackgrounds !== false;
  const {
    audioDevices,
    videoDevices,
    activeDeviceId,
    activeVideoDeviceId,
    handleDeviceChange,
    handleVideoDeviceChange,
  } = useMeetingDevices(meeting);
  const speaker = useSpeakerDevices();
  const [selectedResolutionIdx, setSelectedResolutionIdx] = useState(
    SCREEN_RESOLUTIONS.findIndex((r) => r.width === 1920 && r.height === 1080 && r.frameRate === 60),
  );
  const { shareScreenAudio, toggleShareScreenAudio } = useShareScreenAudio(meeting, isScreenSharing);

  // The More-options menu is controlled so the items that open a side panel
  // (Host controls, Background effects, Start recording's dialog) can close it
  // *first*. Left to Radix, the menu stayed open over the panel it had just
  // opened: the panel mounts in the same commit that Radix is still restoring
  // focus to the trigger. Closing, then running the action on the next frame,
  // keeps the two apart.
  const [moreOpen, setMoreOpen] = useState(false);
  const runAfterClose = useCallback((action: () => void) => {
    setMoreOpen(false);
    requestAnimationFrame(action);
  }, []);

  return (
    <div className="flex items-center justify-center gap-2 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:gap-3 md:p-4 bg-background/80 backdrop-blur">
      <MicControl
        isMuted={isMuted}
        micBlocked={micBlocked}
        toggleMute={toggleMute}
        permissionHelpLabels={permissionHelpLabels}
        audioDevices={audioDevices}
        activeDeviceId={activeDeviceId}
        handleDeviceChange={handleDeviceChange}
        speaker={speaker}
      />

      <CameraControl
        isVideoOff={isVideoOff}
        cameraBlocked={cameraBlocked}
        toggleVideo={toggleVideo}
        permissionHelpLabels={permissionHelpLabels}
        videoDevices={videoDevices}
        activeVideoDeviceId={activeVideoDeviceId}
        handleVideoDeviceChange={handleVideoDeviceChange}
      />

      {/* Screen share + resolution */}
      {showScreenShare && (
        <ScreenShareControl
          meeting={meeting}
          isScreenSharing={isScreenSharing}
          startScreenShare={startScreenShare}
          stopScreenShare={stopScreenShare}
          selectedResolutionIdx={selectedResolutionIdx}
          setSelectedResolutionIdx={setSelectedResolutionIdx}
          shareScreenAudio={shareScreenAudio}
          toggleShareScreenAudio={toggleShareScreenAudio}
        />
      )}

      {/* Hand raise */}
      {showHandRaise && (
        <div className="rounded-[18px] overflow-hidden ring-1 ring-border">
          <CallTooltip label={handRaised ? 'Lower hand' : 'Raise hand'}>
            <Button
              variant={handRaised ? 'default' : 'secondary'}
              size="icon"
              aria-label={handRaised ? 'Lower hand' : 'Raise hand'}
              className={cn("group/icon h-12 w-12 rounded-[18px] border-0 transition-all", handRaised ? "hover:bg-primary" : "hover:bg-secondary")}
              onClick={toggleHandRaise}
            >
              <IconHighlight tone={handRaised ? 'active' : 'default'} fill>
                <Hand className="!h-[20px] !w-[20px]" />
              </IconHighlight>
            </Button>
          </CallTooltip>
        </div>
      )}

      {/* More options — a bottom sheet on phones, a dropdown elsewhere */}
      {isMobile ? (
        <div className="rounded-[18px] overflow-hidden ring-1 ring-border">
          <Button
            variant="secondary"
            size="icon"
            aria-label="More options"
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            className="group/icon h-12 w-12 rounded-[18px] border-0 transition-all hover:bg-secondary"
            onClick={() => setMoreOpen(true)}
          >
            <IconHighlight tone="default" fill>
              <EllipsisVertical className="!h-[20px] !w-[20px]" />
            </IconHighlight>
          </Button>
          <CallControlsMoreSheet
            open={moreOpen}
            onOpenChange={setMoreOpen}
            runAfterClose={runAfterClose}
            viewMode={viewMode}
            setViewMode={setViewMode}
            onOpenInfo={onOpenInfo}
            onOpenTools={onOpenTools}
            onToggleEffects={showVirtualBackgrounds ? onToggleEffects : undefined}
            effectsOpen={effectsOpen}
            isFullscreen={isFullscreen}
            onToggleFullscreen={onToggleFullscreen}
            onPictureInPicture={onPictureInPicture}
            onOpenSettings={onOpenSettings}
            deviceGroups={[
              { label: 'Camera', fallbackPrefix: 'Camera', devices: videoDevices, activeId: activeVideoDeviceId, onChange: handleVideoDeviceChange },
              { label: 'Microphone', fallbackPrefix: 'Microphone', devices: audioDevices, activeId: activeDeviceId, onChange: handleDeviceChange },
              { label: 'Speaker', fallbackPrefix: 'Speaker', devices: speaker.devices, activeId: speaker.activeDeviceId, onChange: speaker.setDeviceId },
            ]}
            isRecording={isRecording}
            recordingState={recordingState}
            startRecording={startRecording}
            stopRecording={stopRecording}
            pauseRecording={pauseRecording}
            resumeRecording={resumeRecording}
          />
        </div>
      ) : (
      <div className="rounded-[18px] overflow-hidden ring-1 ring-border">
        <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
          <CallTooltip label="More options">
            <DropdownMenuTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                aria-label="More options"
                className="group/icon h-12 w-12 rounded-[18px] border-0 transition-all hover:bg-secondary"
              >
                <IconHighlight tone="default" fill>
                  <EllipsisVertical className="!h-[20px] !w-[20px]" />
                </IconHighlight>
              </Button>
            </DropdownMenuTrigger>
          </CallTooltip>
          <DropdownMenuContent side="top" align="start" sideOffset={7} className="w-56">
            <RecordingMenuSection
              isRecording={isRecording}
              recordingState={recordingState}
              startRecording={startRecording}
              stopRecording={stopRecording}
              pauseRecording={pauseRecording}
              resumeRecording={resumeRecording}
              runAfterClose={runAfterClose}
            />

            {/* Background effects */}
            {onToggleEffects && showVirtualBackgrounds && (
              <>
                <DropdownMenuItem onClick={() => runAfterClose(onToggleEffects)}>
                  <Image className="h-4 w-4 mr-0.5" />
                  Background effects
                  {effectsOpen && <Check className="h-4 w-4 ml-auto" />}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}

            <LayoutMenuSection viewMode={viewMode} setViewMode={setViewMode} />

            <ViewOptionsMenuSection
              isFullscreen={isFullscreen}
              onToggleFullscreen={onToggleFullscreen}
              onPictureInPicture={onPictureInPicture}
            />

            {/* Host controls — opens the right-side settings panel */}
            {onOpenSettings && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => runAfterClose(onOpenSettings)}>
                  <Settings className="h-4 w-4 mr-0.5" />
                  Host controls
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      )}

      {/* Leave/End */}
      {onEndForAll ? (
        <DropdownMenu>
          <CallTooltip label={leaveLabels?.leave ?? 'Leave call'}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="destructive"
                size="icon"
                aria-label={leaveLabels?.leave ?? 'Leave call'}
                className="h-12 w-14 md:w-[70px] rounded-[18px] transition-all [&]:hover:brightness-90"
              >
                <Phone className="!h-[20px] !w-[20px] rotate-[135deg] fill-current" />
              </Button>
            </DropdownMenuTrigger>
          </CallTooltip>
          <DropdownMenuContent side="top" align="end" sideOffset={7} className="w-56">
            <DropdownMenuItem onClick={onLeave}>
              <LogOut className="h-4 w-4 mr-0.5" />
              {leaveLabels?.leaveMeeting ?? 'Leave meeting'}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onEndForAll} className="text-red-500 focus:text-red-500">
              <Phone className="h-4 w-4 mr-0.5 rotate-[135deg]" />
              {leaveLabels?.endForAll ?? 'End meeting for all'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <CallTooltip label={leaveLabels?.leave ?? 'Leave call'}>
          <Button
            variant="destructive"
            size="icon"
            aria-label={leaveLabels?.leave ?? 'Leave call'}
            className="h-12 w-14 md:w-[70px] rounded-[18px] transition-all [&]:hover:brightness-90"
            onClick={onLeave}
          >
            <Phone className="!h-[20px] !w-[20px] rotate-[135deg] fill-current" />
          </Button>
        </CallTooltip>
      )}

      {/* Extra controls slot */}
      {extraControls}
    </div>
  );
}
