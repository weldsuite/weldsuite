/**
 * Attendance → Open shifts: shifts posted for employees who want to work them.
 * Employees sign up from My HR or the WeldHR app; the sign-ups arrive in the
 * Requests tab, where a manager decides who gets the shift.
 */

import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import { CalendarPlus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrOpenShift } from '@weldsuite/app-api-client/domains/weldhr';
import { PanelEntityList, type ColumnDef, type GroupConfig } from '@/components/panel-entity-list';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { formatClockRange, useTimeFormat } from '@/app/weldcalendar/lib/calendar-format';
import { useCancelHrOpenShift, useHrOpenShifts } from '@/hooks/queries/use-weldhr-queries';
import { cn } from '@/lib/utils';
import { HR_COL, HrListContainer, emptyIcon } from '../../components/page-kit';
import { StatusBadge, errorMessage, todayIso } from '../../components/shared';
import { OpenShiftDialog } from './open-shift-dialog';

/** "Mon, 27 Oct" for the day a shift starts, in the viewer's locale. */
function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** What the status chip shows: withdrawn, full (no spot left) or still open. */
function displayStatus(shift: HrOpenShift): 'open' | 'full' | 'cancelled' {
  if (shift.status === 'cancelled') return 'cancelled';
  return shift.spotsLeft === 0 ? 'full' : 'open';
}

