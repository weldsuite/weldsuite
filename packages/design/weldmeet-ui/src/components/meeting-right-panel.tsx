import { type ReactNode, useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Separator } from '@weldsuite/ui/components/separator';
import { cn } from '@weldsuite/ui/lib/utils';
import { PeoplePanel } from './people-panel';
import { MeetingToolsPanel } from './meeting-tools-panel';
import { useIsMobile } from '../hooks/use-is-mobile';
import type { RecordingState } from '../types';

function formatMeetingDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const weekday = date.toLocaleDateString(undefined, { weekday: 'long' });
  const monthDay = date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  const time = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${weekday}, ${monthDay} @ ${time}`;
}

function formatMeetingId(code: string): string {
  // If the code is purely digits, group it 3-by-3 (Teams style: "327 141 953 603 466").
  // Otherwise show as-is (e.g. our short alphanumeric join codes).
  if (/^\d+$/.test(code)) {
    return code.replace(/(\d{3})(?=\d)/g, '$1 ');
  }
  return code;
}

export type RightPanelKind = 'info' | 'people' | 'settings' | 'tools' | null;

export interface MeetingRightPanelProps {
  panel: RightPanelKind;
  onClose: () => void;
  meetingTitle: string;
  joinCode?: string;
  shareUrl?: string;
  description?: string;
  scheduledStart?: string | null;
  participants: any[];
  meeting: any;
  skipTransition?: boolean;

  /** Optional slot — replaces built-in PeoplePanel. */
  peoplePanelSlot?: ReactNode;
  /** Optional slot — replaces built-in HostControlsPanel. */
  hostControlsSlot?: ReactNode;
  /** Forwarded to the built-in PeoplePanel — opens host app's details sheet. */
  onClickParticipantDetails?: (participant: any) => void;

  /** Forwarded to MeetingToolsPanel. */
  isRecording?: boolean;
  recordingState?: RecordingState;
  startRecording?: () => void;
  stopRecording?: () => void;
  recordingAvailable?: boolean;
}

export function MeetingRightPanel({
  panel,
  onClose,
  meetingTitle,
  joinCode,
  shareUrl,
  description,
  scheduledStart,
  participants,
  meeting,
  skipTransition,
  peoplePanelSlot,
  hostControlsSlot,
  onClickParticipantDetails,
  isRecording,
  recordingState,
  startRecording,
  stopRecording,
  recordingAvailable,
}: MeetingRightPanelProps) {
  const isOpen = panel !== null;
  const isMobile = useIsMobile();

  const title = panel === 'info' ? 'Meeting details'
    : panel === 'people' ? 'People'
    : panel === 'settings' ? 'Host controls'
    : panel === 'tools' ? 'Meeting tools'
    : '';

  if (!isOpen) return null;

  return (
    <div
      className={cn(
        'flex flex-col min-h-0 overflow-hidden',
        // Mobile: full-screen sheet over the call. Desktop: 480px right dock.
        isMobile
          ? 'fixed inset-0 z-50 bg-background'
          : 'flex-shrink-0 border-l border-gray-200 dark:border-border',
      )}
      style={isMobile ? undefined : { width: 480 }}
    >
      <div
        className={cn(
          'flex flex-col min-h-0 h-full',
          isMobile ? 'w-full' : 'w-[479px] flex-shrink-0',
        )}
      >
        <div className="px-4 border-b flex-shrink-0 h-[53px] flex items-center justify-between">
          <span className="text-sm font-semibold">{title}</span>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-muted transition-colors">
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {panel === 'info' && (
            <MeetingInfoPanel
              meetingTitle={meetingTitle}
              joinCode={joinCode}
              shareUrl={shareUrl}
              description={description}
              scheduledStart={scheduledStart}
              participantsCount={participants.length}
            />
          )}

          {panel === 'people' && (
            peoplePanelSlot ?? <PeoplePanel meeting={meeting} participants={participants} onClickDetails={onClickParticipantDetails} />
          )}

          {panel === 'settings' && (
            hostControlsSlot ?? (
              <div className="p-5 text-sm text-muted-foreground">
                Host controls are not available in this view.
              </div>
            )
          )}

          {panel === 'tools' && (
            <MeetingToolsPanel
              isRecording={isRecording}
              recordingState={recordingState}
              startRecording={startRecording}
              stopRecording={stopRecording}
              recordingAvailable={recordingAvailable}
            />
          )}
        </div>
      </div>
    </div>
  );
}

interface MeetingInfoPanelProps {
  meetingTitle: string;
  joinCode?: string;
  shareUrl?: string;
  description?: string;
  scheduledStart?: string | null;
  participantsCount: number;
}

function MeetingInfoPanel({
  meetingTitle,
  joinCode,
  shareUrl,
  description,
  scheduledStart,
  participantsCount,
}: MeetingInfoPanelProps) {
  const [copied, setCopied] = useState(false);

  const formattedDate = scheduledStart ? formatMeetingDate(scheduledStart) : null;
  const formattedId = joinCode ? formatMeetingId(joinCode) : null;

  const joinInfoText = [
    'WeldMeet meeting',
    shareUrl ? `Join: ${shareUrl}` : null,
    formattedId ? `Meeting ID: ${formattedId}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const handleCopy = async () => {
    if (!joinInfoText) return;
    try {
      await navigator.clipboard.writeText(joinInfoText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="p-5 space-y-5">
      <div className="space-y-1">
        <h3 className="text-base font-semibold leading-snug">{meetingTitle}</h3>
        {formattedDate && (
          <p className="text-sm text-muted-foreground">{formattedDate}</p>
        )}
      </div>

      {joinInfoText && (
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-center"
          onClick={handleCopy}
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              Copy join info
            </>
          )}
        </Button>
      )}

      {joinInfoText && <Separator />}

      {joinInfoText && (
        <div className="space-y-2 text-sm leading-relaxed">
          <p className="font-semibold">WeldMeet meeting</p>
          {shareUrl && (
            <p className="break-all">
              <span className="text-muted-foreground">Join: </span>
              <a
                href={shareUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {shareUrl}
              </a>
            </p>
          )}
          {formattedId && (
            <p>
              <span className="text-muted-foreground">Meeting ID: </span>
              <span className="font-mono">{formattedId}</span>
            </p>
          )}
        </div>
      )}

      {(description || participantsCount > 0) && <Separator />}

      {description && (
        <div className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Description
          </span>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      )}

      {participantsCount > 0 && (
        <div className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Participants
          </span>
          <p className="text-sm">{participantsCount} in this call</p>
        </div>
      )}
    </div>
  );
}
