'use client';

import type RealtimeKitClient from '@cloudflare/realtimekit';
import type { Ref } from 'react';

import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { cn } from '@weldsuite/ui/lib/utils';
import {
  BackgroundEffectsPanel,
  ParticipantAvatar,
  ParticipantNameTag,
  type ViewMode,
} from '@weldsuite/weldmeet-ui';
import {
  Check,
  EllipsisVertical,
  GalleryHorizontalEnd,
  Image as ImageIcon,
  LayoutGrid,
  Loader2,
  Maximize,
  Minimize,
  PanelRight,
  Phone,
  User,
} from 'lucide-react';

import { PREVIEW_DARK_BG, type PersonTheme } from '@/lib/constants';

import { PrejoinMediaControls, type PermState } from './prejoin-media-controls';

interface WaitlistedScreenProps {
  guestName: string;
  personTheme: PersonTheme;
  videoRef: Ref<HTMLVideoElement>;

  rtkClient: RealtimeKitClient | null;
  previewStream: MediaStream | null;
  previewAudioEnabled: boolean;
  previewVideoEnabled: boolean;
  audioPermission: PermState;
  videoPermission: PermState;
  audioInputs: MediaDeviceInfo[];
  videoInputs: MediaDeviceInfo[];
  selectedAudioInput: string;
  selectedVideoInput: string;

  togglePreviewAudio: () => void;
  togglePreviewVideo: () => void;
  changeAudioDevice: (deviceId: string) => void;
  changeVideoDevice: (deviceId: string) => void;

  isFullscreen: boolean;
  effectsOpen: boolean;
  setEffectsOpen: (open: boolean) => void;
  preferredViewMode: ViewMode;
  setPreferredViewMode: (mode: ViewMode) => void;

  backgroundType: 'none' | 'blur' | 'image';
  backgroundValue: string | null;
  isBackgroundLoading: boolean;
  applyBlur: (radius?: number) => void | Promise<void>;
  applyImage: (url: string) => void | Promise<void>;
  removeBackground: () => void | Promise<void>;

  onLeave: () => void;
}

export function WaitlistedScreen({
  guestName,
  personTheme,
  videoRef,
  rtkClient,
  previewStream,
  previewAudioEnabled,
  previewVideoEnabled,
  audioPermission,
  videoPermission,
  audioInputs,
  videoInputs,
  selectedAudioInput,
  selectedVideoInput,
  togglePreviewAudio,
  togglePreviewVideo,
  changeAudioDevice,
  changeVideoDevice,
  isFullscreen,
  effectsOpen,
  setEffectsOpen,
  preferredViewMode,
  setPreferredViewMode,
  backgroundType,
  backgroundValue,
  isBackgroundLoading,
  applyBlur,
  applyImage,
  removeBackground,
  onLeave,
}: WaitlistedScreenProps) {
  const waitInitials = guestName
    ? guestName.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
    : 'Y';

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  };

  const rtkVideoOn = !!rtkClient?.self?.videoEnabled && !!rtkClient?.self?.videoTrack;
  const rtkAudioOn = !!rtkClient?.self?.audioEnabled;
  // Prefer RTK self state once we're connected; fall back to the preview
  // stream during the brief landing→connecting window.
  const showingVideo = rtkClient ? rtkVideoOn : (previewVideoEnabled && !!previewStream);
  const audioOn = rtkClient ? rtkAudioOn : previewAudioEnabled;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <div className="relative flex flex-col flex-1 min-w-0 min-h-0">
        <div className="flex-1 flex flex-col items-center justify-center text-center px-6 min-h-0">
          <div className="w-full max-w-[450px] mb-6">
            <div
              className="relative w-full h-[280px] ring-1 ring-white/[0.06] rounded-2xl overflow-hidden flex items-center justify-center transition-colors duration-300 [container-type:size]"
              style={{ backgroundColor: showingVideo ? PREVIEW_DARK_BG : personTheme.tile }}
            >
              {showingVideo ? (
                <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover -scale-x-100" />
              ) : (
                <ParticipantAvatar initials={waitInitials} color={personTheme.avatar} />
              )}
              <ParticipantNameTag name={guestName || 'You'} audioEnabled={audioOn} />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Loader2 className="h-4 w-4 animate-spin text-white/40" />
            <p className="text-[15px] text-white/60">Waiting for the host to let you in...</p>
          </div>
        </div>

        <div className="flex items-center justify-center gap-3 pb-6 pt-4">
          <PrejoinMediaControls
            previewAudioEnabled={previewAudioEnabled}
            previewVideoEnabled={previewVideoEnabled}
            audioPermission={audioPermission}
            videoPermission={videoPermission}
            audioInputs={audioInputs}
            videoInputs={videoInputs}
            selectedAudioInput={selectedAudioInput}
            selectedVideoInput={selectedVideoInput}
            togglePreviewAudio={togglePreviewAudio}
            togglePreviewVideo={togglePreviewVideo}
            changeAudioDevice={changeAudioDevice}
            changeVideoDevice={changeVideoDevice}
          />

          <div className="rounded-[18px] overflow-hidden ring-1 ring-border">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label="More options"
                  className="h-12 w-12 rounded-[18px] border-0 transition-all [&]:hover:brightness-95 dark:[&]:hover:brightness-110 data-[state=open]:brightness-95 dark:data-[state=open]:brightness-110 focus-visible:ring-0 focus-visible:border-transparent"
                >
                  <EllipsisVertical className="!h-[20px] !w-[20px]" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" sideOffset={7} className="w-56">
                <DropdownMenuItem onClick={() => setEffectsOpen(!effectsOpen)}>
                  <ImageIcon className="h-4 w-4 mr-0.5" />
                  Background effects
                  {effectsOpen && <Check className="h-4 w-4 ml-auto" />}
                </DropdownMenuItem>
                <DropdownMenuSeparator />

                <DropdownMenuLabel className="text-xs text-muted-foreground font-medium">Layout</DropdownMenuLabel>
                {([
                  { value: 'grid' as const, label: 'Grid', icon: LayoutGrid },
                  { value: 'spotlight' as const, label: 'Spotlight', icon: User },
                  { value: 'speaker' as const, label: 'Speaker', icon: GalleryHorizontalEnd },
                  { value: 'sidebar' as const, label: 'Sidebar', icon: PanelRight },
                ]).map(({ value, label, icon: Icon }) => {
                  const selected = preferredViewMode === value;
                  return (
                    <DropdownMenuItem
                      key={value}
                      onClick={() => setPreferredViewMode(value)}
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

                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={toggleFullscreen}>
                  {isFullscreen ? <Minimize className="h-4 w-4 mr-0.5" /> : <Maximize className="h-4 w-4 mr-0.5" />}
                  {isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <Button
            variant="destructive"
            size="icon"
            aria-label="Leave call"
            className="h-12 w-[70px] rounded-[18px] transition-all [&]:hover:brightness-90"
            onClick={onLeave}
          >
            <Phone className="!h-[20px] !w-[20px] rotate-[135deg] fill-current" />
          </Button>
        </div>
      </div>
      <BackgroundEffectsPanel
        backgroundType={backgroundType}
        backgroundValue={backgroundValue}
        isLoading={isBackgroundLoading}
        isOpen={effectsOpen}
        localParticipant={rtkClient?.self}
        onApplyBlur={applyBlur}
        onApplyImage={applyImage}
        onRemove={removeBackground}
        onClose={() => setEffectsOpen(false)}
      />
    </div>
  );
}
