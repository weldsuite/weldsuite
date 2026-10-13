'use client';

import type RealtimeKitClient from '@cloudflare/realtimekit';
import type { Ref } from 'react';

import {
  BackgroundEffectsPanel,
  CallControlsBar,
  ParticipantAvatar,
  ParticipantNameTag,
  type ViewMode,
} from '@weldsuite/weldmeet-ui';
import { Loader2 } from 'lucide-react';

import { PREVIEW_DARK_BG, type PersonTheme } from '@/lib/constants';

import type { PermState } from './prejoin-media-controls';

// Shown, but not usable until the host lets the guest in: nobody in the
// meeting would see a shared screen or a raised hand from the waiting room.
const WAITING_ROOM_DISABLED_CONTROLS = {
  screenShare: "You can share your screen once you're in the meeting",
  handRaise: "You can raise your hand once you're in the meeting",
};

const noop = () => {};
const noopAsync = async () => {};

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
}: Readonly<WaitlistedScreenProps>) {
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
                <ParticipantAvatar initials={waitInitials} color={personTheme.avatar} size="tile" />
              )}
              <ParticipantNameTag name={guestName || 'You'} audioEnabled={audioOn} />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Loader2 className="h-4 w-4 animate-spin text-white/40" />
            <p className="text-[15px] text-white/60">Waiting for the host to let you in...</p>
          </div>
        </div>

        {/* The in-meeting bar, so the guest sets up exactly what they will
            have once admitted. Devices come from the preview stream here. */}
        <CallControlsBar
          meeting={null}
          isMuted={!previewAudioEnabled}
          isVideoOff={!previewVideoEnabled}
          isScreenSharing={false}
          handRaised={false}
          viewMode={preferredViewMode}
          toggleMute={togglePreviewAudio}
          toggleVideo={togglePreviewVideo}
          startScreenShare={noopAsync}
          stopScreenShare={noop}
          toggleHandRaise={noop}
          setViewMode={setPreferredViewMode}
          onLeave={onLeave}
          micBlocked={audioPermission === 'denied'}
          cameraBlocked={videoPermission === 'denied'}
          onToggleEffects={() => setEffectsOpen(!effectsOpen)}
          effectsOpen={effectsOpen}
          isFullscreen={isFullscreen}
          onToggleFullscreen={toggleFullscreen}
          deviceSource={{
            audioDevices: audioInputs,
            videoDevices: videoInputs,
            activeDeviceId: selectedAudioInput,
            activeVideoDeviceId: selectedVideoInput,
            handleDeviceChange: changeAudioDevice,
            handleVideoDeviceChange: changeVideoDevice,
          }}
          disabledControls={WAITING_ROOM_DISABLED_CONTROLS}
        />
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
