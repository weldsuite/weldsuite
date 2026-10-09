import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Info, MessageSquare, Users, LayoutGrid } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@weldsuite/ui/lib/utils';
import { useIsMobile } from '../hooks/use-is-mobile';
import type { RecordingLabels, RecordingState } from '../types';
import type { RightPanelKind } from './meeting-right-panel';

export interface MeetingHeaderProps {
  meetingTitle: string;
  duration: number;
  isRecording?: boolean;
  recordingState?: RecordingState;
  /** Whole seconds since the recorder was asked to start (shown while STARTING). */
  recordingStartElapsedSeconds?: number;
  /** Copy for the recording-start cue. English when omitted. */
  recordingLabels?: RecordingLabels;
  waitlistedCount?: number;
  /** Number of people currently in the call — rendered inline on the People button. */
  participantsCount?: number;
  rightPanel: RightPanelKind;
  showChat: boolean;
  onToggleRightPanel: (panel: 'info' | 'people' | 'settings' | 'tools') => void;
  onToggleChat: () => void;
  onRenameMeeting?: (newTitle: string) => void;

  /** When set, header shows the buttons. Defaults to all true. */
  showInfoButton?: boolean;
  showPeopleButton?: boolean;
  showChatButton?: boolean;
  showToolsButton?: boolean;
  /**
   * Set when the host view offers "Meeting details" and "Meeting tools"
   * somewhere else on phones (the control bar's More sheet). The phone header
   * then keeps only People and Chat, leaving the title room to breathe.
   */
  mobileOverflowActions?: boolean;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function MeetingHeader({
  meetingTitle,
  duration,
  isRecording,
  recordingState,
  recordingStartElapsedSeconds,
  recordingLabels,
  waitlistedCount = 0,
  participantsCount,
  rightPanel,
  showChat,
  onToggleRightPanel,
  onToggleChat,
  onRenameMeeting,
  showInfoButton = true,
  showPeopleButton = true,
  showChatButton = true,
  showToolsButton = true,
  mobileOverflowActions = false,
}: Readonly<MeetingHeaderProps>) {
  const [editingTitle, setEditingTitle] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleButtonRef = useRef<HTMLButtonElement>(null);
  const cancelTitleEditRef = useRef(false);
  // Set when a keyboard key (Enter/Escape) ends the edit, so focus returns to
  // the title button instead of falling back to the document.
  const refocusTitleRef = useRef(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [localTitle, setLocalTitle] = useState(meetingTitle);

  useEffect(() => {
    setLocalTitle(meetingTitle);
  }, [meetingTitle]);

  useEffect(() => {
    if (editingTitle || !refocusTitleRef.current) return;
    refocusTitleRef.current = false;
    titleButtonRef.current?.focus();
  }, [editingTitle]);

  const displayTitle = localTitle;
  const titleEditable = !!onRenameMeeting;
  const isMobile = useIsMobile();

  const titleBaseClass = cn(
    "rounded-md px-2 py-0.5 -mx-2 border transition-colors text-[16px] font-semibold outline-none",
    isMobile && "py-0 text-[15px] leading-tight",
  );
  // Mobile: keep the title on one line so it can't push the action
  // buttons off-screen — desktop layout is unchanged.
  const titleTruncateClass = isMobile && "truncate min-w-0";

  const startEditingTitle = () => {
    if (!titleEditable) return;
    if (!editingTitle) {
      cancelTitleEditRef.current = false;
      setDraftTitle(displayTitle);
      setEditingTitle(true);
      setTimeout(() => {
        const el = titleInputRef.current;
        if (el) {
          el.focus();
          el.select();
        }
      }, 0);
    }
  };

  const commitTitleEdit = () => {
    if (cancelTitleEditRef.current) {
      cancelTitleEditRef.current = false;
      return;
    }
    if (!titleEditable || !editingTitle) return;
    const trimmed = draftTitle.trim();
    if (trimmed && trimmed !== displayTitle) {
      setLocalTitle(trimmed);
      onRenameMeeting?.(trimmed);
    }
    setEditingTitle(false);
  };

  const overflowed = isMobile && mobileOverflowActions;
  const durationLabel = formatDuration(duration);

  const recordingCue = (
    <>
      {!isRecording && recordingState === 'STARTING' && (
        <span
          className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"
          title={recordingLabels?.startingHint ?? 'Recording is starting'}
        >
          <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />{recordingLabels?.starting ?? 'Starting…'}
          {typeof recordingStartElapsedSeconds === 'number' && (
            <span className="tabular-nums">{recordingStartElapsedSeconds}s</span>
          )}
        </span>
      )}
      {isRecording && (
        // A visible label, not just a dot: everyone in the call, guests
        // included, must be able to tell the meeting is being recorded.
        <output
          className="flex items-center gap-1.5 rounded-md bg-red-500/10 px-1.5 py-0.5 text-[11px] font-medium text-red-500 flex-shrink-0"
        >
          <span className={cn('h-2 w-2 rounded-full bg-red-500', recordingState !== 'PAUSED' && 'animate-pulse')} />
          {recordingState === 'PAUSED'
            ? (recordingLabels?.paused ?? 'Recording paused')
            : (recordingLabels?.active ?? 'Recording')}
        </output>
      )}
    </>
  );

  let title: ReactNode;
  if (editingTitle) {
    title = (
      <input
        ref={titleInputRef}
        type="text"
        value={draftTitle}
        maxLength={50}
        aria-label="Meeting title"
        size={Math.max(draftTitle.length, 8)}
        className={cn(titleBaseClass, "border-gray-400 bg-transparent dark:border-gray-500", isMobile && "min-w-0")}
        onChange={(e) => setDraftTitle(e.target.value)}
        onBlur={commitTitleEdit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            refocusTitleRef.current = true;
            e.currentTarget.blur();
          }
          if (e.key === 'Escape') {
            refocusTitleRef.current = true;
            cancelTitleEditRef.current = true;
            setEditingTitle(false);
          }
        }}
      />
    );
  } else if (titleEditable) {
    title = (
      <button
        ref={titleButtonRef}
        type="button"
        className={cn(titleBaseClass, "border-transparent text-left hover:border-border cursor-text", titleTruncateClass)}
        onClick={startEditingTitle}
        title="Click to rename"
      >
        {displayTitle}
      </button>
    );
  } else {
    title = (
      <span className={cn(titleBaseClass, "border-transparent cursor-default", titleTruncateClass)}>
        {displayTitle}
      </span>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2 px-3 md:px-4 border-b flex-shrink-0 h-[53px]">
      {isMobile ? (
        // Phone: the title gets the whole row; time and recording state sit
        // on a second, quieter line beneath it.
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
          <div className="flex min-w-0 items-center">{title}</div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground font-mono tabular-nums">{durationLabel}</span>
            {recordingCue}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {recordingCue}
          {title}
        </div>
      )}
      <div className={cn('flex items-center gap-1', isMobile && 'flex-shrink-0')}>
        {!isMobile && (
          <>
            <span className="text-sm text-muted-foreground font-mono mr-1">{durationLabel}</span>
            <div className="h-4 w-px bg-border mx-0.5" />
          </>
        )}
        {showInfoButton && !overflowed && (
          <Button
            variant={rightPanel === 'info' ? 'secondary' : 'ghost'}
            size="icon-sm"
            onClick={() => onToggleRightPanel('info')}
            title="Meeting details"
          >
            <Info className="h-4 w-4" />
          </Button>
        )}
        {showPeopleButton && (
          <Button
            variant={rightPanel === 'people' ? 'secondary' : 'ghost'}
            size={typeof participantsCount === 'number' ? 'sm' : 'icon-sm'}
            className="relative overflow-visible max-md:h-9 max-md:min-w-9"
            onClick={() => onToggleRightPanel('people')}
            title="People"
          >
            <Users className="h-4 w-4" />
            {typeof participantsCount === 'number' && (
              <span className="text-[13px] font-medium tabular-nums">
                {participantsCount}
              </span>
            )}
            {waitlistedCount > 0 && (
              <span className="absolute -top-1 -right-1 flex h-[16px] min-w-[16px] items-center justify-center rounded-[5px] bg-red-500 border border-red-600 text-[10px] font-mono font-medium leading-none text-white px-1 pointer-events-none">
                <span className="translate-y-[0.5px]">{waitlistedCount}</span>
              </span>
            )}
          </Button>
        )}
        {showChatButton && (
          <Button
            variant={showChat ? 'secondary' : 'ghost'}
            size={isMobile ? 'icon' : 'icon-sm'}
            onClick={onToggleChat}
            title="Chat"
          >
            <MessageSquare className="h-4 w-4" />
          </Button>
        )}
        {showToolsButton && !overflowed && (
          <Button
            variant={rightPanel === 'tools' ? 'secondary' : 'ghost'}
            size="icon-sm"
            onClick={() => onToggleRightPanel('tools')}
            title="Meeting tools"
          >
            <LayoutGrid className="h-4 w-4" />
          </Button>
        )}
        {/* Host controls (Settings) moved into the 3-dots More-options menu in
            CallControlsBar — kept off the header to declutter. */}
      </div>
    </div>
  );
}
