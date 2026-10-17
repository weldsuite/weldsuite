import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Info, MessageSquare, Users, LayoutGrid } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@weldsuite/ui/lib/utils';
import { useIsMobile } from '../hooks/use-is-mobile';
import type { HeaderLabels, RecordingLabels, RecordingState } from '../types';
import type { RightPanelKind } from './meeting-right-panel';

export interface MeetingHeaderProps {
  meetingTitle: string;
  isRecording?: boolean;
  recordingState?: RecordingState;
  /** Whole seconds since the recorder was asked to start (shown while STARTING). */
  recordingStartElapsedSeconds?: number;
  /** Copy for the recording-start cue. English when omitted. */
  recordingLabels?: RecordingLabels;
  /** Copy for the panel buttons. English when omitted. */
  headerLabels?: HeaderLabels;
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
  /** Shown right after the title, e.g. the connection indicator. */
  statusSlot?: ReactNode;
}

type HeaderButtonVariant = 'secondary' | 'ghost' | 'outline';

/** Desktop: bordered text buttons. Phone: icon only, the row is too narrow for labels. */
function headerButtonVariant(active: boolean, isMobile: boolean): HeaderButtonVariant {
  if (active) return 'secondary';
  return isMobile ? 'ghost' : 'outline';
}

/** Recording state next to the title: "Starting…" while the recorder spins up, then a visible label. */
function RecordingCue({
  isRecording,
  recordingState,
  recordingStartElapsedSeconds,
  recordingLabels,
}: Readonly<Pick<MeetingHeaderProps, 'isRecording' | 'recordingState' | 'recordingStartElapsedSeconds' | 'recordingLabels'>>) {
  if (isRecording) {
    const paused = recordingState === 'PAUSED';
    return (
      // A visible label, not just a dot: everyone in the call, guests
      // included, must be able to tell the meeting is being recorded.
      <output
        className="flex items-center gap-1.5 rounded-md bg-red-500/10 px-1.5 py-0.5 text-[11px] font-medium text-red-500 flex-shrink-0"
      >
        <span className={cn('h-2 w-2 rounded-full bg-red-500', !paused && 'animate-pulse')} />
        {paused
          ? (recordingLabels?.paused ?? 'Recording paused')
          : (recordingLabels?.active ?? 'Recording')}
      </output>
    );
  }
  if (recordingState !== 'STARTING') return null;
  return (
    <span
      className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"
      title={recordingLabels?.startingHint ?? 'Recording is starting'}
    >
      <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />{recordingLabels?.starting ?? 'Starting…'}
      {typeof recordingStartElapsedSeconds === 'number' && (
        <span className="tabular-nums">{recordingStartElapsedSeconds}s</span>
      )}
    </span>
  );
}

