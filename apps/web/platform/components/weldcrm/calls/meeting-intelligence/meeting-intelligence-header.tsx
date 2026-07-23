
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  ChevronLeft,
  Loader2,
  MoreVertical,
  Phone,
  Trash2,
  Download,
  Video,
  Copy,
  Link,
  Pencil,
  CalendarPlus,
  FileText,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { detectPlatform, formatDuration } from './utils';
import type { MeetingIntelligenceCall, HeaderAction } from './types';
import { useTranslations } from '@weldsuite/i18n/client';

interface MeetingIntelligenceHeaderProps {
  call: MeetingIntelligenceCall;
  mediaType?: 'video' | 'audio' | 'none';
  videoDuration?: number;
  isTranscribing: boolean;
  hasTranscription: boolean;
  isLoadingTranscription: boolean;
  onBack: () => void;
  onTranscribe?: () => void;
  onDelete?: () => void;
  onMinimize?: () => void;
  onRename?: () => void;
  onCopyJoinCode?: () => void;
  onCopyLink?: () => void;
  onScheduleAgain?: () => void;
  onDownloadRecording?: () => void;
  onDeleteRecording?: () => void;
  onExportTranscript?: () => void;
  headerActions?: HeaderAction[];
}

export function MeetingIntelligenceHeader({
  call,
  mediaType = 'video',
  videoDuration,
  isTranscribing,
  hasTranscription,
  isLoadingTranscription,
  onBack,
  onTranscribe,
  onDelete,
  onMinimize,
  onRename,
  onCopyJoinCode,
  onCopyLink,
  onScheduleAgain,
  onDownloadRecording,
  onDeleteRecording,
  onExportTranscript,
  headerActions,
}: MeetingIntelligenceHeaderProps) {
  const t = useTranslations();
  const callDate = new Date(call.date);
  const callDuration = call.duration || 0;
  const platformInfo = detectPlatform(call.platform, call.meetingUrl);

  return (
    <div className="h-[53px] flex-shrink-0 border-b border-gray-200 dark:border-border bg-white dark:bg-background flex items-center justify-between pl-6 pr-4">
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="icon"
          onClick={onBack}
          className="-ml-2 h-8 w-8"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="h-8 w-11 rounded-lg bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border flex items-center justify-center flex-shrink-0">
          {platformInfo ? (
            <img src={platformInfo.icon} alt={platformInfo.name} className="h-5 w-5" />
          ) : mediaType === 'audio' ? (
            <Phone className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
          ) : (
            <Video className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
          )}
        </div>
        <span className="text-base font-semibold text-gray-900 dark:text-foreground truncate min-w-0">{call.subject || t('sweep.weldcrm.meetingIntelligenceHeader.untitledCall')}</span>
      </div>
      <div className="flex items-center gap-1">
        {!hasTranscription && !isLoadingTranscription && onTranscribe && (
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={onTranscribe}
            disabled={isTranscribing}
          >
            {isTranscribing ? (
              <>
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                {t('sweep.weldcrm.meetingIntelligenceHeader.transcribing')}
              </>
            ) : (
              t('sweep.weldcrm.meetingIntelligenceHeader.transcribe')
            )}
          </Button>
        )}
        {headerActions?.map((action, i) => (
          <Button
            key={i}
            variant={(action.variant as any) || 'ghost'}
            size="icon-sm"
            onClick={action.onClick}
            disabled={action.disabled}
            title={action.label}
          >
            {action.icon}
          </Button>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="data-[state=open]:bg-accent">
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {onCopyJoinCode && (
              <DropdownMenuItem onClick={onCopyJoinCode}>
                <Copy className="h-3.5 w-3.5 mr-0.5" />
                {t('sweep.weldcrm.meetingIntelligenceHeader.copyJoinCode')}
              </DropdownMenuItem>
            )}
            {onCopyLink && (
              <DropdownMenuItem onClick={onCopyLink}>
                <Link className="h-3.5 w-3.5 mr-0.5" />
                {t('sweep.weldcrm.meetingIntelligenceHeader.copyMeetingLink')}
              </DropdownMenuItem>
            )}
            {onRename && (
              <DropdownMenuItem onClick={onRename}>
                <Pencil className="h-3.5 w-3.5 mr-0.5" />
                {t('sweep.weldcrm.meetingIntelligenceHeader.rename')}
              </DropdownMenuItem>
            )}
            {onScheduleAgain && (
              <DropdownMenuItem onClick={onScheduleAgain}>
                <CalendarPlus className="h-3.5 w-3.5 mr-0.5" />
                {t('sweep.weldcrm.meetingIntelligenceHeader.scheduleAgain')}
              </DropdownMenuItem>
            )}
            {onDownloadRecording && (
              <DropdownMenuItem onClick={onDownloadRecording}>
                <Download className="h-3.5 w-3.5 mr-0.5" />
                {t('sweep.weldcrm.meetingIntelligenceHeader.downloadRecording')}
              </DropdownMenuItem>
            )}
            {onExportTranscript && (
              <DropdownMenuItem onClick={onExportTranscript}>
                <FileText className="h-3.5 w-3.5 mr-0.5" />
                {t('sweep.weldcrm.meetingIntelligenceHeader.exportTranscript')}
              </DropdownMenuItem>
            )}
            {onDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-red-500 focus:text-red-500 focus:bg-red-500/10"
                  onClick={onDelete}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-0.5 text-red-500" />
                  {t('sweep.weldcrm.meetingIntelligenceHeader.deleteMeeting')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
