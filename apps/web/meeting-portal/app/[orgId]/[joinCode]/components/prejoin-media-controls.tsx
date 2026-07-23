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
import { ChevronUp, CircleAlert, Mic, MicOff, Video, VideoOff } from 'lucide-react';

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
}: Props) {
  const audioBlocked = audioPermission === 'denied';
  const videoBlocked = videoPermission === 'denied';
  const audioOff = !previewAudioEnabled && !audioBlocked;
  const videoOff = !previewVideoEnabled && !videoBlocked;

  return (
    <>
      {/* Mic */}
      {audioBlocked ? (
        <div className="relative">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                aria-label="Microphone access blocked — click for help"
                className="h-12 w-12 rounded-[18px] ring-1 ring-border border-0 transition-all focus-visible:ring-1 focus-visible:ring-border [&]:hover:brightness-95 dark:[&]:hover:brightness-110 cursor-pointer"
              >
                <Mic className="!h-[20px] !w-[20px]" />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="center" sideOffset={10} className="w-72 p-4">
              <PermissionHelp kind="microphone" />
            </PopoverContent>
          </Popover>
          <CircleAlert className="pointer-events-none absolute top-[5px] right-[5px] h-[14px] w-[14px] text-amber-500 fill-background dark:fill-background" strokeWidth={2.5} />
        </div>
      ) : (
        <div className={cn('flex items-center rounded-[18px] overflow-hidden ring-1', audioOff ? 'ring-red-400/40' : 'ring-border')}>
          <Button
            variant="secondary"
            size="icon"
            className={cn(
              'h-12 w-12 rounded-none rounded-l-[18px] border-0 transition-all focus-visible:ring-0 focus-visible:border-transparent',
              audioOff ? RED_TOGGLE : NORMAL_TOGGLE,
            )}
            onClick={togglePreviewAudio}
          >
            {audioOff ? <MicOff className="!h-[20px] !w-[20px]" /> : <Mic className="!h-[20px] !w-[20px]" />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                className={cn(
                  'group/arrow h-12 w-8 rounded-none rounded-r-[18px] border-0 border-l border-border/30 px-0 flex items-center justify-center transition-colors focus-visible:ring-0 focus-visible:border-transparent',
                  audioOff ? RED_ARROW : NORMAL_ARROW,
                )}
              >
                <ChevronUp className="h-4 w-4 -translate-x-px transition-transform duration-200 group-data-[state=open]/arrow:rotate-180" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" sideOffset={7} className="w-64">
              <DropdownMenuLabel>Microphone</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {audioInputs.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  {audioPermission === 'prompt' || audioPermission === 'unknown'
                    ? 'Permission required.'
                    : 'No microphones detected'}
                </div>
              ) : (
                <DropdownMenuRadioGroup value={selectedAudioInput} onValueChange={changeAudioDevice}>
                  {audioInputs.map((d) => (
                    <DropdownMenuRadioItem key={d.deviceId} value={d.deviceId} className="truncate">
                      <span className="truncate">{d.label || `Microphone ${d.deviceId.slice(0, 8)}`}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {/* Camera */}
      {videoBlocked ? (
        <div className="relative">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                aria-label="Camera access blocked — click for help"
                className="h-12 w-12 rounded-[18px] ring-1 ring-border border-0 transition-all focus-visible:ring-1 focus-visible:ring-border [&]:hover:brightness-95 dark:[&]:hover:brightness-110 cursor-pointer"
              >
                <Video className="!h-[20px] !w-[20px]" />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="center" sideOffset={10} className="w-72 p-4">
              <PermissionHelp kind="camera" />
            </PopoverContent>
          </Popover>
          <CircleAlert className="pointer-events-none absolute top-[5px] right-[5px] h-[14px] w-[14px] text-amber-500 fill-background dark:fill-background" strokeWidth={2.5} />
        </div>
      ) : (
        <div className={cn('flex items-center rounded-[18px] overflow-hidden ring-1', videoOff ? 'ring-red-400/40' : 'ring-border')}>
          <Button
            variant="secondary"
            size="icon"
            className={cn(
              'h-12 w-12 rounded-none rounded-l-[18px] border-0 transition-all focus-visible:ring-0 focus-visible:border-transparent',
              videoOff ? RED_TOGGLE : NORMAL_TOGGLE,
            )}
            onClick={togglePreviewVideo}
          >
            {videoOff ? <VideoOff className="!h-[20px] !w-[20px]" /> : <Video className="!h-[20px] !w-[20px]" />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                className={cn(
                  'group/arrow h-12 w-8 rounded-none rounded-r-[18px] border-0 border-l border-border/30 px-0 flex items-center justify-center transition-colors focus-visible:ring-0 focus-visible:border-transparent',
                  videoOff ? RED_ARROW : NORMAL_ARROW,
                )}
              >
                <ChevronUp className="h-4 w-4 -translate-x-px transition-transform duration-200 group-data-[state=open]/arrow:rotate-180" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" sideOffset={7} className="w-64">
              <DropdownMenuLabel>Camera</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {videoInputs.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  {videoPermission === 'prompt' || videoPermission === 'unknown'
                    ? 'Permission required.'
                    : 'No cameras detected'}
                </div>
              ) : (
                <DropdownMenuRadioGroup value={selectedVideoInput} onValueChange={changeVideoDevice}>
                  {videoInputs.map((d) => (
                    <DropdownMenuRadioItem key={d.deviceId} value={d.deviceId} className="truncate">
                      <span className="truncate">{d.label || `Camera ${d.deviceId.slice(0, 8)}`}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </>
  );
}
