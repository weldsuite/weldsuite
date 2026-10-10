import { useEffect, useRef } from 'react';
import { ChevronUp, CircleAlert, Mic, MicOff, VideoIcon, VideoOff, type LucideIcon } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { cn } from '@weldsuite/ui/lib/utils';
import {
  DEFAULT_PERMISSION_HELP_LABELS,
  PermissionHelp,
  type PermissionHelpLabels,
  type PermissionKind,
} from './permission-help';

/** Browser permission state of one device kind, as far as the host app knows. */
export type PreviewPermission = 'granted' | 'denied' | 'prompt' | 'unknown';

/**
 * Copy for the pre-join screen. The package has no i18n of its own, so host apps
 * that translate pass their own strings; the English defaults keep every
 * existing caller unchanged.
 */
export interface PreviewViewLabels {
  /** Heading when the meeting has no title. */
  defaultTitle: string;
  subtitle: string;
  cancel: string;
  join: string;
  turnOnMicrophone: string;
  turnOffMicrophone: string;
  turnOnCamera: string;
  turnOffCamera: string;
  /** Header of the microphone device menu. */
  microphone: string;
  /** Header of the camera device menu. */
  camera: string;
  /** Prefix for a device the browser gives no label for (before permission). */
  microphoneFallback: string;
  cameraFallback: string;
  noMicrophones: string;
  noCameras: string;
  permissionRequired: string;
  /** Empty state: both devices are blocked by the browser. */
  blockedTitle: string;
  blockedDescription: string;
  blockedHint: string;
}

export const DEFAULT_PREVIEW_VIEW_LABELS: PreviewViewLabels = {
  defaultTitle: 'Join Meeting',
  subtitle: 'Check your audio and video before joining',
  cancel: 'Cancel',
  join: 'Join Meeting',
  turnOnMicrophone: 'Turn on microphone',
  turnOffMicrophone: 'Turn off microphone',
  turnOnCamera: 'Turn on camera',
  turnOffCamera: 'Turn off camera',
  microphone: 'Microphone',
  camera: 'Camera',
  microphoneFallback: 'Microphone',
  cameraFallback: 'Camera',
  noMicrophones: 'No microphones detected',
  noCameras: 'No cameras detected',
  permissionRequired: 'Permission required.',
  blockedTitle: 'Camera and microphone are blocked',
  blockedDescription:
    "You can still join, but others won't see or hear you until you allow access for this site.",
  blockedHint: 'Use the blocked buttons below to see how to allow access.',
};

export interface PreviewViewProps {
  meetingTitle?: string;
  previewStream: MediaStream | null;
  previewAudioEnabled: boolean;
  previewVideoEnabled: boolean;
  togglePreviewAudio: () => void;
  togglePreviewVideo: () => void;
  confirmJoinFromPreview: () => void;
  cancelPreview: () => void;

  // ── Device pickers (optional — omit to keep the plain toggle buttons) ──────
  audioInputs?: MediaDeviceInfo[];
  videoInputs?: MediaDeviceInfo[];
  selectedAudioInputId?: string;
  selectedVideoInputId?: string;
  onChangeAudioInput?: (deviceId: string) => void;
  onChangeVideoInput?: (deviceId: string) => void;

  // ── Permissions (optional) ─────────────────────────────────────────────────
  /** Browser permission state; `denied` swaps the toggle for a help popover. */
  audioPermission?: PreviewPermission;
  videoPermission?: PreviewPermission;
  /** Copy for the blocked-permission help. English when omitted. */
  permissionHelpLabels?: PermissionHelpLabels;

  /** Copy overrides for this screen. English when omitted. */
  labels?: Partial<PreviewViewLabels>;
}

const RED_TOGGLE =
  'bg-red-100 hover:bg-red-200 text-red-500 dark:bg-red-500/20 dark:hover:bg-red-500/30 dark:text-red-400';
const NORMAL_TOGGLE = '[&]:hover:brightness-95 dark:[&]:hover:brightness-110';

interface DeviceControlConfig {
  permissionKind: PermissionKind;
  OnIcon: LucideIcon;
  OffIcon: LucideIcon;
}

const MIC_CONTROL: DeviceControlConfig = { permissionKind: 'microphone', OnIcon: Mic, OffIcon: MicOff };
const CAMERA_CONTROL: DeviceControlConfig = { permissionKind: 'camera', OnIcon: VideoIcon, OffIcon: VideoOff };

