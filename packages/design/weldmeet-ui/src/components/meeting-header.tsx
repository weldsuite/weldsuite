import { useEffect, useRef, useState } from 'react';
import { Info, MessageSquare, Users, LayoutGrid } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@weldsuite/ui/lib/utils';
import { useIsMobile } from '../hooks/use-is-mobile';
import type { RecordingState } from '../types';
import type { RightPanelKind } from './meeting-right-panel';

export interface MeetingHeaderProps {
  meetingTitle: string;
  duration: number;
  isRecording?: boolean;
  recordingState?: RecordingState;
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
  showHostControlsButton?: boolean;
  showToolsButton?: boolean;
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
  showHostControlsButton = true,
  showToolsButton = true,
}: MeetingHeaderProps) {
  const [editingTitle, setEditingTitle] = useState(false);
  const titleInputRef = useRef<HTMLSpanElement>(null);
  const [localTitle, setLocalTitle] = useState(meetingTitle);

  useEffect(() => {
    setLocalTitle(meetingTitle);
  }, [meetingTitle]);

  const displayTitle = localTitle;
  const titleEditable = !!onRenameMeeting;
  const isMobile = useIsMobile();

  return (
    <div className="flex items-center justify-between px-4 border-b flex-shrink-0 h-[53px]">
      <div className={cn('flex items-center gap-2', isMobile && 'min-w-0 flex-1')}>
        {!isRecording && recordingState === 'STARTING' && (
          <span
            className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"
            title="Recording is starting"
          >
            <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
            Starting…
          </span>
        )}
        {isRecording && (
          <span
            className="h-2 w-2 rounded-full bg-red-500"
            title={recordingState === 'PAUSED' ? 'Recording paused' : 'Recording'}
          />
        )}
        <span
          ref={titleInputRef}
          contentEditable={editingTitle}
          suppressContentEditableWarning
          className={cn(
            "rounded-md px-2 py-0.5 -mx-2 border transition-colors text-[16px] font-semibold outline-none",
            editingTitle ? "border-gray-400 dark:border-gray-500" : titleEditable ? "border-transparent hover:border-border cursor-text" : "border-transparent cursor-default",
            // Mobile: keep the title on one line so it can't push the action
            // buttons off-screen — desktop layout is unchanged.
            !editingTitle && isMobile && "truncate min-w-0",
          )}
          onClick={() => {
            if (!titleEditable) return;
            if (!editingTitle) {
              setEditingTitle(true);
              setTimeout(() => {
                const el = titleInputRef.current;
                if (el) {
                  el.focus();
                  const range = document.createRange();
                  range.selectNodeContents(el);
                  const sel = window.getSelection();
                  sel?.removeAllRanges();
                  sel?.addRange(range);
                }
              }, 0);
            }
          }}
          onBlur={() => {
            if (!titleEditable) return;
            const el = titleInputRef.current;
            const trimmed = (el?.innerText ?? '').trim();
            if (trimmed && trimmed !== displayTitle) {
              setLocalTitle(trimmed);
              onRenameMeeting?.(trimmed);
            } else if (el) {
              el.innerText = displayTitle;
            }
            setEditingTitle(false);
          }}
          onInput={(e) => {
            const el = e.currentTarget;
            if (el.innerText.length > 50) {
              el.innerText = el.innerText.slice(0, 50);
              const range = document.createRange();
              range.selectNodeContents(el);
              range.collapse(false);
              const sel = window.getSelection();
              sel?.removeAllRanges();
              sel?.addRange(range);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLElement).blur(); }
            if (e.key === 'Escape') {
              const el = titleInputRef.current;
              if (el) el.innerText = displayTitle;
              setEditingTitle(false);
            }
          }}
          title={editingTitle || !titleEditable ? undefined : "Click to rename"}
        >
          {displayTitle}
        </span>
      </div>
      <div className={cn('flex items-center gap-1', isMobile && 'flex-shrink-0')}>
        <span className="text-sm text-muted-foreground font-mono mr-1">{formatDuration(duration)}</span>
        <div className="h-4 w-px bg-border mx-0.5" />
        {showInfoButton && (
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
            className="relative overflow-visible"
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
            size="icon-sm"
            onClick={onToggleChat}
            title="Chat"
          >
            <MessageSquare className="h-4 w-4" />
          </Button>
        )}
        {showToolsButton && (
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
