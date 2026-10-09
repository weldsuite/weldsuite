import { useNavigate } from '@tanstack/react-router';
import { useAuth } from '@clerk/clerk-react';
import { useMeetings, useCancelMeeting, useUpdateMeeting, type Meeting } from '@/hooks/queries/use-weldmeet-queries';
import { useState, useMemo, useCallback } from 'react';
import { CancelMeetingDialog } from '../components/cancel-meeting-dialog';
import { OrganizerCell, ParticipantsCell } from '../components/meeting-people-cells';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  Phone,
  EllipsisVertical,
  ExternalLink,
  Copy,
  XCircle,
  Link,
  Pencil,
} from 'lucide-react';
import { VideoCameraIcon } from '../components/video-camera-icon';
import { format, isToday, isTomorrow, startOfDay, addDays, isBefore, startOfMonth, addMonths, startOfYear, addYears } from 'date-fns';
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
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useWorkspaceId } from '@/contexts/workspace-context';
import { buildMeetingShareUrl } from '@/lib/weldmeet/share-link';
import { getInvitedParticipants, getMeetingOrganizer } from '@/lib/weldmeet/meeting-people';

interface UpcomingDateBoundaries {
  thisWeekEnd: Date;
  nextWeekEnd: Date;
  thisMonthEnd: Date;
}

type UpcomingFilterMatcher = (m: Meeting, value: string, bounds: UpcomingDateBoundaries) => boolean;

function getUpcomingDateBoundaries(): UpcomingDateBoundaries {
  const now = new Date();
  const thisWeekEnd = startOfDay(addDays(now, 7 - now.getDay()));
  return {
    thisWeekEnd,
    nextWeekEnd: addDays(thisWeekEnd, 7),
    thisMonthEnd: startOfMonth(addMonths(now, 1)),
  };
}

function matchesParticipantCount(count: number, value: string): boolean {
  switch (value) {
    case '1': return count === 1;
    case '2-5': return count >= 2 && count <= 5;
    case '6-10': return count >= 6 && count <= 10;
    case '10+': return count > 10;
    default: return true;
  }
}

function matchesDateBucket(d: Date, value: string, b: UpcomingDateBoundaries): boolean {
  switch (value) {
    case 'today': return isToday(d);
    case 'tomorrow': return isTomorrow(d);
    case 'this-week': return !isToday(d) && !isTomorrow(d) && isBefore(d, b.thisWeekEnd);
    case 'next-week': return !isBefore(d, b.thisWeekEnd) && isBefore(d, b.nextWeekEnd);
    case 'this-month': return !isBefore(d, b.nextWeekEnd) && isBefore(d, b.thisMonthEnd);
    case 'later': return !isBefore(d, b.thisMonthEnd);
    default: return true;
  }
}

/** One predicate per filter field; the `is` / `is not` operator is applied by the caller. */
const UPCOMING_FILTER_MATCHERS = new Map<string, UpcomingFilterMatcher>([
  ['organizer', (m, value) => getMeetingOrganizer(m)?.userId === value],
  ['meetingType', (m, value) => m.meetingType === value],
  ['participants', (m, value) => matchesParticipantCount(getInvitedParticipants(m).length, value)],
  // An unscheduled meeting has no date, so it is in no date bucket.
  ['date', (m, value, bounds) => !!m.scheduledStart && matchesDateBucket(new Date(m.scheduledStart), value, bounds)],
  ['accessType', (m, value) => m.accessType === value],
]);

function applyUpcomingFilters(items: Meeting[], filters: ActiveFilter[]): Meeting[] {
  const bounds = getUpcomingDateBoundaries();
  let result = items;
  for (const filter of filters) {
    if (!filter.operator || !filter.value) continue;
    const matcher = UPCOMING_FILTER_MATCHERS.get(filter.field);
    if (!matcher) continue;
    const isOp = filter.operator === 'is';
    result = result.filter(m => matcher(m, filter.value, bounds) === isOp);
  }
  return result;
}

/** The scheduled start of a meeting; never `createdAt`, which is not an upcoming date. */
function getScheduledDate(m: Meeting): Date | null {
  return m.scheduledStart ? new Date(m.scheduledStart) : null;
}

