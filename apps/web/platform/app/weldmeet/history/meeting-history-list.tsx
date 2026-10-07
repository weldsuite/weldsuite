/**
 * `MeetingHistoryList` — the single source of truth for the meeting-history
 * list UI.
 *
 * This holds the entire EntityList setup (columns, filters, date grouping,
 * sort, the per-meeting row, recordings, the actions menu, and the rename
 * dialog) shared by BOTH:
 *   - the full-page WeldMeet history view (`/weldmeet/history`)
 *   - the Meetings tab inside the CRM object panels (`meetings-tab.tsx`)
 *
 * Keeping it here means the two surfaces never drift: change a column, a
 * badge, the row, or a menu item once and both update. The only thing each
 * surface supplies is the `filter` — the page lists completed/failed/
 * cancelled meetings workspace-wide; the tab scopes them to the current
 * entity via `counterpartyId` / `personId`.
 */

import { useNavigate } from '@tanstack/react-router';
import { useAuth } from '@clerk/clerk-react';
import { useState, useMemo, useCallback } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Phone,
  EllipsisVertical,
  ExternalLink,
  Copy,
  Download,
  Trash2,
  Link,
  Pencil,
  CalendarPlus,
  FileText,
  Sparkles,
} from 'lucide-react';
import { VideoCameraIcon } from '../components/video-camera-icon';
import { format, isToday, isYesterday } from 'date-fns';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  EntityList,
  EmptyStateIllustration,
  type HeaderColumn,
  type FilterConfig,
  type GroupConfig,
  type ActiveFilter,
  type SortState,
} from '@/components/entity-list';
import { getTranslations } from '@/lib/i18n';
import { usePermissions } from '@weldsuite/permissions/react';
import {
  useMeetings,
  useDeleteMeeting,
  useUpdateMeeting,
  useRecordingsList,
  type Meeting,
  type MeetingListParams,
  type MeetingRecordingEntry,
} from '@/hooks/queries/use-weldmeet-queries';
import { useWorkspaceId } from '@/contexts/workspace-context';
import { buildMeetingShareUrl } from '@/lib/weldmeet/share-link';
import { getHistoryParticipants, getMeetingOrganizer } from '@/lib/weldmeet/meeting-people';
import { OrganizerCell, ParticipantsCell } from '../components/meeting-people-cells';
import { billableRecordingSeconds, isDeletableRecordingStatus } from '@/lib/weldmeet/recording';
import { RecordingStatusBadge } from '../components/recording-status-badge';
import {
  DeleteRecordingDialog,
  RecordingAiEstimateDialog,
  type RecordingAiKind,
} from '../components/recording-dialogs';
import { useDownloadRecording } from '../components/use-recording-download';
import { copyText } from '@/lib/clipboard';

type MeetingWithRecording = Meeting & { recording?: MeetingRecordingEntry };

type HistoryPageStrings = { dateToday: string; dateYesterday: string };

/** "Today, 3:05 PM" / "Yesterday, ..." / "Sep 30, 3:05 PM". */
function formatMeetingDate(dateStr: string, strings: HistoryPageStrings): string {
  const date = new Date(dateStr);
  if (isToday(date)) return strings.dateToday.replace('{time}', format(date, 'h:mm a'));
  if (isYesterday(date)) return strings.dateYesterday.replace('{time}', format(date, 'h:mm a'));
  return format(date, 'MMM d, h:mm a');
}

/** "1h 2m 3s" style label from a duration in seconds (hours omitted when 0). */
function formatDurationSeconds(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const hours = h > 0 ? `${h}h ` : '';
  return `${hours}${m}m ${s}s`;
}

/**
 * How long the meeting ran, in seconds: the latest session's duration, else the
 * recording's. 0 when neither is known.
 */
function getMeetingDurationSeconds(m: MeetingWithRecording): number {
  const fromSession = m.lastSession?.duration;
  if (fromSession && fromSession > 0) return fromSession;
  const rec = m.recording;
  if (rec?.duration) return rec.duration;
  if (rec?.startedAt && rec?.endedAt) {
    return Math.max(0, Math.floor((new Date(rec.endedAt).getTime() - new Date(rec.startedAt).getTime()) / 1000));
  }
  return 0;
}

/** When the meeting took place: its session start, else the scheduled slot, else creation. */
function getHistoryDateString(m: Meeting): string {
  return m.lastSession?.startedAt ?? m.scheduledStart ?? m.createdAt;
}

