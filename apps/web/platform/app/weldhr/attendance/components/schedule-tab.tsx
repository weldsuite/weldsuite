/** Attendance → Schedule: a Mon–Sun week view of shifts. */

import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrShift } from '@weldsuite/app-api-client/domains/weldhr';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useDeleteHrShift, useHrShifts } from '@/hooks/queries/use-weldhr-queries';
import { EmptyState, ErrorBanner, InlineSpinner, errorMessage, formatTime, shiftIsoDate, todayIso } from '../../components/shared';
import { ShiftDialog } from './shift-dialog';

function mondayOf(dateIso: string): string {
  const d = new Date(`${dateIso}T12:00:00`);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function ScheduleTab() {
  const t = useTranslations();
  const { can } = usePermissions();
  const canCreate = can('attendance:create');
  const canUpdate = can('attendance:update');
  const canDelete = can('attendance:delete');

  const [weekStart, setWeekStart] = useState(() => mondayOf(todayIso()));
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => shiftIsoDate(weekStart, i)), [weekStart]);
  const weekEnd = days[6]!;

  const { data: shifts, isLoading, error } = useHrShifts({ from: weekStart, to: weekEnd });
  const deleteShift = useDeleteHrShift();

  const [dialog, setDialog] = useState<{ employeeId?: string | null; date?: string; shift?: HrShift } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HrShift | null>(null);

  const employees = useMemo(() => {
    const map = new Map<string, string>();
    for (const shift of shifts ?? []) map.set(shift.employeeId, shift.employeeName);
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [shifts]);

  function shiftsFor(employeeId: string, date: string) {
    return (shifts ?? []).filter((s) => s.employeeId === employeeId && s.startsAt.slice(0, 10) === date);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setWeekStart(shiftIsoDate(weekStart, -7))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setWeekStart(mondayOf(todayIso()))}>
            {t('weldhr.attendance.schedule.thisWeek')}
          </Button>
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setWeekStart(shiftIsoDate(weekStart, 7))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <span className="ml-2 text-sm text-muted-foreground">
            {weekStart} – {weekEnd}
          </span>
        </div>
        {canCreate && (
          <Button size="sm" onClick={() => setDialog({ date: weekStart })}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t('weldhr.attendance.schedule.addShift')}
          </Button>
        )}
      </div>

      <ErrorBanner error={error ? errorMessage(error, t('weldhr.attendance.schedule.loadFailed')) : null} />

      {isLoading ? (
        <InlineSpinner />
      ) : employees.length === 0 ? (
        <EmptyState
          title={t('weldhr.attendance.schedule.empty.title')}
          description={t('weldhr.attendance.schedule.empty.description')}
          action={canCreate ? <Button onClick={() => setDialog({ date: weekStart })}>{t('weldhr.attendance.schedule.addShift')}</Button> : undefined}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[840px] border-collapse text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="w-40 px-3 py-2 text-left font-medium">{t('weldhr.attendance.records.table.employee')}</th>
                {days.map((date) => (
                  <th key={date} className="px-2 py-2 text-left font-medium">
                    {new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {employees.map(([employeeId, employeeName]) => (
                <tr key={employeeId} className="border-b last:border-0">
                  <td className="px-3 py-2 align-top font-medium">{employeeName}</td>
                  {days.map((date) => (
                    <td
                      key={date}
                      className="cursor-pointer px-2 py-2 align-top hover:bg-muted/30"
                      onClick={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (canCreate) setDialog({ employeeId, date });
                      }}
                    >
                      <div className="space-y-1">
                        {shiftsFor(employeeId, date).map((shift) => (
                          <button
                            key={shift.id}
                            onClick={() => (canUpdate ? setDialog({ shift }) : undefined)}
                            className="block w-full rounded-md border bg-card px-1.5 py-1 text-left text-xs shadow-sm hover:border-primary"
                          >
                            <div className="font-medium">
                              {formatTime(shift.startsAt)}–{formatTime(shift.endsAt)}
                            </div>
                            {shift.companyName && <div className="truncate text-muted-foreground">{shift.companyName}</div>}
                          </button>
                        ))}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog && (
        <ShiftDialog
          defaultEmployeeId={dialog.employeeId}
          defaultDate={dialog.date}
          shift={dialog.shift}
          onClose={() => setDialog(null)}
          onDelete={
            canDelete && dialog.shift
              ? () => {
                  setDeleteTarget(dialog.shift!);
                }
              : undefined
          }
        />
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('weldhr.attendance.schedule.deleteConfirmTitle')}
        description={t('weldhr.attendance.schedule.deleteConfirmDescription')}
        variant="destructive"
        onConfirm={async () => {
          if (!deleteTarget) return;
          await deleteShift.mutateAsync(deleteTarget.id);
          setDeleteTarget(null);
          setDialog(null);
        }}
      />
    </div>
  );
}
