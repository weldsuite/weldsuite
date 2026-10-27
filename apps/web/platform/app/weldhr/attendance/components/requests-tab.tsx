/**
 * Attendance → Requests: shifts employees asked to work from the WeldHR app.
 * Pending ones are the review queue (soonest first); the ones answered in the
 * last 30 days sit below it with their outcome. Approving puts the shift on
 * the schedule, declining asks for an optional note the employee sees.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrShiftRequest } from '@weldsuite/app-api-client/domains/weldhr';
import { PanelEntityList, type ColumnDef, type GroupConfig } from '@/components/panel-entity-list';
import { formatClockRange, useTimeFormat } from '@/app/weldcalendar/lib/calendar-format';
import { useHrShiftRequests, useReviewHrShiftRequest } from '@/hooks/queries/use-weldhr-queries';
import { cn } from '@/lib/utils';
import { HR_COL, HrListContainer } from '../../components/page-kit';
import { StatusBadge, errorMessage, formatDateTime, formatMinutes, shiftIsoDate, todayIso } from '../../components/shared';
import { ShiftRequestDeclineDialog } from './shift-request-decline-dialog';
import { ShiftRequestsEmptyIllustration } from './shift-requests-empty-illustration';

/** How far back the "recently reviewed" group reaches, counted from the day the shift starts. */
const REVIEWED_DAYS = 30;

/** "Mon, 27 Oct" for the day a shift starts, in the viewer's locale. */
function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function lengthMinutes(request: HrShiftRequest): number {
  return Math.max(0, Math.round((new Date(request.endsAt).getTime() - new Date(request.startsAt).getTime()) / 60_000));
}

