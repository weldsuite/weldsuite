import { type ComponentType } from 'react';
import {
  ChevronRight,
  Languages,
  Timer as TimerIcon,
  Circle,
  Square,
  FileText,
  Radio,
  LayoutGrid,
  BarChart3,
  HelpCircle,
  Loader2,
} from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';
import type { RecordingState } from '../types';

export interface MeetingToolsPanelProps {
  /** Forwarded from MeetingRoomView so the Record tool can drive RTK. */
  isRecording?: boolean;
  recordingState?: RecordingState;
  startRecording?: () => void;
  stopRecording?: () => void;
  /** When true, the Record tool is rendered in the active list; otherwise
   *  it stays in the "Unavailable or Premium" group. */
  recordingAvailable?: boolean;
}

interface ToolItem {
  key: string;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  /** When provided the item is rendered as clickable; otherwise it sits in
   *  the "Unavailable or Premium" group below. */
  onClick?: () => void;
  /** When provided, replaces the trailing chevron with a custom right slot. */
  trailing?: React.ReactNode;
  /** In-flight (e.g. recording starting/stopping): non-interactive, no chevron. */
  busy?: boolean;
}

export function MeetingToolsPanel({
  isRecording,
  recordingState,
  startRecording,
  stopRecording,
  recordingAvailable,
}: MeetingToolsPanelProps) {
  const recordingBusy = recordingState === 'STARTING' || recordingState === 'STOPPING';

  const handleRecord = () => {
    if (recordingBusy) return;
    if (isRecording) stopRecording?.();
    else startRecording?.();
  };

  const activeTools: ToolItem[] = [];

  if (recordingAvailable && (startRecording || stopRecording)) {
    // Recording start/stop is provisioned server-side and takes a few seconds.
    // Surface a spinner + "Starting…/Stopping…" so the click clearly registers
    // instead of looking like nothing happened.
    const label = recordingState === 'STARTING'
      ? 'Starting recording…'
      : recordingState === 'STOPPING'
        ? 'Stopping recording…'
        : isRecording ? 'Stop recording' : 'Record';
    const description = recordingBusy
      ? 'Please wait…'
      : isRecording ? 'Recording in progress' : 'Capture the meeting';
    activeTools.push({
      key: 'record',
      label,
      description,
      icon: isRecording ? Square : Circle,
      onClick: handleRecord,
      busy: recordingBusy,
      trailing: recordingBusy ? (
        <Loader2 className="h-4 w-4 text-muted-foreground animate-spin" aria-hidden />
      ) : isRecording ? (
        <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" aria-hidden />
      ) : undefined,
    });
  }

  const unavailableTools: ToolItem[] = [
    { key: 'translation', label: 'Speech translation', description: 'Limited access', icon: Languages },
    { key: 'timer', label: 'Timer', description: 'Show a countdown timer', icon: TimerIcon },
    ...(!recordingAvailable
      ? [{ key: 'record', label: 'Record', description: 'Capture the meeting', icon: Circle }]
      : []),
    { key: 'transcribe', label: 'Transcribe', description: 'Capture the conversation', icon: FileText },
    { key: 'livestream', label: 'Live streaming', description: 'Stream to view-only users', icon: Radio },
    { key: 'breakout', label: 'Breakout rooms', description: 'Break into smaller groups', icon: LayoutGrid },
    { key: 'polls', label: 'Polls', description: 'Send polls to the audience', icon: BarChart3 },
    { key: 'qa', label: 'Q&A', description: 'Ask and answer questions', icon: HelpCircle },
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
        <div className="p-4 space-y-5">
          {/* Active tools */}
          {activeTools.length > 0 && (
            <div className="space-y-2">
              {activeTools.map(t => <ToolRow key={t.key} item={t} />)}
            </div>
          )}

          {/* Unavailable / Premium tools */}
          <div className="space-y-1.5 opacity-60">
            {unavailableTools.map(t => <ToolRow key={t.key} item={t} disabled />)}
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolRow({ item, disabled }: { item: ToolItem; disabled?: boolean }) {
  const Icon = item.icon;
  // `busy` rows (recording starting/stopping) stay visible but are not
  // clickable — `onClick` already no-ops while busy, this just stops the
  // hover/pointer affordance.
  const clickable = !disabled && !item.busy && !!item.onClick;
  return (
    <button
      type="button"
      onClick={item.onClick}
      disabled={!clickable}
      aria-busy={item.busy || undefined}
      className={cn(
        'w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors',
        'bg-muted/40',
        clickable && 'hover:bg-muted cursor-pointer',
        !clickable && 'cursor-default',
        item.busy && 'cursor-wait',
      )}
    >
      <span className="flex-shrink-0 h-9 w-9 rounded-lg bg-background/60 flex items-center justify-center">
        <Icon className="h-4 w-4" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium truncate">{item.label}</span>
        <span className="block text-xs text-muted-foreground truncate">{item.description}</span>
      </span>
      {disabled ? (
        <span className="flex-shrink-0 inline-flex items-center rounded-[5px] px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground border border-border whitespace-nowrap">
          Coming soon
        </span>
      ) : (
        item.trailing ?? (clickable && <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />)
      )}
    </button>
  );
}