interface DeviceControlProps {
  config: DeviceControlConfig;
  enabled: boolean;
  permission: PreviewPermission;
  permissionHelpLabels: PermissionHelpLabels;
  toggleLabel: string;
  blockedLabel: string;
  menuLabel: string;
  fallbackPrefix: string;
  emptyLabel: string;
  permissionRequiredLabel: string;
  inputs?: MediaDeviceInfo[];
  selectedId?: string;
  onToggle: () => void;
  onChangeDevice?: (deviceId: string) => void;
}

/** Mic / camera button for a device the browser blocks: explains how to allow it. */
function BlockedDeviceControl({
  config,
  blockedLabel,
  permissionHelpLabels,
}: Readonly<Pick<DeviceControlProps, 'config' | 'blockedLabel' | 'permissionHelpLabels'>>) {
  const { OffIcon } = config;
  return (
    <div className="relative">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="secondary"
            size="icon"
            aria-label={blockedLabel}
            title={blockedLabel}
            className="h-12 w-12 rounded-[18px] ring-1 ring-red-400/40 border-0 transition-all cursor-pointer"
          >
            <OffIcon className="!h-[20px] !w-[20px]" />
          </Button>
        </PopoverTrigger>
        <PopoverContent side="top" align="center" sideOffset={10} className="w-72 p-4">
          <PermissionHelp kind={config.permissionKind} labels={permissionHelpLabels} />
        </PopoverContent>
      </Popover>
      <CircleAlert
        className="pointer-events-none absolute top-[5px] right-[5px] h-[14px] w-[14px] text-amber-500 fill-background"
        strokeWidth={2.5}
      />
    </div>
  );
}

