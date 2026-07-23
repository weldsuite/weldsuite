import { useEffect, useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Mic, MicOff, VideoOff, MonitorUp, MonitorX, Phone, ChevronUp, Check, Hand, LayoutGrid, GalleryHorizontalEnd, User, PanelRight, Image, Circle, Square, Pause, Play, EllipsisVertical, Maximize, Minimize, PictureInPicture2, Settings, Volume2, VolumeX } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@weldsuite/ui/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '@weldsuite/ui/components/dropdown-menu';
import type { ViewMode, RecordingState } from '../types';

// ─── Tooltip ─────────────────────────────────────────────────────────────────

function CallTooltip({ label, children }: { label: string; children: React.ReactNode }) {
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
  meeting: any;
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

  // Background effects (optional)
  onToggleEffects?: () => void;
  effectsOpen?: boolean;
  backgroundType?: any;

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

// ─── Component ───────────────────────────────────────────────────────────────

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
  gates,
  extraControls,
}: CallControlsBarProps) {
  const showScreenShare = gates?.screenShare !== false;
  const showHandRaise = gates?.handRaise !== false;
  const showVirtualBackgrounds = gates?.virtualBackgrounds !== false;
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string>('');
  const [activeVideoDeviceId, setActiveVideoDeviceId] = useState<string>('');
  const [selectedResolutionIdx, setSelectedResolutionIdx] = useState(
    SCREEN_RESOLUTIONS.findIndex((r) => r.width === 1920 && r.height === 1080 && r.frameRate === 60),
  );
  // Whether the audio captured alongside the screen share (system / tab audio)
  // is forwarded to other participants. RTK always requests `audio: true` when
  // it calls getDisplayMedia internally, so an audio track exists whenever the
  // user ticked "share audio" in the browser's source picker. This toggle, in
  // the screen-share options dropdown, lets the user mute/unmute that captured
  // audio live without re-prompting — we just flip the track's `enabled` flag.
  // Defaults to on, preserving the previous behaviour (captured audio shared).
  const [shareScreenAudio, setShareScreenAudio] = useState(true);

  useEffect(() => {
    if (!meeting) return;

    let cancelled = false;
    async function loadDevices() {
      try {
        const all = await meeting.self.getAllDevices();
        if (cancelled) return;
        const inputs = (all ?? []).filter((d: any) => d.kind === 'audioinput') as MediaDeviceInfo[];
        const videos = (all ?? []).filter((d: any) => d.kind === 'videoinput') as MediaDeviceInfo[];
        setAudioDevices(inputs);
        setVideoDevices(videos);

        const current = meeting.self.getCurrentDevices();
        if (current?.audio?.deviceId) {
          setActiveDeviceId(current.audio.deviceId);
        } else if (inputs.length > 0) {
          setActiveDeviceId(inputs[0]!.deviceId);
        }
        if (current?.video?.deviceId) {
          setActiveVideoDeviceId(current.video.deviceId);
        } else if (videos.length > 0) {
          setActiveVideoDeviceId(videos[0]!.deviceId);
        }
      } catch { /* devices not available */ }
    }

    loadDevices();

    // Refresh device list whenever the OS reports a change — covers OBS
    // Virtual Camera starting after meeting join, USB cam plug/unplug,
    // bluetooth headset connect, etc. Without this, the dropdown is frozen
    // at whatever was available at meeting-connect time.
    const onDeviceChange = () => { loadDevices(); };
    try {
      navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
    } catch { /* not available in this environment */ }

    // RTK also surfaces device updates via its own event. Subscribing to
    // both is harmless (loadDevices is idempotent) and catches cases where
    // RTK observes a change before the browser fires devicechange.
    try { meeting.self.on?.('deviceListUpdate', onDeviceChange); } catch { /* ignore */ }

    return () => {
      cancelled = true;
      try {
        navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
      } catch { /* ignore */ }
      try { meeting.self.off?.('deviceListUpdate', onDeviceChange); } catch { /* ignore */ }
    };
  }, [meeting]);

  async function handleDeviceChange(deviceId: string) {
    if (!meeting) return;
    const device = audioDevices.find((d) => d.deviceId === deviceId);
    if (!device) return;
    try {
      await meeting.self.setDevice(device);
      setActiveDeviceId(deviceId);
    } catch { /* ignore */ }
  }

  async function handleVideoDeviceChange(deviceId: string) {
    if (!meeting) return;
    const device = videoDevices.find((d) => d.deviceId === deviceId);
    if (!device) return;
    try {
      await meeting.self.setDevice(device);
      setActiveVideoDeviceId(deviceId);
    } catch { /* ignore */ }
  }

  // Apply the share-audio preference to the screen-share audio track. Used both
  // when toggling live (during an active share) and when a share starts.
  const applyScreenShareAudio = useCallback((enabled: boolean) => {
    if (!meeting) return;
    try {
      const track = (meeting.self as any).screenShareTracks?.audio as MediaStreamTrack | undefined;
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
      const track = (meeting.self as any).screenShareTracks?.audio as MediaStreamTrack | undefined;
      if (track) { track.enabled = shareScreenAudio; return; }
      if (tries++ < 10) setTimeout(apply, 100);
    };
    apply();
    return () => { cancelled = true; };
  }, [isScreenSharing, meeting, shareScreenAudio]);

  return (
    <div className="flex items-center justify-center gap-3 p-4 bg-background/80 backdrop-blur">
      {/* Mic button + device chooser */}
      <div className={cn("flex items-center rounded-[18px] overflow-hidden ring-1", isMuted ? "ring-red-400/40" : "ring-border")}>
        <CallTooltip label={isMuted ? 'Turn on microphone' : 'Turn off microphone'}>
          <Button
            variant="secondary"
            size="icon"
            className={cn("h-12 w-12 rounded-none rounded-l-[18px] border-0 transition-all", isMuted ? "bg-red-100 hover:bg-red-200 text-red-500 dark:bg-red-500/20 dark:hover:bg-red-500/30 dark:text-red-400" : "[&]:hover:brightness-95 dark:[&]:hover:brightness-110")}
            onClick={toggleMute}
          >
            {isMuted ? <MicOff className="!h-[20px] !w-[20px]" /> : <Mic className="!h-[20px] !w-[20px]" />}
          </Button>
        </CallTooltip>

        {audioDevices.length > 0 && (
          <DropdownMenu>
            <CallTooltip label="Microphone options">
            <DropdownMenuTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                className={cn("group/arrow h-12 w-8 rounded-none rounded-r-[18px] border-0 border-l border-border/30 px-0 hidden md:flex items-center justify-center transition-colors", isMuted ? "bg-red-100 hover:bg-red-200 text-red-500 dark:bg-red-500/20 dark:hover:bg-red-500/30 dark:text-red-400 border-red-400/20 data-[state=open]:bg-red-200 dark:data-[state=open]:bg-red-500/30" : "[&]:hover:brightness-95 dark:[&]:hover:brightness-110 data-[state=open]:brightness-95 dark:data-[state=open]:brightness-110")}
              >
                <ChevronUp className="h-4 w-4 -translate-x-px transition-transform duration-200 group-data-[state=open]/arrow:rotate-180" />
              </Button>
            </DropdownMenuTrigger>
            </CallTooltip>
            <DropdownMenuContent side="top" align="start" sideOffset={7} className="w-64">
              <DropdownMenuRadioGroup value={activeDeviceId} onValueChange={handleDeviceChange}>
                {audioDevices.map((d) => (
                  <DropdownMenuRadioItem key={d.deviceId} value={d.deviceId} className="truncate">
                    <span className="truncate">{d.label || `Microphone ${d.deviceId.slice(0, 8)}`}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Camera button + device chooser */}
      <div className={cn("flex items-center rounded-[18px] overflow-hidden ring-1", isVideoOff ? "ring-red-400/40" : "ring-border")}>
        <CallTooltip label={isVideoOff ? 'Turn on camera' : 'Turn off camera'}>
          <Button
            variant="secondary"
            size="icon"
            className={cn("h-12 w-12 rounded-none rounded-l-[18px] border-0 transition-all", isVideoOff ? "bg-red-100 hover:bg-red-200 text-red-500 dark:bg-red-500/20 dark:hover:bg-red-500/30 dark:text-red-400" : "[&]:hover:brightness-95 dark:[&]:hover:brightness-110")}
            onClick={toggleVideo}
          >
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
          </Button>
        </CallTooltip>
        {videoDevices.length > 0 && (
          <DropdownMenu>
            <CallTooltip label="Camera options">
            <DropdownMenuTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                className={cn("group/arrow h-12 w-8 rounded-none rounded-r-[18px] border-0 border-l border-border/30 px-0 hidden md:flex items-center justify-center transition-colors", isVideoOff ? "bg-red-100 hover:bg-red-200 text-red-500 dark:bg-red-500/20 dark:hover:bg-red-500/30 dark:text-red-400 border-red-400/20 data-[state=open]:bg-red-200 dark:data-[state=open]:bg-red-500/30" : "[&]:hover:brightness-95 dark:[&]:hover:brightness-110 data-[state=open]:brightness-95 dark:data-[state=open]:brightness-110")}
              >
                <ChevronUp className="h-4 w-4 -translate-x-px transition-transform duration-200 group-data-[state=open]/arrow:rotate-180" />
              </Button>
            </DropdownMenuTrigger>
            </CallTooltip>
            <DropdownMenuContent side="top" align="start" sideOffset={7} className="w-64">
              <DropdownMenuRadioGroup value={activeVideoDeviceId} onValueChange={handleVideoDeviceChange}>
                {videoDevices.map((d) => (
                  <DropdownMenuRadioItem key={d.deviceId} value={d.deviceId} className="truncate">
                    <span className="truncate">{d.label || `Camera ${d.deviceId.slice(0, 8)}`}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Screen share + resolution */}
      {showScreenShare && (
      <div className="flex items-center rounded-[18px] overflow-hidden ring-1 ring-border">
        <CallTooltip label={isScreenSharing ? 'Stop sharing screen' : 'Share screen'}>
          <Button
            variant={isScreenSharing ? 'default' : 'secondary'}
            size="icon"
            className="h-12 w-12 rounded-none rounded-l-[18px] border-0 transition-all [&]:hover:brightness-95 dark:[&]:hover:brightness-110"
            onClick={isScreenSharing ? stopScreenShare : () => {
              const res = SCREEN_RESOLUTIONS[selectedResolutionIdx]!;
              startScreenShare({
                video: { width: { ideal: res.width }, height: { ideal: res.height }, frameRate: { ideal: res.frameRate } },
                audio: shareScreenAudio,
              });
            }}
          >
            {isScreenSharing ? <MonitorX className="!h-[20px] !w-[20px]" /> : <MonitorUp className="!h-[20px] !w-[20px]" />}
          </Button>
        </CallTooltip>
        <DropdownMenu>
          <CallTooltip label="Screen share options">
          <DropdownMenuTrigger asChild>
            <Button
              variant={isScreenSharing ? 'default' : 'secondary'}
              size="icon"
              className={cn(
                "group/arrow h-12 w-8 rounded-none rounded-r-[18px] border-0 px-0 hidden md:flex items-center justify-center transition-colors",
                isScreenSharing
                  ? "border-l border-primary-foreground/20 text-primary-foreground/80 hover:brightness-110 data-[state=open]:brightness-110"
                  : "border-l border-border/30 [&]:hover:brightness-95 dark:[&]:hover:brightness-110 data-[state=open]:brightness-95 dark:data-[state=open]:brightness-110",
              )}
            >
              <ChevronUp className="h-4 w-4 -translate-x-px transition-transform duration-200 group-data-[state=open]/arrow:rotate-180" />
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
                onClick={async () => {
                  setSelectedResolutionIdx(idx);
                  // If already sharing, retune the active track in place via
                  // RTK's updateScreenshareConstraints — no need to restart
                  // the share or re-prompt for the source picker.
                  if (isScreenSharing && meeting) {
                    try {
                      await (meeting.self as any).updateScreenshareConstraints({
                        width: { ideal: res.width },
                        height: { ideal: res.height },
                        frameRate: { ideal: res.frameRate },
                      });
                    } catch (err) {
                      console.warn('[CallControlsBar] updateScreenshareConstraints failed:', err);
                    }
                  }
                }}
                className="flex items-center justify-between"
              >
                <span>{res.label}</span>
                {selectedResolutionIdx === idx && <Check className="h-4 w-4 text-primary" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      )}

      {/* Hand raise */}
      {showHandRaise && (
        <div className="rounded-[18px] overflow-hidden ring-1 ring-border">
          <CallTooltip label={handRaised ? 'Lower hand' : 'Raise hand'}>
            <Button
              variant={handRaised ? 'default' : 'secondary'}
              size="icon"
              className="h-12 w-12 rounded-[18px] border-0 transition-all [&]:hover:brightness-95 dark:[&]:hover:brightness-110"
              onClick={toggleHandRaise}
            >
              <Hand className="!h-[20px] !w-[20px]" />
            </Button>
          </CallTooltip>
        </div>
      )}

      {/* More options */}
      <div className="rounded-[18px] overflow-hidden ring-1 ring-border">
        <DropdownMenu>
          <CallTooltip label="More options">
            <DropdownMenuTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                className="h-12 w-12 rounded-[18px] border-0 transition-all [&]:hover:brightness-95 dark:[&]:hover:brightness-110 data-[state=open]:brightness-95 dark:data-[state=open]:brightness-110"
              >
                <EllipsisVertical className="!h-[20px] !w-[20px]" />
              </Button>
            </DropdownMenuTrigger>
          </CallTooltip>
          <DropdownMenuContent side="top" align="start" sideOffset={7} className="w-56">
            {/* Recording */}
            {startRecording && (
              <>
                <DropdownMenuLabel className="text-xs text-muted-foreground font-medium">Recording</DropdownMenuLabel>
                {isRecording ? (
                  <>
                    <DropdownMenuItem onClick={() => {
                      if (recordingState === 'PAUSED') {
                        resumeRecording?.();
                        toast.success('Recording resumed');
                      } else {
                        pauseRecording?.();
                        toast('Recording paused');
                      }
                    }}>
                      {recordingState === 'PAUSED' ? <Play className="h-4 w-4 mr-0.5" /> : <Pause className="h-4 w-4 mr-0.5" />}
                      {recordingState === 'PAUSED' ? 'Resume recording' : 'Pause recording'}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => { stopRecording?.(); toast('Recording stopped. It will be available shortly.'); }} className="text-red-500 focus:text-red-500">
                      <Square className="h-4 w-4 mr-0.5 fill-current" />
                      Stop recording
                    </DropdownMenuItem>
                  </>
                ) : (
                  <DropdownMenuItem
                    onClick={() => { startRecording?.(); toast.success('Recording started. All participants will be notified.'); }}
                    disabled={recordingState === 'STARTING' || recordingState === 'STOPPING'}
                  >
                    <Circle className="h-4 w-4 mr-0.5 text-red-500 fill-red-500" />
                    Start recording
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
              </>
            )}

            {/* Background effects */}
            {onToggleEffects && showVirtualBackgrounds && (
              <>
                <DropdownMenuItem onClick={onToggleEffects}>
                  <Image className="h-4 w-4 mr-0.5" />
                  Background effects
                  {effectsOpen && <Check className="h-4 w-4 ml-auto" />}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}

            {/* Layout */}
            <DropdownMenuLabel className="text-xs text-muted-foreground font-medium">Layout</DropdownMenuLabel>
            {([
              { value: 'grid', label: 'Grid', icon: LayoutGrid },
              { value: 'spotlight', label: 'Spotlight', icon: User },
              { value: 'speaker', label: 'Speaker', icon: GalleryHorizontalEnd },
              { value: 'sidebar', label: 'Sidebar', icon: PanelRight },
            ] as const).map(({ value, label, icon: Icon }) => {
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

            {/* View options */}
            {(onToggleFullscreen || onPictureInPicture) && (
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
            )}

            {/* Host controls — opens the right-side settings panel */}
            {onOpenSettings && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onOpenSettings}>
                  <Settings className="h-4 w-4 mr-0.5" />
                  Host controls
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Leave/End */}
      <CallTooltip label="Leave call">
        <Button
          variant="destructive"
          size="icon"
          className="h-12 w-[70px] rounded-[18px] transition-all [&]:hover:brightness-90"
          onClick={onLeave}
        >
          <Phone className="!h-[20px] !w-[20px] rotate-[135deg] fill-current" />
        </Button>
      </CallTooltip>

      {/* Extra controls slot */}
      {extraControls}
    </div>
  );
}
