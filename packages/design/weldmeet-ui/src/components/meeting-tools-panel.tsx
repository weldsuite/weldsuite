import { useState, type ComponentType } from 'react';
import {
  ChevronLeft,
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
import type { RecordingLabels, RecordingState } from '../types';
import {
  DEFAULT_MEETING_TOOLS_LABELS,
  formatCountdown,
  formatLabel,
  type MeetingToolsLabels,
} from '../tools/labels';
import { sortedQuestions, timerRemainingMs } from '../tools/tools-store';
import { languageName } from '../tools/translation';
import { useNow } from '../tools/use-meeting-tools';
import type { MeetingToolKey, MeetingToolsController } from '../tools/use-meeting-tools-controller';
import { BreakoutTool } from './tools/breakout-tool';
import { LivestreamTool } from './tools/livestream-tool';
import { PollsTool } from './tools/polls-tool';
import { QaTool } from './tools/qa-tool';
import { TimerTool } from './tools/timer-tool';
import { TranscriptTool } from './tools/transcript-tool';
import { TranslationTool } from './tools/translation-tool';

export interface MeetingToolsPanelProps {
  /** Forwarded from MeetingRoomView so the Record tool can drive RTK. */
  isRecording?: boolean;
  recordingState?: RecordingState;
  /** Whole seconds since the recorder was asked to start (shown while STARTING). */
  recordingStartElapsedSeconds?: number;
  /** Copy for the recording-start feedback. English when omitted. */
  recordingLabels?: RecordingLabels;
  startRecording?: () => void;
  stopRecording?: () => void;
  /** When true, the Record tool is rendered in the active list; otherwise
   *  it is shown as host-only. */
  recordingAvailable?: boolean;
  /**
   * The live tools (timer, polls, Q&A, …) of the meeting. Without it (no
   * meeting client yet) those rows are listed but cannot be opened.
   */
  tools?: MeetingToolsController | null;
  /** Copy for the tools. Defaults to the controller's labels, then English. */
  labels?: MeetingToolsLabels;
  /**
   * The "back + tool name" row above an open tool. Turn it off when the
   * surrounding panel shows that in its own header (MeetingRightPanel does).
   */
  showToolHeader?: boolean;
}

interface ToolItem {
  key: string;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  /** When provided the item is rendered as clickable. */
  onClick?: () => void;
  /** When provided, replaces the trailing chevron with a custom right slot. */
  trailing?: React.ReactNode;
  /** In-flight (e.g. recording starting/stopping): non-interactive, no chevron. */
  busy?: boolean;
  /** Something is going on in this tool right now (running timer, open rooms, …). */
  live?: boolean;
  /** Shown instead of the chevron on a row the viewer cannot use. */
  badge?: string;
}

function recordToolLabel(
  isRecording: boolean,
  recordingState?: RecordingState,
  labels?: RecordingLabels,
): string {
  if (recordingState === 'STARTING') return labels?.startingTool ?? 'Starting recording…';
  if (recordingState === 'STOPPING') return 'Stopping recording…';
  return isRecording ? 'Stop recording' : 'Record';
}

function recordToolDescription(
  isRecording: boolean,
  recordingBusy: boolean,
  startElapsedSeconds?: number,
  labels?: RecordingLabels,
): string {
  if (recordingBusy) {
    const wait = labels?.pleaseWait ?? 'Please wait…';
    // The elapsed counter only applies to the start; stopping has no timer.
    return typeof startElapsedSeconds === 'number' ? `${wait} ${startElapsedSeconds}s` : wait;
  }
  return isRecording ? 'Recording in progress' : 'Capture the meeting';
}

function recordToolTrailing(isRecording: boolean, recordingBusy: boolean): React.ReactNode {
  if (recordingBusy) {
    return <Loader2 className="h-4 w-4 text-muted-foreground animate-spin" aria-hidden />;
  }
  if (isRecording) {
    return <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" aria-hidden />;
  }
  return undefined;
}

/**
 * Builds the Record tool row. Recording start/stop is provisioned server-side
 * and takes a few seconds, so surface a spinner + "Starting…/Stopping…" so the
 * click clearly registers instead of looking like nothing happened.
 */
function buildRecordTool({
  isRecording = false,
  recordingState,
  startRecording,
  stopRecording,
  recordingStartElapsedSeconds,
  recordingLabels,
}: Pick<
  MeetingToolsPanelProps,
  | 'isRecording'
  | 'recordingState'
  | 'startRecording'
  | 'stopRecording'
  | 'recordingStartElapsedSeconds'
  | 'recordingLabels'
>): ToolItem {
  const recordingBusy = recordingState === 'STARTING' || recordingState === 'STOPPING';
  const startElapsed = recordingState === 'STARTING' ? recordingStartElapsedSeconds : undefined;

  const handleRecord = () => {
    if (recordingBusy) return;
    if (isRecording) stopRecording?.();
    else startRecording?.();
  };

  return {
    key: 'record',
    label: recordToolLabel(isRecording, recordingState, recordingLabels),
    description: recordToolDescription(isRecording, recordingBusy, startElapsed, recordingLabels),
    icon: isRecording ? Square : Circle,
    onClick: handleRecord,
    busy: recordingBusy,
    trailing: recordToolTrailing(isRecording, recordingBusy),
  };
}

const TOOL_ICONS: Record<MeetingToolKey, ComponentType<{ className?: string }>> = {
  translation: Languages,
  timer: TimerIcon,
  transcribe: FileText,
  livestream: Radio,
  breakout: LayoutGrid,
  polls: BarChart3,
  qa: HelpCircle,
};

export function toolTitle(key: MeetingToolKey, labels: MeetingToolsLabels): string {
  return labels.rows[key];
}

/** What a tool's row says underneath its name: its pitch, or what it is doing right now. */
function toolStatus(
  key: MeetingToolKey,
  tools: MeetingToolsController | null | undefined,
  labels: MeetingToolsLabels,
  now: number,
): { description: string; live: boolean } {
  const rows = labels.rows;
  const idle = { description: rows[`${key}Description` as const], live: false };
  if (!tools) return idle;
  const { state } = tools;
  switch (key) {
    case 'translation':
      return state.prefs.translationEnabled
        ? {
            description: formatLabel(rows.translationActive, { language: languageName(state.prefs.translateTo) }),
            live: true,
          }
        : idle;
    case 'timer': {
      if (state.timer.status === 'idle') return idle;
      const time = formatCountdown(timerRemainingMs(state.timer, now));
      const template = state.timer.status === 'paused' ? rows.timerPaused : rows.timerRunning;
      return { description: formatLabel(template, { time }), live: true };
    }
    case 'livestream':
      if (tools.livestream.isLive) return { description: rows.livestreamLive, live: true };
      return tools.livestream.canLivestream ? idle : { description: rows.livestreamUnavailable, live: false };
    case 'breakout':
      return state.breakout.active
        ? { description: formatLabel(rows.breakoutActive, { count: state.breakout.rooms.length }), live: true }
        : idle;
    case 'polls':
      return tools.polls.polls.length > 0
        ? { description: formatLabel(rows.pollsCount, { count: tools.polls.polls.length }), live: false }
        : idle;
    case 'qa': {
      const open = sortedQuestions(state.questions).filter((q) => !q.answered).length;
      return open > 0 ? { description: formatLabel(rows.qaOpen, { count: open }), live: false } : idle;
    }
    default:
      return idle;
  }
}

/** Live streaming is a host tool; everyone else only sees it while a stream is running. */
function isToolListed(key: MeetingToolKey, tools: MeetingToolsController | null | undefined): boolean {
  if (key !== 'livestream' || !tools) return true;
  return tools.isOrganizer || tools.livestream.isLive;
}

const TOOL_ORDER_BEFORE_RECORD: MeetingToolKey[] = ['translation', 'timer'];
const TOOL_ORDER_AFTER_RECORD: MeetingToolKey[] = ['transcribe', 'livestream', 'breakout', 'polls', 'qa'];

export function MeetingToolsPanel({
  isRecording,
  recordingState,
  startRecording,
  stopRecording,
  recordingAvailable,
  recordingStartElapsedSeconds,
  recordingLabels,
  tools,
  labels: labelsProp,
  showToolHeader = true,
}: Readonly<MeetingToolsPanelProps>) {
  const labels = labelsProp ?? tools?.labels ?? DEFAULT_MEETING_TOOLS_LABELS;
  // Standalone (no controller) the panel keeps track of the open tool itself.
  const [localTool, setLocalTool] = useState<MeetingToolKey | null>(null);
  const activeTool = tools ? tools.activeTool : localTool;
  const setActiveTool = tools ? tools.setActiveTool : setLocalTool;
  // The list shows the countdown on the Timer row; tick while one is running.
  const now = useNow(!activeTool && tools?.state.timer.status === 'running', 1000);

  if (tools && activeTool) {
    return (
      <div className="flex flex-col h-full">
        {showToolHeader && (
          <div className="flex items-center gap-1.5 border-b px-2 h-11 flex-shrink-0">
            <button
              type="button"
              onClick={() => setActiveTool(null)}
              aria-label={labels.back}
              title={labels.back}
              className="p-1.5 rounded-md hover:bg-muted transition-colors"
            >
              <ChevronLeft className="h-4 w-4 text-muted-foreground" />
            </button>
            <span className="text-sm font-medium">{toolTitle(activeTool, labels)}</span>
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
          <ToolView tool={activeTool} tools={tools} labels={labels} />
        </div>
      </div>
    );
  }

  const hasRecording = recordingAvailable && (startRecording || stopRecording);
  const recordTool = hasRecording
    ? buildRecordTool({
        isRecording,
        recordingState,
        startRecording,
        stopRecording,
        recordingStartElapsedSeconds,
        recordingLabels,
      })
    : null;

  const toToolItem = (key: MeetingToolKey): ToolItem => {
    const status = toolStatus(key, tools, labels, now);
    return {
      key,
      label: toolTitle(key, labels),
      description: status.description,
      icon: TOOL_ICONS[key],
      live: status.live,
      onClick: tools ? () => setActiveTool(key) : undefined,
    };
  };
  const listed = (keys: MeetingToolKey[]) => keys.filter((key) => isToolListed(key, tools)).map(toToolItem);

  const items: ToolItem[] = [
    ...listed(TOOL_ORDER_BEFORE_RECORD),
    // Recording is the host's call: everyone else sees the row, but cannot use it.
    ...(recordTool
      ? []
      : [{ key: 'record', label: 'Record', description: 'Capture the meeting', icon: Circle, badge: labels.hostOnly }]),
    ...listed(TOOL_ORDER_AFTER_RECORD),
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
        <div className="p-4 space-y-5">
          {recordTool && (
            <div className="space-y-2">
              <ToolRow item={recordTool} />
            </div>
          )}

          <div className="space-y-1.5">
            {items.map(t => <ToolRow key={t.key} item={t} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolView({
  tool,
  tools,
  labels,
}: Readonly<{
  tool: MeetingToolKey;
  tools: MeetingToolsController;
  labels: MeetingToolsLabels;
}>) {
  const { store, state, isOrganizer } = tools;
  switch (tool) {
    case 'timer':
      return (
        <TimerTool
          store={store}
          timer={state.timer}
          canControl={isOrganizer}
          soundOn={state.prefs.timerSound}
          labels={labels}
        />
      );
    case 'transcribe':
      return (
        <TranscriptTool
          lines={tools.transcript}
          translate={tools.translation.translate}
          captionsOn={state.prefs.captions}
          onCaptionsChange={(captions) => store.setPrefs({ captions })}
          meetingTitle={tools.meetingTitle}
          labels={labels}
        />
      );
    case 'translation':
      return (
        <TranslationTool
          prefs={state.prefs}
          onPrefsChange={(patch) => store.setPrefs(patch)}
          status={tools.translation.status}
          labels={labels}
        />
      );
    case 'livestream':
      return <LivestreamTool livestream={tools.livestream} labels={labels} />;
    case 'breakout':
      return (
        <BreakoutTool
          store={store}
          breakout={state.breakout}
          participants={tools.participants}
          canManage={isOrganizer}
          labels={labels}
        />
      );
    case 'polls':
      return <PollsTool polls={tools.polls} canCreate={isOrganizer} labels={labels} />;
    case 'qa':
      return <QaTool store={store} questions={state.questions} canModerate={isOrganizer} labels={labels} />;
    default:
      return null;
  }
}

function ToolRow({ item }: Readonly<{ item: ToolItem }>) {
  const Icon = item.icon;
  // `busy` rows (recording starting/stopping) stay visible but are not
  // clickable — `onClick` already no-ops while busy, this just stops the
  // hover/pointer affordance.
  const clickable = !item.badge && !item.busy && !!item.onClick;
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
        item.badge && 'opacity-60',
      )}
    >
      <span className="flex-shrink-0 h-9 w-9 rounded-lg bg-background/60 flex items-center justify-center">
        <Icon className="h-4 w-4" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium truncate">{item.label}</span>
        <span className={cn('block text-xs truncate', item.live ? 'text-primary' : 'text-muted-foreground')}>
          {item.description}
        </span>
      </span>
      {item.badge ? (
        <span className="flex-shrink-0 inline-flex items-center rounded-[5px] px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground border border-border whitespace-nowrap">
          {item.badge}
        </span>
      ) : (
        item.trailing ?? (clickable && <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />)
      )}
    </button>
  );
}
