'use client';

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
import { ChevronUp, CircleAlert, Mic, MicOff, Video, VideoOff, type LucideIcon } from 'lucide-react';

import { PermissionHelp } from './permission-help';

export type PermState = 'granted' | 'denied' | 'prompt' | 'unknown';

const RED_TOGGLE = 'bg-red-100 hover:bg-red-200 text-red-500 dark:bg-red-500/20 dark:hover:bg-red-500/30 dark:text-red-400';
const RED_ARROW = 'bg-red-100 hover:bg-red-200 text-red-500 dark:bg-red-500/20 dark:hover:bg-red-500/30 dark:text-red-400 border-red-400/20 data-[state=open]:bg-red-200 dark:data-[state=open]:bg-red-500/30';
const NORMAL_TOGGLE = '[&]:hover:brightness-95 dark:[&]:hover:brightness-110';
const NORMAL_ARROW = '[&]:hover:brightness-95 dark:[&]:hover:brightness-110 data-[state=open]:brightness-95 dark:data-[state=open]:brightness-110';

interface Props {
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
}

interface DeviceKindConfig {
  permissionKind: 'microphone' | 'camera';
  blockedLabel: string;
  menuLabel: string;
  emptyLabel: string;
  fallbackLabelPrefix: string;
  OnIcon: LucideIcon;
  OffIcon: LucideIcon;
}

const MIC_CONFIG: DeviceKindConfig = {
  permissionKind: 'microphone',
  blockedLabel: 'Microphone access blocked — click for help',
  menuLabel: 'Microphone',
  emptyLabel: 'No microphones detected',
  fallbackLabelPrefix: 'Microphone',
  OnIcon: Mic,
  OffIcon: MicOff,
};

const CAMERA_CONFIG: DeviceKindConfig = {
  permissionKind: 'camera',
  blockedLabel: 'Camera access blocked — click for help',
  menuLabel: 'Camera',
  emptyLabel: 'No cameras detected',
  fallbackLabelPrefix: 'Camera',
  OnIcon: Video,
  OffIcon: VideoOff,
};

interface DeviceControlProps {
  config: DeviceKindConfig;
  permission: PermState;
  enabled: boolean;
  inputs: MediaDeviceInfo[];
  selectedInput: string;
  onToggle: () => void;
  onChangeDevice: (deviceId: string) => void;
}

function BlockedDeviceControl({ config }: Readonly<{ config: DeviceKindConfig }>) {
  const { OnIcon } = config;
  return (
    <div className="relative">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="secondary"
            size="icon"
            aria-label={config.blockedLabel}
            className="h-12 w-12 rounded-[18px] ring-1 ring-border border-0 transition-all focus-visible:ring-1 focus-visible:ring-border [&]:hover:brightness-95 dark:[&]:hover:brightness-110 cursor-pointer"
          >
            <OnIcon className="!h-[20px] !w-[20px]" />
          </Button>
        </PopoverTrigger>
        <PopoverContent side="top" align="center" sideOffset={10} className="w-72 p-4">
          <PermissionHelp kind={config.permissionKind} />
        </PopoverContent>
      </Popover>
      <CircleAlert className="pointer-events-none absolute top-[5px] right-[5px] h-[14px] w-[14px] text-amber-500 fill-background dark:fill-background" strokeWidth={2.5} />
    </div>
  );
}

function DeviceMenuBody({
  config,
  permission,
  inputs,
  selectedInput,
  onChangeDevice,
}: Readonly<Omit<DeviceControlProps, 'enabled' | 'onToggle'>>) {
  if (inputs.length === 0) {
    const permissionNeeded = permission === 'prompt' || permission === 'unknown';
    return (
      <div className="px-2 py-1.5 text-xs text-muted-foreground">
        {permissionNeeded ? 'Permission required.' : config.emptyLabel}
      </div>
    );
  }
  return (
    <DropdownMenuRadioGroup value={selectedInput} onValueChange={onChangeDevice}>
      {inputs.map((d) => (
        <DropdownMenuRadioItem key={d.deviceId} value={d.deviceId} className="truncate">
          <span className="truncate">{d.label || `${config.fallbackLabelPrefix} ${d.deviceId.slice(0, 8)}`}</span>
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}

/** One split button (toggle + device picker) for either the mic or the camera. */
function DeviceControl(props: Readonly<DeviceControlProps>) {
  const { config, permission, enabled, onToggle } = props;
  if (permission === 'denied') return <BlockedDeviceControl config={config} />;

  const off = !enabled;
  const { OnIcon, OffIcon } = config;
  const ToggleIcon = off ? OffIcon : OnIcon;

  return (
    <div className={cn('flex items-center rounded-[18px] overflow-hidden ring-1', off ? 'ring-red-400/40' : 'ring-border')}>
      <Button
        variant="secondary"
        size="icon"
        className={cn(
          'h-12 w-12 rounded-none rounded-l-[18px] border-0 transition-all focus-visible:ring-0 focus-visible:border-transparent',
          off ? RED_TOGGLE : NORMAL_TOGGLE,
        )}
        onClick={onToggle}
      >
        <ToggleIcon className="!h-[20px] !w-[20px]" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="secondary"
            size="icon"
            className={cn(
              'group/arrow h-12 w-8 rounded-none rounded-r-[18px] border-0 border-l border-border/30 px-0 flex items-center justify-center transition-colors focus-visible:ring-0 focus-visible:border-transparent',
              off ? RED_ARROW : NORMAL_ARROW,
            )}
          >
            <ChevronUp className="h-4 w-4 -translate-x-px transition-transform duration-200 group-data-[state=open]/arrow:rotate-180" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" sideOffset={7} className="w-64">
          <DropdownMenuLabel>{config.menuLabel}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DeviceMenuBody {...props} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * Shared mic/camera split-button + device-picker pair, used by both the
 * landing and the waitlisted screen. Matches the platform CallControlsBar
 * pre-join controls so design stays in sync.
 */
export function PrejoinMediaControls({
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
}: Readonly<Props>) {
  return (
    <>
      <DeviceControl
        config={MIC_CONFIG}
        permission={audioPermission}
        enabled={previewAudioEnabled}
        inputs={audioInputs}
        selectedInput={selectedAudioInput}
        onToggle={togglePreviewAudio}
        onChangeDevice={changeAudioDevice}
      />
      <DeviceControl
        config={CAMERA_CONFIG}
        permission={videoPermission}
        enabled={previewVideoEnabled}
        inputs={videoInputs}
        selectedInput={selectedVideoInput}
        onToggle={togglePreviewVideo}
        onChangeDevice={changeVideoDevice}
      />
    </>
  );
}