export function RequestsTab() {
  const t = useTranslations();
  const { can } = usePermissions();
  // Approving creates a shift, so it takes the same permission as adding one on the schedule.
  const canReview = can('attendance:create');
  const timeFormat = useTimeFormat();

  const {
    data: pending,
    isLoading: pendingLoading,
    error: pendingError,
    refetch: refetchPending,
  } = useHrShiftRequests({ status: 'pending' });
  const {
    data: reviewed,
    isLoading: reviewedLoading,
    error: reviewedError,
    refetch: refetchReviewed,
  } = useHrShiftRequests({ status: 'approved,rejected', from: shiftIsoDate(todayIso(), -REVIEWED_DAYS) });

  const reviewRequest = useReviewHrShiftRequest();
  const reviewingId = reviewRequest.isPending ? reviewRequest.variables?.id : undefined;
  const [declineId, setDeclineId] = useState<string | null>(null);
  const declineTarget = declineId ? pending?.find((r) => r.id === declineId) : undefined;

  // The queue is worked from the soonest shift; the server's newest-first order
  // suits the history below it.
  const items = [
    ...[...(pending ?? [])].sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()),
    ...(reviewed ?? []),
  ];

  function timeRange(r: HrShiftRequest): string {
    return formatClockRange(new Date(r.startsAt), new Date(r.endsAt), timeFormat);
  }

  /** Resolves true when the request was answered; a failure is shown here, with the server's reason. */
  async function review(request: HrShiftRequest, decision: 'approved' | 'rejected', note: string | null = null): Promise<boolean> {
    try {
      await reviewRequest.mutateAsync({ id: request.id, decision, note });
      if (decision === 'approved') toast.success(t('weldhr.attendance.requests.approvedToast'));
      return true;
    } catch (err) {
      toast.error(errorMessage(err, t('weldhr.attendance.requests.reviewFailed')));
      // A 409 means the request was answered elsewhere in the meantime: show what is true now.
      void Promise.all([refetchPending(), refetchReviewed()]);
      return false;
    }
  }

  const groups: GroupConfig<HrShiftRequest>[] = [
    { id: 'pending', label: t('weldhr.attendance.requests.groups.pending'), sortOrder: 1, filter: (r) => r.status === 'pending' },
    { id: 'reviewed', label: t('weldhr.attendance.requests.groups.reviewed'), sortOrder: 2, filter: (r) => r.status !== 'pending' },
  ];

  const columns: ColumnDef<HrShiftRequest>[] = [
    {
      id: 'employee',
      header: t('weldhr.attendance.requests.table.employee'),
      width: HR_COL.main,
      render: (r) => (
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate font-medium">{r.employeeName}</p>
            {/* A sign-up for a posted open shift, not a shift the employee proposed. */}
            {r.openShiftId && (
              <Badge variant="outline" className="shrink-0">
                {t('weldhr.attendance.requests.openShiftBadge')}
              </Badge>
            )}
          </div>
          {/* What the hidden columns would show, once the list is too narrow for them. */}
          <p className="truncate text-xs text-muted-foreground @4xl:hidden">
            {dayLabel(r.startsAt)} · {timeRange(r)} · {formatMinutes(lengthMinutes(r))}
            {r.workType && <> · {r.workType}</>}
          </p>
          {r.note && <p className="truncate text-xs text-muted-foreground @7xl:hidden">{r.note}</p>}
          {r.status !== 'pending' && (
            <div className="mt-1 @lg:hidden">
              <StatusBadge group="shiftRequest" status={r.status} />
            </div>
          )}
        </div>
      ),
    },
    {
      id: 'day',
      header: t('weldhr.attendance.requests.table.day'),
      width: cn(HR_COL.fixed, HR_COL.hideLg, 'w-[96px]'),
      render: (r) => <span className="block truncate tabular-nums">{dayLabel(r.startsAt)}</span>,
    },
    {
      id: 'time',
      header: t('weldhr.attendance.requests.table.time'),
      width: cn(HR_COL.fixed, HR_COL.hideLg, 'w-[150px]'),
      render: (r) => <span className="block truncate tabular-nums">{timeRange(r)}</span>,
    },
    {
      id: 'length',
      header: t('weldhr.attendance.requests.table.length'),
      width: cn(HR_COL.fixed, HR_COL.hideLg, 'w-[64px]'),
      render: (r) => <span className="block truncate tabular-nums">{formatMinutes(lengthMinutes(r))}</span>,
    },
    {
      id: 'workType',
      header: t('weldhr.attendance.requests.table.workType'),
      width: cn(HR_COL.fixed, HR_COL.hideXl, 'w-[110px]'),
      render: (r) => <span className="block truncate text-muted-foreground">{r.workType ?? '—'}</span>,
    },
    {
      id: 'requested',
      header: t('weldhr.attendance.requests.table.requested'),
      width: cn(HR_COL.fixed, 'hidden @6xl:block w-[104px]'),
      render: (r) => <span className="block truncate tabular-nums text-muted-foreground">{formatDateTime(r.createdAt)}</span>,
    },
    {
      id: 'note',
      header: t('weldhr.attendance.requests.table.note'),
      width: cn(HR_COL.fixed, 'hidden @7xl:block w-[130px]'),
      render: (r) => <span className="block truncate text-muted-foreground">{r.note ?? '—'}</span>,
    },
    {
      id: 'status',
      header: t('weldhr.attendance.requests.table.status'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[96px]'),
      render: (r) => (
        // Who answered, and with which note, on hover.
        <span
          className="inline-block"
          title={[r.reviewedByName ? `${t('weldhr.attendance.requests.table.reviewer')}: ${r.reviewedByName}` : null, r.reviewNote]
            .filter(Boolean)
            .join(' — ') || undefined}
        >
          <StatusBadge group="shiftRequest" status={r.status} />
        </span>
      ),
    },
    {
      id: 'actions',
      header: '',
      // Narrow: the buttons wrap onto two lines rather than run under the other columns.
      width: cn(HR_COL.fixed, 'w-[84px] @2xl:w-[150px]'),
      render: (r) => (
        <div className="flex flex-wrap justify-end gap-1.5">
          {canReview && r.status === 'pending' && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                disabled={reviewRequest.isPending}
                onClick={() => void review(r, 'approved')}
              >
                {reviewingId === r.id && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                {t('weldhr.attendance.requests.approve')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                disabled={reviewRequest.isPending}
                onClick={() => setDeclineId(r.id)}
              >
                {t('weldhr.attendance.requests.decline')}
              </Button>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <HrListContainer>
        <PanelEntityList<HrShiftRequest>
          items={items}
          isLoading={pendingLoading || reviewedLoading}
          error={pendingError ?? reviewedError}
          columns={columns}
          groups={groups}
          filters={[]}
          emptyState={{
            icon: <ShiftRequestsEmptyIllustration />,
            title: t('weldhr.attendance.requests.empty.title'),
            description: t('weldhr.attendance.requests.empty.description'),
          }}
        />
      </HrListContainer>

      {declineTarget && (
        <ShiftRequestDeclineDialog
          request={declineTarget}
          summary={`${dayLabel(declineTarget.startsAt)} · ${timeRange(declineTarget)}`}
          onConfirm={(note) => review(declineTarget, 'rejected', note)}
          onClose={() => setDeclineId(null)}
        />
      )}
    </>
  );
}
