
import { Button } from '@weldsuite/ui/components/button';
import { RecordingHeader } from '@weldsuite/ui/components/recording-layout';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
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
import { detectPlatform } from './utils';
import type { MeetingIntelligenceCall, HeaderAction } from './types';
import { useTranslations } from '@weldsuite/i18n/client';

interface MeetingIntelligenceHeaderProps {
  call: MeetingIntelligenceCall;
  mediaType?: 'video' | 'audio' | 'none';
  isTranscribing: boolean;
  hasTranscription: boolean;
  isLoadingTranscription: boolean;
  onBack: () => void;
  onTranscribe?: () => void;
  onDelete?: () => void;
  onMinimize?: () => void;
  onRename?: () => void;
  onTitleChange?: (title: string) => void;
  titleLabel?: string;
  onCopyJoinCode?: () => void;
  onCopyLink?: () => void;
  onScheduleAgain?: () => void;
  onDownloadRecording?: () => void;
  onDeleteRecording?: () => void;
  deleteRecordingLabel?: string;
  onExportTranscript?: () => void;
  headerActions?: HeaderAction[];
}

export function MeetingIntelligenceHeader({
  call,
  mediaType = 'video',
  isTranscribing,
  hasTranscription,
  isLoadingTranscription,
  onBack,
  onTranscribe,
  onDelete,
  onRename,
  onTitleChange,
  titleLabel,
  onCopyJoinCode,
  onCopyLink,
  onScheduleAgain,
  onDownloadRecording,
  onDeleteRecording,
  deleteRecordingLabel,
  onExportTranscript,
  headerActions,
}: Readonly<MeetingIntelligenceHeaderProps>) {
  const t = useTranslations();
  const _callDate = new Date(call.date);
  const _callDuration = call.duration || 0;
  const platformInfo = detectPlatform(call.platform, call.meetingUrl);
  const MediaIcon = mediaType === 'audio' ? Phone : Video;

  // The shared recording header (WeldPanel replays use it too), with this page's actions.
  return (
    <RecordingHeader
      onBack={onBack}
      backLabel={t('common.actions.back')}
      icon={
        platformInfo ? (
          <img src={platformInfo.icon} alt={platformInfo.name} className="h-5 w-5" />
        ) : (
          <MediaIcon className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
        )
      }
      title={call.subject || t('sweep.weldcrm.meetingIntelligenceHeader.untitledCall')}
      onRename={onTitleChange}
      titleLabel={titleLabel}
      actions={
        <>
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
          {headerActions?.map((action) => (
            <Button
              key={action.label}
              variant={action.variant || 'ghost'}
              size={action.showLabel ? 'sm' : 'icon-sm'}
              className={action.showLabel ? 'h-8 gap-1.5' : undefined}
              onClick={action.onClick}
              disabled={action.disabled}
              title={action.label}
              aria-label={action.showLabel ? undefined : action.label}
            >
              {action.icon}
              {action.showLabel && action.label}
            </Button>
          ))}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="data-[state=open]:bg-accent" aria-label={t('common.actions.openMenu')} title={t('common.actions.openMenu')}>
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
              {onDeleteRecording && (
                <DropdownMenuItem
                  className="text-red-500 focus:text-red-500 focus:bg-red-500/10"
                  onClick={onDeleteRecording}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-0.5 text-red-500" />
                  {deleteRecordingLabel ?? t('sweep.weldcrm.meetingIntelligenceHeader.deleteMeeting')}
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
        </>
      }
    />
  );
}
