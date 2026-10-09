import type { ComponentType, ReactNode } from 'react';
import { Check, Circle, Image, Info, LayoutGrid, Maximize, Minimize, Pause, PictureInPicture2, Play, Settings, Square } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@weldsuite/ui/components/drawer';
import type { RecordingState, ViewMode } from '../types';
import { LAYOUT_OPTIONS, stopRecordingWithToast, toggleRecordingPause } from './call-controls-shared';

/** One pickable device list (camera, microphone or speaker). */
export interface MoreSheetDeviceGroup {
  label: string;
  fallbackPrefix: string;
  devices: MediaDeviceInfo[];
  activeId: string;
  onChange: (deviceId: string) => void;
}

export interface CallControlsMoreSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Closes the sheet, then runs the action on the next frame. */
  runAfterClose: (action: () => void) => void;

  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;

  onOpenInfo?: () => void;
  onOpenTools?: () => void;
  onToggleEffects?: () => void;
  effectsOpen?: boolean;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onPictureInPicture?: () => void;
  onOpenSettings?: () => void;

  /** Phones have no chevron menus next to the mic / camera buttons, so the
   *  device choice lives here. Groups with a single device are left out. */
  deviceGroups: MoreSheetDeviceGroup[];

  isRecording?: boolean;
  recordingState?: RecordingState;
  startRecording?: () => void;
  stopRecording?: () => void;
  pauseRecording?: () => void;
  resumeRecording?: () => void;
}

function SectionLabel({ children }: Readonly<{ children: ReactNode }>) {
  return <p className="px-1 pt-4 pb-2 text-xs font-medium text-muted-foreground">{children}</p>;
}

/** A large tap target: icon above its label. */
function SheetTile({
  icon: Icon,
  label,
  selected,
  onClick,
}: Readonly<{
  icon: ComponentType<{ className?: string }>;
  label: string;
  selected?: boolean;
  onClick: () => void;
}>) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'flex min-h-[72px] flex-col items-center justify-center gap-2 rounded-xl bg-secondary px-2 py-3 text-center text-xs font-medium leading-tight transition-colors active:bg-secondary/70',
        selected && 'ring-2 ring-primary',
      )}
    >
      <Icon className="h-5 w-5" />
      {label}
    </button>
  );
}

/** A full-width row, used for the device and recording lists. */
function SheetRow({
  children,
  onClick,
  disabled,
  className,
}: Readonly<{ children: ReactNode; onClick: () => void; disabled?: boolean; className?: string }>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors active:bg-secondary disabled:opacity-50',
        className,
      )}
    >
      {children}
    </button>
  );
}

/**
 * The "More options" menu as a bottom sheet, for phones. Holds what the
 * desktop menu holds, plus what a narrow header and control bar have no room
 * for: meeting details, meeting tools and the device pickers.
 */
export function CallControlsMoreSheet({
  open,
  onOpenChange,
  runAfterClose,
  viewMode,
  setViewMode,
  onOpenInfo,
  onOpenTools,
  onToggleEffects,
  effectsOpen,
  isFullscreen,
  onToggleFullscreen,
  onPictureInPicture,
  onOpenSettings,
  deviceGroups,
  isRecording,
  recordingState,
  startRecording,
  stopRecording,
  pauseRecording,
  resumeRecording,
}: Readonly<CallControlsMoreSheetProps>) {
  const paused = recordingState === 'PAUSED';
  const pickableGroups = deviceGroups.filter((group) => group.devices.length > 1);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent aria-describedby={undefined}>
        <DrawerHeader className="pb-0">
          <DrawerTitle>More options</DrawerTitle>
        </DrawerHeader>
        <div className="overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="grid grid-cols-3 gap-2 pt-4">
            {onOpenInfo && (
              <SheetTile icon={Info} label="Meeting details" onClick={() => runAfterClose(onOpenInfo)} />
            )}
            {onOpenTools && (
              <SheetTile icon={LayoutGrid} label="Meeting tools" onClick={() => runAfterClose(onOpenTools)} />
            )}
            {onToggleEffects && (
              <SheetTile
                icon={Image}
                label="Background effects"
                selected={effectsOpen}
                onClick={() => runAfterClose(onToggleEffects)}
              />
            )}
            {onToggleFullscreen && (
              <SheetTile
                icon={isFullscreen ? Minimize : Maximize}
                label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                onClick={() => runAfterClose(onToggleFullscreen)}
              />
            )}
            {onPictureInPicture && (
              <SheetTile icon={PictureInPicture2} label="Picture in picture" onClick={() => runAfterClose(onPictureInPicture)} />
            )}
            {onOpenSettings && (
              <SheetTile icon={Settings} label="Host controls" onClick={() => runAfterClose(onOpenSettings)} />
            )}
          </div>

          <SectionLabel>Layout</SectionLabel>
          <div className="grid grid-cols-4 gap-2">
            {LAYOUT_OPTIONS.map(({ value, label, icon }) => (
              <SheetTile
                key={value}
                icon={icon}
                label={label}
                selected={viewMode === value}
                onClick={() => runAfterClose(() => setViewMode(value))}
              />
            ))}
          </div>

          {pickableGroups.map((group) => (
            <div key={group.label}>
              <SectionLabel>{group.label}</SectionLabel>
              {group.devices.map((device) => (
                <SheetRow key={device.deviceId} onClick={() => group.onChange(device.deviceId)}>
                  <span className="min-w-0 flex-1 truncate">
                    {device.label || `${group.fallbackPrefix} ${device.deviceId.slice(0, 8)}`}
                  </span>
                  {device.deviceId === group.activeId && <Check className="h-4 w-4 flex-shrink-0 text-primary" />}
                </SheetRow>
              ))}
            </div>
          ))}

          {startRecording && (
            <>
              <SectionLabel>Recording</SectionLabel>
              {isRecording ? (
                <>
                  <SheetRow onClick={() => toggleRecordingPause(paused, pauseRecording, resumeRecording)}>
                    {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                    {paused ? 'Resume recording' : 'Pause recording'}
                  </SheetRow>
                  <SheetRow onClick={() => stopRecordingWithToast(stopRecording)} className="text-red-500">
                    <Square className="h-4 w-4 fill-current" />
                    Stop recording
                  </SheetRow>
                </>
              ) : (
                <SheetRow
                  onClick={() => runAfterClose(startRecording)}
                  disabled={recordingState === 'STARTING' || recordingState === 'STOPPING'}
                >
                  <Circle className="h-4 w-4 fill-red-500 text-red-500" />
                  Start recording
                </SheetRow>
              )}
            </>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