export function OpenShiftsTab() {
  const t = useTranslations();
  const { can } = usePermissions();
  const canCreate = can('attendance:create');
  const canUpdate = can('attendance:update');
  const canWithdraw = can('attendance:delete');
  const timeFormat = useTimeFormat();

  const { data, isLoading, error } = useHrOpenShifts({ from: todayIso() });
  const withdraw = useCancelHrOpenShift();
  const [dialogState, setDialogState] = useState<'create' | HrOpenShift | null>(null);
  const [withdrawTarget, setWithdrawTarget] = useState<HrOpenShift | null>(null);

  function timeRange(shift: HrOpenShift): string {
    return formatClockRange(new Date(shift.startsAt), new Date(shift.endsAt), timeFormat);
  }

  const groups: GroupConfig<HrOpenShift>[] = [
    { id: 'open', label: t('weldhr.attendance.openShifts.groups.open'), sortOrder: 1, filter: (s) => s.status === 'open' },
    { id: 'cancelled', label: t('weldhr.attendance.openShifts.groups.cancelled'), sortOrder: 2, filter: (s) => s.status === 'cancelled' },
  ];

  const columns: ColumnDef<HrOpenShift>[] = [
    {
      id: 'shift',
      header: t('weldhr.attendance.openShifts.table.shift'),
      width: HR_COL.main,
      render: (s) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{s.workType ?? dayLabel(s.startsAt)}</p>
          {/* What the hidden columns would show, once the list is too narrow for them. */}
          <p className="truncate text-xs text-muted-foreground @4xl:hidden">
            {dayLabel(s.startsAt)} · {timeRange(s)}
            {s.companyName && <> · {s.companyName}</>}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 @lg:hidden">
            <StatusBadge group="openShift" status={displayStatus(s)} />
          </div>
        </div>
      ),
    },
    {
      id: 'day',
      header: t('weldhr.attendance.openShifts.table.day'),
      width: cn(HR_COL.fixed, HR_COL.hideLg, 'w-[96px]'),
      render: (s) => <span className="block truncate tabular-nums">{dayLabel(s.startsAt)}</span>,
    },
    {
      id: 'time',
      header: t('weldhr.attendance.openShifts.table.time'),
      width: cn(HR_COL.fixed, HR_COL.hideLg, 'w-[150px]'),
      render: (s) => <span className="block truncate tabular-nums">{timeRange(s)}</span>,
    },
    {
      id: 'client',
      header: t('weldhr.attendance.openShifts.table.client'),
      width: cn(HR_COL.fixed, HR_COL.hideXl, 'w-[120px]'),
      render: (s) => <span className="block truncate text-muted-foreground">{s.companyName ?? '—'}</span>,
    },
    {
      id: 'department',
      header: t('weldhr.attendance.openShifts.table.department'),
      width: cn(HR_COL.fixed, HR_COL.hideXl, 'w-[120px]'),
      render: (s) => <span className="block truncate text-muted-foreground">{s.departmentName ?? t('weldhr.attendance.openShifts.everyone')}</span>,
    },
    {
      id: 'spots',
      header: t('weldhr.attendance.openShifts.table.spots'),
      width: cn(HR_COL.fixed, HR_COL.hideMd, 'w-[120px]'),
      render: (s) => (
        <div className="min-w-0">
          <span className="block truncate tabular-nums">
            {t('weldhr.attendance.openShifts.spotsFilled', { filled: s.filled, spots: s.spots })}
          </span>
        </div>
      ),
    },
    {
      id: 'signUps',
      header: t('weldhr.attendance.openShifts.table.signUps'),
      width: cn(HR_COL.fixed, HR_COL.hideMd, 'w-[110px]'),
      render: (s) =>
        s.pending > 0 ? (
          <Link
            to="/weldhr/attendance"
            search={{ tab: 'requests' }}
            title={t('weldhr.attendance.openShifts.reviewSignUps')}
            className="block truncate text-sm text-primary underline-offset-2 hover:underline"
          >
            {t('weldhr.attendance.openShifts.waiting', { count: s.pending })}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'status',
      header: t('weldhr.attendance.openShifts.table.status'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[96px]'),
      render: (s) => <StatusBadge group="openShift" status={displayStatus(s)} />,
    },
    {
      id: 'actions',
      header: '',
      width: cn(HR_COL.fixed, 'w-[84px]'),
      render: (s) => (
        <div className="flex justify-end">
          {canWithdraw && s.status === 'open' && (
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setWithdrawTarget(s)}>
              {t('weldhr.attendance.openShifts.withdraw')}
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <HrListContainer>
        <PanelEntityList<HrOpenShift>
          items={data ?? []}
          isLoading={isLoading}
          error={error}
          columns={columns}
          groups={groups}
          filters={[]}
          // A withdrawn shift is history; the server refuses to change it.
          onEdit={canUpdate ? (s) => (s.status === 'open' ? setDialogState(s) : undefined) : undefined}
          createButton={canCreate ? { label: t('weldhr.attendance.openShifts.add'), onClick: () => setDialogState('create') } : undefined}
          emptyState={{
            icon: emptyIcon(CalendarPlus),
            title: t('weldhr.attendance.openShifts.empty.title'),
            description: t('weldhr.attendance.openShifts.empty.description'),
            action: canCreate ? { label: t('weldhr.attendance.openShifts.add'), onClick: () => setDialogState('create') } : undefined,
          }}
        />
      </HrListContainer>

      {dialogState && <OpenShiftDialog shift={dialogState === 'create' ? undefined : dialogState} onClose={() => setDialogState(null)} />}

      <ConfirmDialog
        open={Boolean(withdrawTarget)}
        onOpenChange={(open) => !open && setWithdrawTarget(null)}
        title={t('weldhr.attendance.openShifts.withdrawTitle')}
        description={
          withdrawTarget && withdrawTarget.pending > 0
            ? t('weldhr.attendance.openShifts.withdrawDescriptionPending', { count: withdrawTarget.pending })
            : t('weldhr.attendance.openShifts.withdrawDescription')
        }
        confirmLabel={t('weldhr.attendance.openShifts.withdraw')}
        cancelLabel={t('weldhr.common.cancel')}
        variant="destructive"
        onConfirm={async () => {
          if (!withdrawTarget) return;
          try {
            await withdraw.mutateAsync(withdrawTarget.id);
            setWithdrawTarget(null);
          } catch (err) {
            toast.error(errorMessage(err, t('weldhr.attendance.openShifts.withdrawFailed')));
          }
        }}
      />
    </>
  );
}