/** The newest session of each meeting wins (the list is not guaranteed to be ordered). */
function newestRecordingPerMeeting(recordings: MeetingRecordingEntry[]): Map<string, MeetingRecordingEntry> {
  const stamp = (r: MeetingRecordingEntry): number => {
    const value = r.startedAt ?? r.endedAt;
    return value ? new Date(value).getTime() : 0;
  };
  const map = new Map<string, MeetingRecordingEntry>();
  for (const rec of recordings) {
    const current = map.get(rec.meetingId);
    if (!current || stamp(rec) >= stamp(current)) map.set(rec.meetingId, rec);
  }
  return map;
}

const DAY_MS = 86400000;

interface DateBoundaries {
  todayStart: number;
  yesterdayStart: number;
  thisWeekStart: number;
  lastWeekStart: number;
  thisMonthStart: number;
}

function getDateBoundaries(): DateBoundaries {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - DAY_MS);
  const thisWeekStart = new Date(todayStart.getTime() - todayStart.getDay() * DAY_MS);
  const lastWeekStart = new Date(thisWeekStart.getTime() - 7 * DAY_MS);
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    todayStart: todayStart.getTime(),
    yesterdayStart: yesterdayStart.getTime(),
    thisWeekStart: thisWeekStart.getTime(),
    lastWeekStart: lastWeekStart.getTime(),
    thisMonthStart: thisMonthStart.getTime(),
  };
}

type FilterMatcher = (m: MeetingWithRecording, value: string, bounds: DateBoundaries) => boolean;

function matchesParticipantCount(count: number, value: string): boolean {
  switch (value) {
    case '1': return count === 1;
    case '2-5': return count >= 2 && count <= 5;
    case '6-10': return count >= 6 && count <= 10;
    case '10+': return count > 10;
    default: return true;
  }
}

function matchesDurationBucket(dur: number, value: string): boolean {
  switch (value) {
    case 'short': return dur > 0 && dur < 900;
    case 'medium': return dur >= 900 && dur < 1800;
    case 'long': return dur >= 1800 && dur < 3600;
    case 'extended': return dur >= 3600;
    default: return true;
  }
}

function matchesDateBucket(time: number, value: string, b: DateBoundaries): boolean {
  switch (value) {
    case 'today': return time >= b.todayStart;
    case 'yesterday': return time >= b.yesterdayStart && time < b.todayStart;
    case 'this-week': return time >= b.thisWeekStart && time < b.yesterdayStart;
    case 'last-week': return time >= b.lastWeekStart && time < b.thisWeekStart;
    case 'this-month': return time >= b.thisMonthStart && time < b.lastWeekStart;
    case 'older': return time < b.thisMonthStart;
    default: return true;
  }
}

/** One predicate per filter field; the `is` / `is not` operator is applied by the caller. */
const FILTER_MATCHERS = new Map<string, FilterMatcher>([
  ['organizer', (m, value) => getMeetingOrganizer(m)?.userId === value],
  ['meetingType', (m, value) => m.meetingType === value],
  ['recorded', (m, value) => !!m.recording === (value === 'yes')],
  ['participants', (m, value) => matchesParticipantCount(getHistoryParticipants(m).length, value)],
  ['duration', (m, value) => matchesDurationBucket(getMeetingDurationSeconds(m), value)],
  ['date', (m, value, bounds) =>
    matchesDateBucket(new Date(getHistoryDateString(m)).getTime(), value, bounds)],
  ['accessType', (m, value) => m.accessType === value],
]);

function applyMeetingFilters(items: MeetingWithRecording[], filters: ActiveFilter[]): MeetingWithRecording[] {
  const bounds = getDateBoundaries();
  let result = items;
  for (const filter of filters) {
    if (!filter.operator || !filter.value) continue;
    const matcher = FILTER_MATCHERS.get(filter.field);
    if (!matcher) continue;
    const isOp = filter.operator === 'is';
    result = result.filter(m => matcher(m, filter.value, bounds) === isOp);
  }
  return result;
}

export interface MeetingHistoryListProps {
  /** Server-side scope for the meetings query. The page lists workspace-wide
      `view: 'history'` meetings; the tab scopes to an entity. */
  filter: MeetingListParams;
  /** Outer wrapper className. Defaults to the full-page shell. */
  className?: string;
}

