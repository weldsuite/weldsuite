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
import { useState, useMemo, useCallback } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  Dialog,
  DialogContent,
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
} from 'lucide-react';
import { VideoCameraIcon } from '../components/video-camera-icon';
import { format, isToday, isYesterday } from 'date-fns';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipTrigger, TooltipContent } from '@weldsuite/ui/components/tooltip';
import { toast } from 'sonner';
import {
  EntityList,
  EmptyStateIllustration,
  type HeaderColumn,
  type FilterConfig,
  type GroupConfig,
  type ActiveFilter,
  type RowHandlers,
  type SortState,
} from '@/components/entity-list';
import { getTranslations } from '@/lib/i18n';
import {
  useMeetings,
  useDeleteMeeting,
  useUpdateMeeting,
  useRecordingsList,
  type Meeting,
  type MeetingRecordingEntry,
} from '@/hooks/queries/use-weldmeet-queries';
import type { ListMeetingsParams } from '@/lib/api/domains/weldmeet';

type MeetingWithRecording = Meeting & { recording?: MeetingRecordingEntry };

export interface MeetingHistoryListProps {
  /** Server-side scope for the meetings query. Page lists workspace-wide
      completed/failed/cancelled; the tab scopes to an entity. */
  filter: ListMeetingsParams;
  /** Outer wrapper className. Defaults to the full-page shell. */
  className?: string;
}