/** The meeting title; click to rename it inline when `onRenameMeeting` is set. */
function MeetingTitle({
  meetingTitle,
  onRenameMeeting,
  isMobile,
}: Readonly<{
  meetingTitle: string;
  onRenameMeeting?: (newTitle: string) => void;
  isMobile: boolean;
}>) {
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

  if (editingTitle) {
    return (
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
  }
  if (titleEditable) {
    return (
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
  }
  return (
    <span className={cn(titleBaseClass, "border-transparent cursor-default", titleTruncateClass)}>
      {displayTitle}
    </span>
  );
}

/** A header button that toggles a panel: its label on desktop, its icon on phones. */
function HeaderPanelButton({
  active,
  isMobile,
  mobileSize = 'icon-sm',
  icon,
  label,
  title,
  onClick,
}: Readonly<{
  active: boolean;
  isMobile: boolean;
  mobileSize?: 'icon' | 'icon-sm';
  icon: ReactNode;
  label: string;
  title: string;
  onClick: () => void;
}>) {
  return (
    <Button
      variant={headerButtonVariant(active, isMobile)}
      size={isMobile ? mobileSize : 'sm'}
      className={cn(!isMobile && 'border')}
      onClick={onClick}
      title={title}
    >
      {isMobile ? icon : label}
    </Button>
  );
}

/** The People button, with the participant count and the waitlist badge. */
function PeopleButton({
  active,
  isMobile,
  label,
  participantsCount,
  waitlistedCount,
  onClick,
}: Readonly<{
  active: boolean;
  isMobile: boolean;
  label: string;
  participantsCount?: number;
  waitlistedCount: number;
  onClick: () => void;
}>) {
  const hasCount = typeof participantsCount === 'number';
  return (
    <Button
      variant={headerButtonVariant(active, isMobile)}
      size={hasCount || !isMobile ? 'sm' : 'icon-sm'}
      className={cn("relative overflow-visible max-md:h-9 max-md:min-w-9", !isMobile && 'border', !isMobile && hasCount && 'pr-[10px]')}
      onClick={onClick}
      title="People"
    >
      {isMobile ? <Users className="h-4 w-4" /> : label}
      {hasCount && (
        // The count square of the platform's list group headers (My tasks),
        // at 18px instead of 16px.
        <span className="relative text-[10px] font-mono text-foreground/85 bg-muted border border-border w-[18px] h-[18px] flex items-center justify-center rounded-[5px]">
          <span className="translate-y-[1px]">{participantsCount}</span>
        </span>
      )}
      {waitlistedCount > 0 && (
        <span className="absolute -top-1 -right-1 flex h-[16px] min-w-[16px] items-center justify-center rounded-[5px] bg-red-500 border border-red-600 text-[10px] font-mono font-medium leading-none text-white px-1 pointer-events-none">
          <span className="translate-y-[0.5px]">{waitlistedCount}</span>
        </span>
      )}
    </Button>
  );
}

export function MeetingHeader({
  meetingTitle,
  isRecording,
  recordingState,
  recordingStartElapsedSeconds,
  recordingLabels,
  headerLabels,
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
  statusSlot,
}: Readonly<MeetingHeaderProps>) {
  const isMobile = useIsMobile();
  const overflowed = isMobile && mobileOverflowActions;
  const hasRecordingCue = !!isRecording || recordingState === 'STARTING';

  const recordingCue = (
    <RecordingCue
      isRecording={isRecording}
      recordingState={recordingState}
      recordingStartElapsedSeconds={recordingStartElapsedSeconds}
      recordingLabels={recordingLabels}
    />
  );
  const title = <MeetingTitle meetingTitle={meetingTitle} onRenameMeeting={onRenameMeeting} isMobile={isMobile} />;

  return (
    <div className="flex items-center justify-between gap-2 px-3 md:px-4 border-b flex-shrink-0 h-[53px]">
      {isMobile ? (
        // Phone: the title gets the whole row; the recording state sits on a
        // second, quieter line beneath it while there is one. (The call timer
        // is in the Meeting details panel.)
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            {title}
            {statusSlot}
          </div>
          {hasRecordingCue && <div className="flex items-center gap-2">{recordingCue}</div>}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {recordingCue}
          {title}
          {statusSlot}
        </div>
      )}
      <div className={cn('flex items-center', isMobile ? 'gap-1 flex-shrink-0' : 'gap-1.5')}>
        {showInfoButton && !overflowed && (
          <HeaderPanelButton
            active={rightPanel === 'info'}
            isMobile={isMobile}
            icon={<Info className="h-4 w-4" />}
            label={headerLabels?.details ?? 'Details'}
            title="Meeting details"
            onClick={() => onToggleRightPanel('info')}
          />
        )}
        {showPeopleButton && (
          <PeopleButton
            active={rightPanel === 'people'}
            isMobile={isMobile}
            label={headerLabels?.people ?? 'People'}
            participantsCount={participantsCount}
            waitlistedCount={waitlistedCount}
            onClick={() => onToggleRightPanel('people')}
          />
        )}
        {showChatButton && (
          <HeaderPanelButton
            active={showChat}
            isMobile={isMobile}
            mobileSize="icon"
            icon={<MessageSquare className="h-4 w-4" />}
            label={headerLabels?.chat ?? 'Chat'}
            title="Chat"
            onClick={onToggleChat}
          />
        )}
        {showToolsButton && !overflowed && (
          <HeaderPanelButton
            active={rightPanel === 'tools'}
            isMobile={isMobile}
            icon={<LayoutGrid className="h-4 w-4" />}
            label={headerLabels?.tools ?? 'Tools'}
            title="Meeting tools"
            onClick={() => onToggleRightPanel('tools')}
          />
        )}
        {/* Host controls (Settings) moved into the 3-dots More-options menu in
            CallControlsBar — kept off the header to declutter. */}
      </div>
    </div>
  );
}