function DeviceMenuBody({
  inputs,
  selectedId,
  onChangeDevice,
  fallbackPrefix,
  emptyLabel,
  permissionRequiredLabel,
  permission,
}: Readonly<Pick<
  DeviceControlProps,
  | 'inputs'
  | 'selectedId'
  | 'onChangeDevice'
  | 'fallbackPrefix'
  | 'emptyLabel'
  | 'permissionRequiredLabel'
  | 'permission'
>>) {
  if (!inputs || inputs.length === 0) {
    const permissionNeeded = permission === 'prompt' || permission === 'unknown';
    return (
      <div className="px-2 py-1.5 text-xs text-muted-foreground">
        {permissionNeeded ? permissionRequiredLabel : emptyLabel}
      </div>
    );
  }
  return (
    <DropdownMenuRadioGroup value={selectedId ?? ''} onValueChange={(id) => onChangeDevice?.(id)}>
      {inputs.map((d) => (
        <DropdownMenuRadioItem key={d.deviceId} value={d.deviceId} className="truncate">
          <span className="truncate">{d.label || `${fallbackPrefix} ${d.deviceId.slice(0, 8)}`}</span>
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}

/** One split button (toggle + device picker) for either the mic or the camera. */
function DeviceControl(props: Readonly<DeviceControlProps>) {
  const { config, enabled, permission, toggleLabel, onToggle, onChangeDevice, menuLabel } = props;
  if (permission === 'denied') {
    return (
      <BlockedDeviceControl
        config={config}
        blockedLabel={props.blockedLabel}
        permissionHelpLabels={props.permissionHelpLabels}
      />
    );
  }

  const off = !enabled;
  const ToggleIcon = off ? config.OffIcon : config.OnIcon;
  const hasPicker = !!onChangeDevice;

  return (
    <div
      className={cn(
        'flex items-center rounded-[18px] overflow-hidden ring-1',
        off ? 'ring-red-400/40' : 'ring-border',
      )}
    >
      <Button
        variant="secondary"
        size="icon"
        aria-label={toggleLabel}
        title={toggleLabel}
        className={cn(
          'h-12 w-12 border-0 transition-all focus-visible:ring-0 focus-visible:border-transparent',
          hasPicker ? 'rounded-none rounded-l-[18px]' : 'rounded-[18px]',
          off ? RED_TOGGLE : NORMAL_TOGGLE,
        )}
        onClick={onToggle}
      >
        <ToggleIcon className="!h-[20px] !w-[20px]" />
      </Button>
      {hasPicker && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="secondary"
              size="icon"
              aria-label={menuLabel}
              title={menuLabel}
              className={cn(
                'group/arrow h-12 w-8 rounded-none rounded-r-[18px] border-0 border-l border-border/30 px-0 flex items-center justify-center transition-colors focus-visible:ring-0 focus-visible:border-transparent',
                off ? RED_TOGGLE : NORMAL_TOGGLE,
              )}
            >
              <ChevronUp className="h-4 w-4 -translate-x-px transition-transform duration-200 group-data-[state=open]/arrow:rotate-180" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" sideOffset={7} className="w-64">
            <DropdownMenuLabel>{menuLabel}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DeviceMenuBody {...props} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/** Shown in place of the video when the browser blocks both camera and microphone. */
function BlockedState({ labels }: Readonly<{ labels: PreviewViewLabels }>) {
  return (
    <div
      role="alert"
      className="flex h-full flex-col items-center justify-center gap-2 px-6 py-8 text-center"
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/10">
        <CircleAlert className="h-7 w-7 text-amber-500" />
      </div>
      <p className="text-sm font-medium">{labels.blockedTitle}</p>
      <p className="text-xs text-muted-foreground max-w-xs">{labels.blockedDescription}</p>
      <p className="text-xs text-muted-foreground max-w-xs">{labels.blockedHint}</p>
    </div>
  );
}

export function PreviewView({
  meetingTitle,
  previewStream,
  previewAudioEnabled,
  previewVideoEnabled,
  togglePreviewAudio,
  togglePreviewVideo,
  confirmJoinFromPreview,
  cancelPreview,
  audioInputs,
  videoInputs,
  selectedAudioInputId,
  selectedVideoInputId,
  onChangeAudioInput,
  onChangeVideoInput,
  audioPermission = 'unknown',
  videoPermission = 'unknown',
  permissionHelpLabels = DEFAULT_PERMISSION_HELP_LABELS,
  labels: labelOverrides,
}: Readonly<PreviewViewProps>) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const labels: PreviewViewLabels = { ...DEFAULT_PREVIEW_VIEW_LABELS, ...labelOverrides };

  useEffect(() => {
    if (videoRef.current && previewStream) {
      videoRef.current.srcObject = previewStream;
    }
  }, [previewStream, previewVideoEnabled]);

  const bothBlocked = audioPermission === 'denied' && videoPermission === 'denied';

  return (
    <div className="flex-1 flex items-center justify-center bg-background">
      <div className="max-w-lg w-full mx-4 space-y-6">
        <div className="text-center">
          <h2 className="text-xl font-semibold">{meetingTitle || labels.defaultTitle}</h2>
          <p className="text-sm text-muted-foreground mt-1">{labels.subtitle}</p>
        </div>

        <div className="relative aspect-video bg-muted rounded-xl overflow-hidden">
          {bothBlocked ? (
            <BlockedState labels={labels} />
          ) : previewVideoEnabled && previewStream ? (
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="w-full h-full object-cover mirror"
              style={{ transform: 'scaleX(-1)' }}
            />
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="h-20 w-20 rounded-full bg-primary/10 flex items-center justify-center">
                <VideoOff className="h-8 w-8 text-muted-foreground" />
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-center gap-3">
          <DeviceControl
            config={MIC_CONTROL}
            enabled={previewAudioEnabled}
            permission={audioPermission}
            permissionHelpLabels={permissionHelpLabels}
            toggleLabel={previewAudioEnabled ? labels.turnOffMicrophone : labels.turnOnMicrophone}
            blockedLabel={permissionHelpLabels.microphoneBlockedAction}
            menuLabel={labels.microphone}
            fallbackPrefix={labels.microphoneFallback}
            emptyLabel={labels.noMicrophones}
            permissionRequiredLabel={labels.permissionRequired}
            inputs={audioInputs}
            selectedId={selectedAudioInputId}
            onToggle={togglePreviewAudio}
            onChangeDevice={onChangeAudioInput}
          />
          <DeviceControl
            config={CAMERA_CONTROL}
            enabled={previewVideoEnabled}
            permission={videoPermission}
            permissionHelpLabels={permissionHelpLabels}
            toggleLabel={previewVideoEnabled ? labels.turnOffCamera : labels.turnOnCamera}
            blockedLabel={permissionHelpLabels.cameraBlockedAction}
            menuLabel={labels.camera}
            fallbackPrefix={labels.cameraFallback}
            emptyLabel={labels.noCameras}
            permissionRequiredLabel={labels.permissionRequired}
            inputs={videoInputs}
            selectedId={selectedVideoInputId}
            onToggle={togglePreviewVideo}
            onChangeDevice={onChangeVideoInput}
          />
        </div>

        <div className="flex justify-center gap-3">
          <Button variant="outline" onClick={cancelPreview}>
            {labels.cancel}
          </Button>
          <Button onClick={confirmJoinFromPreview}>
            {labels.join}
          </Button>
        </div>
      </div>
    </div>
  );
}