export function MeetingHistoryList({ filter, className }: MeetingHistoryListProps) {
  const t = getTranslations('weldmeet');
  const navigate = useNavigate();
  const [sortState, setSortState] = useState<SortState | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const { data, isLoading } = useMeetings(filter);
  const { data: recordings } = useRecordingsList();
  const { mutate: deleteMeeting } = useDeleteMeeting();
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
    const map = new Map<string, MeetingRecordingEntry>();
    if (recordings) {
      for (const rec of recordings) {
        map.set(rec.meetingId, rec);
      }
    }
    return map;
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
      const org = (m.attendees ?? []).find((a: any) => a.role === 'organizer');
      if (org?.userId && org?.name) map.set(org.userId, org.name);
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

    const getDate = (m: MeetingWithRecording) => new Date(m.scheduledStart ?? m.createdAt).getTime();

    return [
      { id: 'today', label: t.historyPage.groups.today, sortOrder: 1, filter: (m) => getDate(m) >= today.getTime() },
      { id: 'yesterday', label: t.historyPage.groups.yesterday, sortOrder: 2, filter: (m) => getDate(m) >= yesterday.getTime() && getDate(m) < today.getTime() },
      { id: 'this-week', label: t.historyPage.groups.thisWeek, sortOrder: 3, filter: (m) => getDate(m) >= thisWeekStart.getTime() && getDate(m) < yesterday.getTime() },
      { id: 'last-week', label: t.historyPage.groups.lastWeek, sortOrder: 4, filter: (m) => getDate(m) >= lastWeekStart.getTime() && getDate(m) < thisWeekStart.getTime() },
      { id: 'this-month', label: t.historyPage.groups.thisMonth, sortOrder: 5, filter: (m) => getDate(m) >= thisMonthStart.getTime() && getDate(m) < lastWeekStart.getTime() },
      { id: 'older', label: t.historyPage.groups.older, sortOrder: 6, filter: (m) => getDate(m) < thisMonthStart.getTime() },
    ];
  }, [t]);

  const applyFilters = useCallback((items: MeetingWithRecording[], filters: ActiveFilter[]) => {
    let result = items;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterdayStart = new Date(todayStart.getTime() - 86400000);
    const thisWeekStart = new Date(todayStart.getTime() - todayStart.getDay() * 86400000);
    const lastWeekStart = new Date(thisWeekStart.getTime() - 7 * 86400000);
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    filters.forEach(filter => {
      if (!filter.operator || !filter.value) return;
      const isOp = filter.operator === 'is';

      if (filter.field === 'organizer') {
        const match = (m: MeetingWithRecording) => {
          const org = (m.attendees ?? []).find((a: any) => a.role === 'organizer');
          return org?.userId === filter.value;
        };
        result = isOp ? result.filter(match) : result.filter(m => !match(m));
      } else if (filter.field === 'meetingType') {
        result = isOp
          ? result.filter(m => m.meetingType === filter.value)
          : result.filter(m => m.meetingType !== filter.value);
      } else if (filter.field === 'recorded') {
        const hasRec = filter.value === 'yes';
        result = isOp
          ? result.filter(m => !!m.recording === hasRec)
          : result.filter(m => !!m.recording !== hasRec);
      } else if (filter.field === 'participants') {
        const match = (m: MeetingWithRecording) => {
          const count = m.attendees?.length ?? 0;
          switch (filter.value) {
            case '1': return count === 1;
            case '2-5': return count >= 2 && count <= 5;
            case '6-10': return count >= 6 && count <= 10;
            case '10+': return count > 10;
            default: return true;
          }
        };
        result = isOp ? result.filter(match) : result.filter(m => !match(m));
      } else if (filter.field === 'duration') {
        const match = (m: MeetingWithRecording) => {
          const dur = m.recording?.duration ?? 0;
          switch (filter.value) {
            case 'short': return dur > 0 && dur < 900;
            case 'medium': return dur >= 900 && dur < 1800;
            case 'long': return dur >= 1800 && dur < 3600;
            case 'extended': return dur >= 3600;
            default: return true;
          }
        };
        result = isOp ? result.filter(match) : result.filter(m => !match(m));
      } else if (filter.field === 'date') {
        const match = (m: MeetingWithRecording) => {
          const t = new Date(m.scheduledStart ?? m.createdAt).getTime();
          switch (filter.value) {
            case 'today': return t >= todayStart.getTime();
            case 'yesterday': return t >= yesterdayStart.getTime() && t < todayStart.getTime();
            case 'this-week': return t >= thisWeekStart.getTime() && t < yesterdayStart.getTime();
            case 'last-week': return t >= lastWeekStart.getTime() && t < thisWeekStart.getTime();
            case 'this-month': return t >= thisMonthStart.getTime() && t < lastWeekStart.getTime();
            case 'older': return t < thisMonthStart.getTime();
            default: return true;
          }
        };
        result = isOp ? result.filter(match) : result.filter(m => !match(m));
      } else if (filter.field === 'accessType') {
        result = isOp
          ? result.filter(m => m.accessType === filter.value)
          : result.filter(m => m.accessType !== filter.value);
      }
    });
    return result;
  }, []);

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
          const aTime = a.scheduledStart ? new Date(a.scheduledStart).getTime() : new Date(a.createdAt).getTime();
          const bTime = b.scheduledStart ? new Date(b.scheduledStart).getTime() : new Date(b.createdAt).getTime();
          return (aTime - bTime) * dir;
        }
        case 'attendees': {
          return ((a.attendees?.length ?? 0) - (b.attendees?.length ?? 0)) * dir;
        }
        case 'organizer': {
          const aName = (a.attendees ?? []).find((att: any) => att.role === 'organizer')?.name ?? '';
          const bName = (b.attendees ?? []).find((att: any) => att.role === 'organizer')?.name ?? '';
          return aName.localeCompare(bName) * dir;
        }
        case 'duration': {
          const aDur = a.recording?.duration ?? 0;
          const bDur = b.recording?.duration ?? 0;
          return (aDur - bDur) * dir;
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

  const renderRow = useCallback((meeting: MeetingWithRecording, _handlers: RowHandlers<MeetingWithRecording>) => {
    const meetingTypeConfig = {
      video: { label: t.historyPage.filters.video, icon: VideoCameraIcon, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950' },
      audio: { label: t.historyPage.filters.audio, icon: Phone, color: 'text-purple-600 dark:text-purple-400', bg: 'bg-purple-50 dark:bg-purple-950' },
    } as const;
    const type = meetingTypeConfig[meeting.meetingType as keyof typeof meetingTypeConfig] ?? meetingTypeConfig.video;
    const TypeIcon = type.icon;
    const dateStr = meeting.scheduledStart ?? meeting.createdAt;
    const rec = meeting.recording;

    return (
      <div
        key={meeting.id}
        onClick={() => navigate({ to: '/weldmeet/$meetingId', params: { meetingId: meeting.id } })}
        className={cn(
          'flex items-center gap-6 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group',
          meeting.status === 'cancelled' && '[&>*]:opacity-50',
        )}
      >
        {/* Meeting */}
        <div className="min-w-[200px] flex-1 flex items-center gap-2">
          <TypeIcon className={cn('h-4 w-4 shrink-0', type.color)} />
          <span className={cn(
            'text-sm font-medium truncate',
            meeting.status === 'cancelled' ? 'line-through text-gray-400' : 'text-gray-900 dark:text-foreground',
          )}>
            {meeting.title}
          </span>
        </div>

        {/* Recorded label */}
        {rec?.recordingUrl && (
          <span className="flex items-center gap-1 px-2 py-[4px] rounded-[6px] text-[12px] font-medium bg-red-50 dark:bg-red-950 text-red-600 dark:text-red-400">
            <div className="h-1.5 w-1.5 rounded-full bg-red-500" />
            {t.historyPage.recorded}
          </span>
        )}

        {/* Date */}
        <div className="w-[180px]">
          <span className="text-sm font-mono text-gray-600 dark:text-muted-foreground">
            {isToday(new Date(dateStr))
              ? t.historyPage.dateToday.replace('{time}', format(new Date(dateStr), 'h:mm a'))
              : isYesterday(new Date(dateStr))
                ? t.historyPage.dateYesterday.replace('{time}', format(new Date(dateStr), 'h:mm a'))
                : format(new Date(dateStr), 'MMM d, h:mm a')}
          </span>
        </div>

        {/* Organizer */}
        <div className="w-[190px]">
          {(() => {
            const organizer = (meeting.attendees ?? []).find((a: any) => a.role === 'organizer');
            if (!organizer) return <span className="text-sm text-muted-foreground">—</span>;
            return (
              <div className="flex items-center gap-2">
                <div className="w-[23px] h-[23px] rounded-md bg-gray-200 dark:bg-accent flex items-center justify-center shrink-0">
                  <span className="text-[10px] font-medium text-gray-600 dark:text-muted-foreground">
                    {organizer.name?.charAt(0)?.toUpperCase() ?? '?'}
                  </span>
                </div>
                <span className="text-sm text-gray-700 dark:text-foreground truncate">{organizer.name}</span>
              </div>
            );
          })()}
        </div>

        {/* Participants */}
        <div className="w-[140px]">
          <div className="flex items-center gap-2">
            <div className="flex -space-x-1.5">
              {(meeting.attendees ?? []).slice(0, 3).map((attendee, i) => (
                <Tooltip key={attendee.userId ?? i}>
                  <TooltipTrigger asChild>
                    <div
                      className="w-[23px] h-[23px] rounded-md bg-gray-200 dark:bg-accent flex items-center justify-center ring-2 ring-white dark:ring-background"
                    >
                      <span className="text-[10px] font-medium text-gray-600 dark:text-muted-foreground">
                        {attendee.name?.charAt(0)?.toUpperCase() ?? '?'}
                      </span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6}>
                    {attendee.name}
                  </TooltipContent>
                </Tooltip>
              ))}
              {(meeting.attendees?.length ?? 0) > 3 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="w-[23px] h-[23px] rounded-md bg-gray-200 dark:bg-accent flex items-center justify-center ring-2 ring-white dark:ring-background">
                      <span className="text-[11px] font-semibold text-gray-600 dark:text-muted-foreground">
                        +{meeting.attendees!.length - 3}
                      </span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6}>
                    {t.historyPage.participantCount.replace('{count}', String(meeting.attendees!.length))}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
        </div>

        {/* Duration */}
        <div className="w-[120px]">
          {rec?.duration ? (
            <span className="text-sm font-mono text-muted-foreground">
              {Math.floor(rec.duration / 3600) > 0 && `${Math.floor(rec.duration / 3600)}h `}
              {Math.floor((rec.duration % 3600) / 60)}m {rec.duration % 60}s
            </span>
          ) : rec?.startedAt && rec?.endedAt ? (
            <span className="text-sm font-mono text-muted-foreground">
              {(() => {
                const secs = Math.floor((new Date(rec.endedAt).getTime() - new Date(rec.startedAt).getTime()) / 1000);
                const h = Math.floor(secs / 3600);
                const m = Math.floor((secs % 3600) / 60);
                const s = secs % 60;
                return `${h > 0 ? `${h}h ` : ''}${m}m ${s}s`;
              })()}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </div>

        {/* Actions */}
        <div className="w-[40px] flex justify-end" onClick={(e) => e.stopPropagation()}>
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
                navigator.clipboard.writeText(meeting.joinCode ?? '');
                toast.success(t.historyPage.actions.joinCodeCopied);
              }}>
                <Copy className="h-3.5 w-3.5 mr-0.5" />
                {t.historyPage.actions.copyJoinCode}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => {
                const url = `${window.location.origin}/weldmeet/${meeting.id}`;
                navigator.clipboard.writeText(url);
                toast.success(t.historyPage.actions.meetingLinkCopied);
              }}>
                <Link className="h-3.5 w-3.5 mr-0.5" />
                {t.historyPage.actions.copyMeetingLink}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => { setRenameId(meeting.id); setRenameDraft(meeting.title); }}>
                <Pencil className="h-3.5 w-3.5 mr-0.5" />
                {t.historyPage.actions.rename}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => {
                navigate({ to: '/weldmeet/new', search: { from: meeting.id } });
              }}>
                <CalendarPlus className="h-3.5 w-3.5 mr-0.5" />
                {t.historyPage.actions.scheduleAgain}
              </DropdownMenuItem>
              {rec?.recordingUrl && (
                <DropdownMenuItem onClick={() => window.open(rec.recordingUrl!, '_blank')}>
                  <Download className="h-3.5 w-3.5 mr-0.5" />
                  {t.historyPage.actions.downloadRecording}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  deleteMeeting(meeting.id);
                  toast.success(t.historyPage.actions.meetingDeleted);
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
  }, [navigate, t, deleteMeeting]);

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
          applyFilters={applyFilters}
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
      {/* Rename dialog */}
      <Dialog open={!!renameId} onOpenChange={(open) => { if (!open) setRenameId(null); }}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t.historyPage.renameMeeting.title}</DialogTitle>
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