export function MeetingHistoryList({ filter, className }: Readonly<MeetingHistoryListProps>) {
  const t = getTranslations('weldmeet');
  const navigate = useNavigate();
  const [sortState, setSortState] = useState<SortState | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const { orgId } = useAuth();
  const workspaceId = useWorkspaceId() || orgId;
  const [deleteRecordingTarget, setDeleteRecordingTarget] = useState<MeetingRecordingEntry | null>(null);
  const [aiTarget, setAiTarget] = useState<{ kind: RecordingAiKind; rec: MeetingRecordingEntry } | null>(null);

  // Fully qualified keys: this list also renders inside CRM object panels.
  const { can } = usePermissions();
  const canPlayRecordings = can('weldmeet:recordings:read');
  const canDeleteRecordings = can('weldmeet:recordings:delete');
  // Transcribe / summarize spend credits, so they need sessions:update on top of read.
  const canUseRecordingAi = canPlayRecordings && can('weldmeet:sessions:update');
  const { download: downloadRecording } = useDownloadRecording();

  const listParams = useMemo<MeetingListParams>(() => ({ ...filter, include: 'lastSession' }), [filter]);
  const { data, isLoading } = useMeetings(listParams);
  const { data: recordings } = useRecordingsList();
  const { mutateAsync: deleteMeeting } = useDeleteMeeting();
  const { mutate: updateMeeting } = useUpdateMeeting();

  const handleRename = () => {
    const trimmed = renameDraft.trim();
    if (trimmed && renameId) {
      updateMeeting({ id: renameId, data: { title: trimmed } });
      toast.success(t.historyPage.actions.meetingRenamed);
    }
    setRenameId(null);
  };

  const recordingsByMeetingId = useMemo(() => {
    return newestRecordingPerMeeting(recordings ?? []);
  }, [recordings]);

  const meetings: MeetingWithRecording[] = useMemo(() => {
    if (!data) return [];
    return ((data.data ?? []) as Meeting[]).map((m) => ({
      ...m,
      recording: recordingsByMeetingId.get(m.id),
    }));
  }, [data, recordingsByMeetingId]);

  const organizerOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of meetings) {
      const org = getMeetingOrganizer(m);
      if (org?.userId && org.name) map.set(org.userId, org.name);
    }
    return Array.from(map.entries()).map(([value, label]) => ({ value, label }));
  }, [meetings]);

  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'organizer',
      label: t.historyPage.filters.organizer,
      options: organizerOptions,
      searchable: true,
    },
    {
      field: 'meetingType',
      label: t.historyPage.filters.type,
      options: [
        { value: 'video', label: t.historyPage.filters.video },
        { value: 'audio', label: t.historyPage.filters.audio },
      ],
    },
    {
      field: 'recorded',
      label: t.historyPage.filters.recording,
      options: [
        { value: 'yes', label: t.historyPage.filters.recorded },
        { value: 'no', label: t.historyPage.filters.notRecorded },
      ],
    },
    {
      field: 'participants',
      label: t.historyPage.filters.participants,
      options: [
        { value: '1', label: t.historyPage.filters.oneParticipant },
        { value: '2-5', label: t.historyPage.filters.twoToFive },
        { value: '6-10', label: t.historyPage.filters.sixToTen },
        { value: '10+', label: t.historyPage.filters.tenPlus },
      ],
    },
    {
      field: 'duration',
      label: t.historyPage.filters.duration,
      options: [
        { value: 'short', label: t.historyPage.filters.under15 },
        { value: 'medium', label: t.historyPage.filters.min15to30 },
        { value: 'long', label: t.historyPage.filters.min30to60 },
        { value: 'extended', label: t.historyPage.filters.over1h },
      ],
    },
    {
      field: 'date',
      label: t.historyPage.filters.date,
      options: [
        { value: 'today', label: t.historyPage.filters.today },
        { value: 'yesterday', label: t.historyPage.filters.yesterday },
        { value: 'this-week', label: t.historyPage.filters.thisWeek },
        { value: 'last-week', label: t.historyPage.filters.lastWeek },
        { value: 'this-month', label: t.historyPage.filters.thisMonth },
        { value: 'older', label: t.historyPage.filters.older },
      ],
    },
    {
      field: 'accessType',
      label: t.historyPage.filters.access,
      options: [
        { value: 'workspace', label: t.historyPage.filters.workspace },
        { value: 'invited_only', label: t.historyPage.filters.invitedOnly },
        { value: 'anyone_with_link', label: t.historyPage.filters.anyoneWithLink },
      ],
    },
  ], [organizerOptions, t]);

  const groupConfigs: GroupConfig<MeetingWithRecording>[] = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);
    const thisWeekStart = new Date(today.getTime() - today.getDay() * 86400000);
    const lastWeekStart = new Date(thisWeekStart.getTime() - 7 * 86400000);
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const getDate = (m: MeetingWithRecording) => new Date(getHistoryDateString(m)).getTime();

    return [
      { id: 'today', label: t.historyPage.groups.today, sortOrder: 1, filter: (m) => getDate(m) >= today.getTime() },
      { id: 'yesterday', label: t.historyPage.groups.yesterday, sortOrder: 2, filter: (m) => getDate(m) >= yesterday.getTime() && getDate(m) < today.getTime() },
      { id: 'this-week', label: t.historyPage.groups.thisWeek, sortOrder: 3, filter: (m) => getDate(m) >= thisWeekStart.getTime() && getDate(m) < yesterday.getTime() },
      { id: 'last-week', label: t.historyPage.groups.lastWeek, sortOrder: 4, filter: (m) => getDate(m) >= lastWeekStart.getTime() && getDate(m) < thisWeekStart.getTime() },
      { id: 'this-month', label: t.historyPage.groups.thisMonth, sortOrder: 5, filter: (m) => getDate(m) >= thisMonthStart.getTime() && getDate(m) < lastWeekStart.getTime() },
      { id: 'older', label: t.historyPage.groups.older, sortOrder: 6, filter: (m) => getDate(m) < thisMonthStart.getTime() },
    ];
  }, [t]);

  const handleSort = useCallback((columnId: string) => {
    setSortState(prev => {
      if (prev?.columnId === columnId) {
        if (prev.direction === 'asc') return { columnId, direction: 'desc' as const };
        return null;
      }
      return { columnId, direction: 'asc' as const };
    });
  }, []);

  const sortedMeetings = useMemo(() => {
    if (!sortState) return meetings;
    const { columnId, direction } = sortState;
    const dir = direction === 'asc' ? 1 : -1;

    return [...meetings].sort((a, b) => {
      switch (columnId) {
        case 'date': {
          const aTime = new Date(getHistoryDateString(a)).getTime();
          const bTime = new Date(getHistoryDateString(b)).getTime();
          return (aTime - bTime) * dir;
        }
        case 'attendees': {
          return (getHistoryParticipants(a).length - getHistoryParticipants(b).length) * dir;
        }
        case 'organizer': {
          const aName = getMeetingOrganizer(a)?.name ?? '';
          const bName = getMeetingOrganizer(b)?.name ?? '';
          return aName.localeCompare(bName) * dir;
        }
        case 'duration': {
          return (getMeetingDurationSeconds(a) - getMeetingDurationSeconds(b)) * dir;
        }
        default:
          return 0;
      }
    });
  }, [meetings, sortState]);

  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'meeting', header: t.historyPage.columns.meeting, width: 'min-w-[200px] flex-1' },
    { id: 'date', header: t.historyPage.columns.date, width: 'w-[180px]', sortable: true },
    { id: 'organizer', header: t.historyPage.columns.organizer, width: 'w-[190px]', sortable: true },
    { id: 'attendees', header: t.historyPage.columns.participants, width: 'w-[140px]', sortable: true },
    { id: 'duration', header: t.historyPage.columns.duration, width: 'w-[120px]', sortable: true },
  ], [t]);

  const renderRow = useCallback((meeting: MeetingWithRecording) => {
    const meetingTypeConfig = {
      video: { label: t.historyPage.filters.video, icon: VideoCameraIcon, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950' },
      audio: { label: t.historyPage.filters.audio, icon: Phone, color: 'text-purple-600 dark:text-purple-400', bg: 'bg-purple-50 dark:bg-purple-950' },
    } as const;
    const type = meetingTypeConfig[meeting.meetingType as keyof typeof meetingTypeConfig] ?? meetingTypeConfig.video;
    const TypeIcon = type.icon;
    const dateStr = getHistoryDateString(meeting);
    const rec = meeting.recording;
    const durationSeconds = getMeetingDurationSeconds(meeting);
    const durationLabel = durationSeconds > 0 ? formatDurationSeconds(durationSeconds) : null;
    const shareUrl = buildMeetingShareUrl(workspaceId, meeting.joinCode);
    const openMeeting = () => navigate({ to: '/weldmeet/$meetingId', params: { meetingId: meeting.id } });

    return (
      <div
        key={meeting.id}
        role="button"
        tabIndex={0}
        onClick={openMeeting}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            void openMeeting();
          }
        }}
        className={cn(
          'flex items-center gap-6 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group',
          meeting.status === 'cancelled' && '[&>*]:opacity-50',
        )}
      >
        {/* Meeting (+ recording state) */}
        <div className="min-w-[200px] flex-1 flex items-center gap-2">
          <TypeIcon className={cn('h-4 w-4 shrink-0', type.color)} />
          <span className={cn(
            'min-w-0 truncate text-sm font-medium',
            meeting.status === 'cancelled' ? 'line-through text-gray-400' : 'text-gray-900 dark:text-foreground',
          )}>
            {meeting.title}
          </span>
          {rec && (
            <span className="shrink-0">
              <RecordingStatusBadge status={rec.recordingStatus} />
            </span>
          )}
        </div>

        {/* Date */}
        <div className="w-[180px]">
          <span className="text-sm font-mono text-gray-600 dark:text-muted-foreground">
            {formatMeetingDate(dateStr, t.historyPage)}
          </span>
        </div>

        {/* Organizer */}
        <div className="w-[190px]">
          <OrganizerCell organizer={getMeetingOrganizer(meeting)} />
        </div>

        {/* Participants: who joined, plus the organizer */}
        <div className="w-[140px]">
          <ParticipantsCell
            people={getHistoryParticipants(meeting)}
            countLabel={(count) => t.historyPage.participantCount.replace('{count}', String(count))}
          />
        </div>

        {/* Duration */}
        <div className="w-[120px]">
          {durationLabel ? (
            <span className="text-sm font-mono text-muted-foreground">{durationLabel}</span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </div>

        {/* Actions */}
        <div className="w-[40px] flex justify-end" role="presentation" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent">
                <EllipsisVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => navigate({ to: '/weldmeet/$meetingId', params: { meetingId: meeting.id } })}>
                <ExternalLink className="h-3.5 w-3.5 mr-0.5" />
                {t.historyPage.actions.viewDetails}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => {
                copyText(meeting.joinCode ?? '', () => toast.success(t.historyPage.actions.joinCodeCopied));
              }}>
                <Copy className="h-3.5 w-3.5 mr-0.5" />
                {t.historyPage.actions.copyJoinCode}
              </DropdownMenuItem>
              {shareUrl && (
                <DropdownMenuItem onClick={() => {
                  copyText(shareUrl, () => toast.success(t.historyPage.actions.meetingLinkCopied));
                }}>
                  <Link className="h-3.5 w-3.5 mr-0.5" />
                  {t.historyPage.actions.copyMeetingLink}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => { setRenameId(meeting.id); setRenameDraft(meeting.title); }}>
                <Pencil className="h-3.5 w-3.5 mr-0.5" />
                {t.historyPage.actions.rename}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => {
                void navigate({ to: '/weldmeet/new', search: { from: meeting.id } });
              }}>
                <CalendarPlus className="h-3.5 w-3.5 mr-0.5" />
                {t.historyPage.actions.scheduleAgain}
              </DropdownMenuItem>
              {rec?.recordingStatus === 'ready' && canPlayRecordings && (
                <DropdownMenuItem onClick={() => void downloadRecording(rec.sessionId)}>
                  <Download className="h-3.5 w-3.5 mr-0.5" />
                  {t.historyPage.actions.downloadRecording}
                </DropdownMenuItem>
              )}
              {rec?.recordingStatus === 'ready' && canUseRecordingAi && rec.hasAudio && !rec.hasTranscript && (
                <DropdownMenuItem onClick={() => setAiTarget({ kind: 'transcribe', rec })}>
                  <FileText className="h-3.5 w-3.5 mr-0.5" />
                  {t.recording.actions.transcribe}
                </DropdownMenuItem>
              )}
              {rec?.recordingStatus === 'ready' && canUseRecordingAi && rec.hasTranscript && !rec.hasSummary
                && rec.summaryStatus !== 'pending' && rec.summaryStatus !== 'processing' && (
                <DropdownMenuItem onClick={() => setAiTarget({ kind: 'summarize', rec })}>
                  <Sparkles className="h-3.5 w-3.5 mr-0.5" />
                  {t.recording.actions.summarize}
                </DropdownMenuItem>
              )}
              {rec && canDeleteRecordings && isDeletableRecordingStatus(rec.recordingStatus) && (
                <DropdownMenuItem
                  onClick={() => setDeleteRecordingTarget(rec)}
                  className="text-red-500 focus:text-red-500 focus:bg-red-500/10"
                >
                  <Trash2 className="h-3.5 w-3.5 mr-0.5 text-red-500" />
                  {t.recording.actions.delete}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  deleteMeeting(meeting.id).then(
                    () => toast.success(t.historyPage.actions.meetingDeleted),
                    () => toast.error(t.historyPage.actions.meetingDeleteFailed),
                  );
                }}
                className="text-red-500 focus:text-red-500 focus:bg-red-500/10"
              >
                <Trash2 className="h-3.5 w-3.5 mr-0.5 text-red-500" />
                {t.historyPage.actions.deleteMeeting}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  }, [navigate, t, deleteMeeting, workspaceId, canPlayRecordings, canDeleteRecordings, canUseRecordingAi, downloadRecording]);

  return (
    <div className={cn('flex-1 flex flex-col w-full min-h-0 h-full overflow-hidden', className)}>
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden subtle-scrollbar">
        <EntityList<MeetingWithRecording>
          items={sortedMeetings}
          isLoading={isLoading}
          error={null}
          headerColumns={headerColumns}
          filters={filterConfigs}
          groups={groupConfigs}
          maxFilters={7}
          applyFilters={applyMeetingFilters}
          renderRow={renderRow}
          searchPlaceholder={t.historyPage.searchPlaceholder}
          searchFields={['title']}
          sortState={sortState}
          onSort={handleSort}
          columnGap="gap-6"
          topBarClassName="pt-2 pb-2"
          stickyOffset={0}
          emptyState={{
            icon: (
              <EmptyStateIllustration>
                <svg width="120" height="140" viewBox="0 0 120 140" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ transform: 'perspective(600px) rotateY(-6deg) rotateX(4deg)' }}>
                  <rect x="18" y="24" width="76" height="56" rx="6" className="fill-white dark:fill-white/[0.03]" />
                  <rect x="18" y="24" width="76" height="56" rx="6" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
                  <rect x="24" y="30" width="64" height="40" rx="3" className="fill-gray-50/60 dark:fill-white/[0.06]" />
                  <path d="M48 44L48 56L60 50L48 44Z" className="fill-gray-200 dark:fill-white/20" />
                  <circle cx="68" cy="50" r="6" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" fill="none" />
                  <circle cx="68" cy="48" r="2" className="fill-gray-200 dark:fill-white/15" />
                  <path d="M64 53C64 51 66 50 68 50C70 50 72 51 72 53" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="0.8" fill="none" />
                  <rect x="48" y="80" width="16" height="4" rx="1" className="fill-gray-200 dark:fill-white/15" />
                  <rect x="42" y="84" width="28" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" />
                  <path d="M80 28C84 28 87 31 87 35" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" strokeLinecap="round" fill="none" />
                  <path d="M80 33C82 33 84 34.5 84 36.5" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" strokeLinecap="round" fill="none" />
                </svg>
              </EmptyStateIllustration>
            ),
            title: t.historyPage.noMeetings,
            description: t.historyPage.noMeetingsHint,
          }}
          noResultsState={{
            title: t.historyPage.noResults,
            description: t.historyPage.noResultsHint,
          }}
        />
      </div>
      {/* Delete recording */}
      {deleteRecordingTarget && (
        <DeleteRecordingDialog
          open
          sessionId={deleteRecordingTarget.sessionId}
          onOpenChange={(open) => { if (!open) setDeleteRecordingTarget(null); }}
        />
      )}
      {/* Transcribe / summarize with a credit estimate */}
      {aiTarget && (
        <RecordingAiEstimateDialog
          open
          kind={aiTarget.kind}
          sessionId={aiTarget.rec.sessionId}
          seconds={billableRecordingSeconds({
            durationSeconds: aiTarget.rec.recordingDurationSeconds,
            sessionDurationSeconds: aiTarget.rec.duration,
          })}
          onOpenChange={(open) => { if (!open) setAiTarget(null); }}
        />
      )}
      {/* Rename dialog */}
      <Dialog open={!!renameId} onOpenChange={(open) => { if (!open) setRenameId(null); }}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t.historyPage.renameMeeting.title}</DialogTitle>
            <DialogDescription className="sr-only">{t.historyPage.renameMeeting.description}</DialogDescription>
          </DialogHeader>
          <Input
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); }}
            placeholder={t.historyPage.renameMeeting.placeholder}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameId(null)}>{t.historyPage.renameMeeting.cancel}</Button>
            <Button onClick={handleRename} disabled={!renameDraft.trim()}>{t.historyPage.renameMeeting.save}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