export default function UpcomingMeetingsPage() {
  const t = getTranslations('weldmeet');
  const navLabels = getTranslations('navigation').moduleSidebar.weldmeet;
  useBreadcrumbs([{ label: navLabels.upcoming }]);
  const navigate = useNavigate();
  const { orgId } = useAuth();
  const workspaceId = useWorkspaceId() || orgId;
  const [sortState, setSortState] = useState<SortState | null>(null);
  const [cancelDialogMeetingId, setCancelDialogMeetingId] = useState<string | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const cancelMeeting = useCancelMeeting();

  const { data, isLoading } = useMeetings({ pageSize: 50, view: 'upcoming', include: 'lastSession' });
  const { mutate: updateMeeting } = useUpdateMeeting();

  const handleRename = () => {
    const trimmed = renameDraft.trim();
    if (trimmed && renameId) {
      updateMeeting({ id: renameId, data: { title: trimmed } });
      toast.success(t.upcomingPage.actions.meetingRenamed);
    }
    setRenameId(null);
  };

  const meetings = useMemo(() => {
    if (!data) return [];
    return (data.data ?? []) as Meeting[];
  }, [data]);

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
      label: t.upcomingPage.filters.organizer,
      options: organizerOptions,
      searchable: true,
    },
    {
      field: 'meetingType',
      label: t.upcomingPage.filters.type,
      options: [
        { value: 'video', label: t.upcomingPage.filters.video },
        { value: 'audio', label: t.upcomingPage.filters.audio },
      ],
    },
    {
      field: 'participants',
      label: t.upcomingPage.filters.participants,
      options: [
        { value: '1', label: t.upcomingPage.filters.oneParticipant },
        { value: '2-5', label: t.upcomingPage.filters.twoToFive },
        { value: '6-10', label: t.upcomingPage.filters.sixToTen },
        { value: '10+', label: t.upcomingPage.filters.tenPlus },
      ],
    },
    {
      field: 'date',
      label: t.upcomingPage.filters.date,
      options: [
        { value: 'today', label: t.upcomingPage.filters.today },
        { value: 'tomorrow', label: t.upcomingPage.filters.tomorrow },
        { value: 'this-week', label: t.upcomingPage.filters.thisWeek },
        { value: 'next-week', label: t.upcomingPage.filters.nextWeek },
        { value: 'this-month', label: t.upcomingPage.filters.thisMonth },
        { value: 'later', label: t.upcomingPage.filters.later },
      ],
    },
    {
      field: 'accessType',
      label: t.upcomingPage.filters.access,
      options: [
        { value: 'workspace', label: t.upcomingPage.filters.workspace },
        { value: 'invited_only', label: t.upcomingPage.filters.invitedOnly },
        { value: 'anyone_with_link', label: t.upcomingPage.filters.anyoneWithLink },
      ],
    },
  ], [organizerOptions, t]);

  const groupConfigs: GroupConfig<Meeting>[] = useMemo(() => {
    const now = new Date();
    const endOfThisWeek = startOfDay(addDays(now, 7 - now.getDay()));
    const endOfNextWeek = addDays(endOfThisWeek, 7);
    const endOfThisMonth = startOfMonth(addMonths(now, 1));
    const endOfNextMonth = startOfMonth(addMonths(now, 2));
    const endOfThisYear = startOfYear(addYears(now, 1));
    const endOfNextYear = startOfYear(addYears(now, 2));

    // A date group holds the meetings that are scheduled and not live: a live
    // one is in "Live now", an unscheduled one in "Not scheduled".
    const inDateGroup = (m: Meeting, test: (d: Date) => boolean): boolean => {
      if (m.status === 'in_progress') return false;
      const d = getScheduledDate(m);
      return !!d && test(d);
    };

    return [
      { id: 'live-now', label: t.upcomingPage.groups.liveNow, sortOrder: 0, filter: (m) => m.status === 'in_progress' },
      { id: 'today', label: t.upcomingPage.filters.today, sortOrder: 1, filter: (m) => inDateGroup(m, isToday) },
      { id: 'tomorrow', label: t.upcomingPage.filters.tomorrow, sortOrder: 2, filter: (m) => inDateGroup(m, isTomorrow) },
      { id: 'this-week', label: t.upcomingPage.filters.thisWeek, sortOrder: 3, filter: (m) => inDateGroup(m, (d) =>
        !isToday(d) && !isTomorrow(d) && isBefore(d, endOfThisWeek)) },
      { id: 'next-week', label: t.upcomingPage.filters.nextWeek, sortOrder: 4, filter: (m) => inDateGroup(m, (d) =>
        !isBefore(d, endOfThisWeek) && isBefore(d, endOfNextWeek)) },
      { id: 'this-month', label: t.upcomingPage.filters.thisMonth, sortOrder: 5, filter: (m) => inDateGroup(m, (d) =>
        !isBefore(d, endOfNextWeek) && isBefore(d, endOfThisMonth)) },
      { id: 'next-month', label: t.upcomingPage.groups.nextMonth, sortOrder: 6, filter: (m) => inDateGroup(m, (d) =>
        !isBefore(d, endOfThisMonth) && isBefore(d, endOfNextMonth)) },
      { id: 'this-year', label: format(now, 'yyyy'), sortOrder: 7, filter: (m) => inDateGroup(m, (d) =>
        !isBefore(d, endOfNextMonth) && isBefore(d, endOfThisYear)) },
      { id: 'next-year', label: format(addYears(now, 1), 'yyyy'), sortOrder: 8, filter: (m) => inDateGroup(m, (d) =>
        !isBefore(d, endOfThisYear) && isBefore(d, endOfNextYear)) },
      { id: 'not-scheduled', label: t.upcomingPage.groups.notScheduled, sortOrder: 9, filter: (m) =>
        m.status !== 'in_progress' && !m.scheduledStart },
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
          // Unscheduled meetings stay at the end whichever way the date sorts.
          const aTime = getScheduledDate(a)?.getTime();
          const bTime = getScheduledDate(b)?.getTime();
          if (aTime === undefined && bTime === undefined) return 0;
          if (aTime === undefined) return 1;
          if (bTime === undefined) return -1;
          return (aTime - bTime) * dir;
        }
        case 'attendees':
          return (getInvitedParticipants(a).length - getInvitedParticipants(b).length) * dir;
        case 'organizer': {
          const aName = getMeetingOrganizer(a)?.name ?? '';
          const bName = getMeetingOrganizer(b)?.name ?? '';
          return aName.localeCompare(bName) * dir;
        }
        default:
          return 0;
      }
    });
  }, [meetings, sortState]);

  const meetingTypeConfig = useMemo(() => ({
    video: { label: t.upcomingPage.filters.video, icon: VideoCameraIcon, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950' },
    audio: { label: t.upcomingPage.filters.audio, icon: Phone, color: 'text-purple-600 dark:text-purple-400', bg: 'bg-purple-50 dark:bg-purple-950' },
  } as const), [t]);

  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'meeting', header: t.upcomingPage.columns.meeting, width: 'min-w-[200px] flex-1' },
    { id: 'date', header: t.upcomingPage.columns.date, width: 'w-[180px]', sortable: true },
    { id: 'organizer', header: t.upcomingPage.columns.organizer, width: 'w-[190px]', sortable: true },
    { id: 'attendees', header: t.upcomingPage.columns.participants, width: 'w-[140px]', sortable: true },
  ], [t]);

  const handleCancelConfirm = useCallback(async (sendNotification: boolean) => {
    if (!cancelDialogMeetingId) return;
    try {
      await cancelMeeting.mutateAsync({ id: cancelDialogMeetingId, sendNotification });
      toast.success(t.upcomingPage.meetingCancelled);
    } catch {
      toast.error(t.upcomingPage.failedToCancel);
    }
    setCancelDialogMeetingId(null);
  }, [cancelMeeting, cancelDialogMeetingId, t]);

  const renderRow = useCallback((meeting: Meeting) => {
    const type = meetingTypeConfig[meeting.meetingType as keyof typeof meetingTypeConfig] ?? meetingTypeConfig.video;
    const TypeIcon = type.icon;
    const scheduled = getScheduledDate(meeting);
    const shareUrl = buildMeetingShareUrl(workspaceId, meeting.joinCode);

    const openMeeting = () => {
      void navigate({ to: '/weldmeet/$meetingId', params: { meetingId: meeting.id } });
    };

    let dateLabel = '—';
    if (scheduled) {
      if (isToday(scheduled)) {
        dateLabel = t.upcomingPage.dateToday.replace('{time}', format(scheduled, 'h:mm a'));
      } else if (isTomorrow(scheduled)) {
        dateLabel = t.upcomingPage.dateTomorrow.replace('{time}', format(scheduled, 'h:mm a'));
      } else {
        dateLabel = format(scheduled, 'MMM d, h:mm a');
      }
    }

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
            openMeeting();
          }
        }}
        className="flex items-center gap-6 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group"
      >
        {/* Meeting (+ live pill) */}
        <div className="min-w-[200px] flex-1 flex items-center gap-2">
          <TypeIcon className={cn('h-4 w-4 shrink-0', type.color)} />
          <span className="min-w-0 truncate text-sm font-medium text-gray-900 dark:text-foreground">
            {meeting.title}
          </span>
          {meeting.status === 'in_progress' && (
            <span className="shrink-0 flex items-center gap-1 px-2 py-[4px] rounded-[6px] text-[12px] font-medium bg-emerald-50 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400">
              <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              {t.upcomingPage.live}
            </span>
          )}
        </div>

        {/* Date */}
        <div className="w-[180px]">
          <span className="text-sm font-mono text-gray-600 dark:text-muted-foreground">
            {dateLabel}
          </span>
        </div>

        {/* Organizer */}
        <div className="w-[190px]">
          <OrganizerCell organizer={getMeetingOrganizer(meeting)} />
        </div>

        {/* Participants: organizer + attendees */}
        <div className="w-[140px]">
          <ParticipantsCell
            people={getInvitedParticipants(meeting)}
            countLabel={(count) => t.upcomingPage.participantCount.replace('{count}', String(count))}
          />
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
                {t.upcomingPage.actions.viewDetails}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => {
                void navigator.clipboard.writeText(meeting.joinCode ?? '');
                toast.success(t.upcomingPage.actions.joinCodeCopied);
              }}>
                <Copy className="h-3.5 w-3.5 mr-0.5" />
                {t.upcomingPage.actions.copyJoinCode}
              </DropdownMenuItem>
              {shareUrl && (
                <DropdownMenuItem onClick={() => {
                  void navigator.clipboard.writeText(shareUrl);
                  toast.success(t.upcomingPage.actions.meetingLinkCopied);
                }}>
                  <Link className="h-3.5 w-3.5 mr-0.5" />
                  {t.upcomingPage.actions.copyMeetingLink}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => { setRenameId(meeting.id); setRenameDraft(meeting.title); }}>
                <Pencil className="h-3.5 w-3.5 mr-0.5" />
                {t.upcomingPage.actions.rename}
              </DropdownMenuItem>
              {meeting.status === 'scheduled' && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-red-600 focus:bg-red-50 focus:text-red-600 dark:focus:bg-red-950"
                    onClick={() => setCancelDialogMeetingId(meeting.id)}
                  >
                    <XCircle className="h-3.5 w-3.5 mr-0.5 text-red-500" />
                    {t.upcomingPage.actions.cancelMeeting}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  }, [navigate, t, meetingTypeConfig, workspaceId]);

  return (
    <div className="flex-1 flex flex-col w-full min-h-0 h-full overflow-hidden">
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden subtle-scrollbar">
        <EntityList<Meeting>
          items={sortedMeetings}
          isLoading={isLoading}
          error={null}
          headerColumns={headerColumns}
          filters={filterConfigs}
          groups={groupConfigs}
          maxFilters={5}
          applyFilters={applyUpcomingFilters}
          renderRow={renderRow}
          searchPlaceholder={t.upcomingPage.searchPlaceholder}
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
            title: t.upcomingPage.noMeetings,
            description: t.upcomingPage.noMeetingsHint,
          }}
          noResultsState={{
            title: t.upcomingPage.noResults,
            description: t.upcomingPage.noResultsHint,
          }}
        />
      </div>

      <CancelMeetingDialog
        open={!!cancelDialogMeetingId}
        onOpenChange={(open) => { if (!open) setCancelDialogMeetingId(null); }}
        onConfirm={handleCancelConfirm}
        isPending={cancelMeeting.isPending}
      />

      {/* Rename dialog */}
      <Dialog open={!!renameId} onOpenChange={(open) => { if (!open) setRenameId(null); }}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t.upcomingPage.renameMeeting.title}</DialogTitle>
            <DialogDescription className="sr-only">{t.upcomingPage.renameMeeting.description}</DialogDescription>
          </DialogHeader>
          <Input
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); }}
            placeholder={t.upcomingPage.renameMeeting.placeholder}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameId(null)}>{t.upcomingPage.renameMeeting.cancel}</Button>
            <Button onClick={handleRename} disabled={!renameDraft.trim()}>{t.upcomingPage.renameMeeting.save}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
