/**
 * WeldHR shift object panel: a shift from Attendance → Schedule with who works
 * it, when, the break, type of work, client account and notes, and Edit and
 * Delete in its menu.
 *
 * There is no endpoint for one shift, so the panel reads the shift from the
 * schedule's loaded periods (`useLoadedHrShift`); it opens from a shift card.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import {
  Briefcase,
  Building2,
  CalendarDays,
  Clock,
  Coffee,
  EllipsisVertical,
  FileText,
  LayoutGrid,
  Pencil,
  Timer,
  Trash2,
  User,
} from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import {
  ObjectPanelTabs,
  useObjectPanel,
  useObjectPanelShell,
  type ObjectPanelComponentProps,
} from '@/components/object-panel';
import { HR_EMPLOYEE_PANEL_TYPE } from '@/components/objects/hr-employee/hr-employee-tabs';
import { PanelRow, RecordLoadFailed } from '@/components/objects/_shared/record-panel-parts';
import { tabBodyClassName } from '@/components/objects/_shared/tab-empty-state';
import { useDeleteHrShift, useLoadedHrShift } from '@/hooks/queries/use-weldhr-queries';
import { formatClockRange, useTimeFormat } from '@/app/weldcalendar/lib/calendar-format';
import { errorMessage, formatDate } from '@/app/weldhr/components/shared';
import { formatHours, shiftColor, shiftDay, shiftHours } from '@/app/weldhr/attendance/components/schedule-model';
import { ShiftDialog } from '@/app/weldhr/attendance/components/shift-dialog';

const HR_SHIFT_PANEL_WIDTH = 400;

export function HrShiftPanel(props: Readonly<ObjectPanelComponentProps>) {
  const t = useTranslations();
  const timeFormat = useTimeFormat();
  const { can } = usePermissions();
  const { open } = useObjectPanel();
  const shift = useLoadedHrShift(props.id);
  const deleteShift = useDeleteHrShift();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const canUpdate = can('attendance:update');
  const canDelete = can('attendance:delete');
  const shell = useObjectPanelShell({ ...props, width: HR_SHIFT_PANEL_WIDTH, loading: shift === undefined });
  const detailsTab = { id: 'overview', label: t('sweep.entities.detailsTab'), icon: LayoutGrid };

  async function confirmDelete() {
    if (!shift) return;
    try {
      await deleteShift.mutateAsync(shift.id);
      setConfirmingDelete(false);
      setEditing(false);
      props.onClose();
    } catch (err) {
      toast.error(errorMessage(err, t('weldhr.attendance.schedule.deleteFailed')));
    }
  }

  const breakRange =
    shift?.breakStartsAt && shift.breakEndsAt
      ? formatClockRange(new Date(shift.breakStartsAt), new Date(shift.breakEndsAt), timeFormat)
      : null;

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      contentClassName={tabBodyClassName(shell.mode)}
      title={
        shift ? (
          <div className="flex min-w-0 items-center gap-2">
            {/* The shift card's colour (per client account). */}
            <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: shiftColor(shift) }} aria-hidden />
            <span className="relative top-px truncate text-[15px] font-medium text-foreground">
              {shift.workType ?? t('weldhr.attendance.schedule.panel.title')}
            </span>
          </div>
        ) : (
          <div className="h-4 w-32 animate-pulse rounded bg-muted" />
        )
      }
      actions={
        shift && (canUpdate || canDelete) ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7 data-[state=open]:bg-accent dark:data-[state=open]:bg-accent/50"
                aria-label={t('sweep.entities.moreActions')}
              >
                <EllipsisVertical className="h-4 w-4 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canUpdate && (
                <DropdownMenuItem onClick={() => setEditing(true)}>
                  <Pencil />
                  {t('weldhr.attendance.schedule.editShift')}
                </DropdownMenuItem>
              )}
              {canUpdate && canDelete && <DropdownMenuSeparator />}
              {canDelete && (
                <DropdownMenuItem variant="destructive" onClick={() => setConfirmingDelete(true)}>
                  <Trash2 />
                  {t('weldhr.attendance.schedule.deleteShift')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null
      }
      tabs={<ObjectPanelTabs tabs={[detailsTab]} activeTab={detailsTab.id} onChange={() => {}} />}
    >
      {shift === null && (
        <RecordLoadFailed notFound message={t('weldhr.attendance.schedule.panel.notFound')} retryLabel="" onRetry={() => {}} />
      )}

      {shift && (
        <div className="space-y-1 p-4">
          <PanelRow
            icon={User}
            label={t('weldhr.attendance.schedule.form.employee')}
            value={shift.employeeName}
            renderValue={(name) => (
              <button
                type="button"
                className="max-w-full truncate text-left text-primary hover:underline"
                onClick={() => open({ type: HR_EMPLOYEE_PANEL_TYPE, id: shift.employeeId, stack: true })}
              >
                {name}
              </button>
            )}
          />
          <PanelRow icon={CalendarDays} label={t('weldhr.attendance.schedule.form.date')} value={formatDate(shiftDay(shift))} tabular />
          <PanelRow
            icon={Clock}
            label={t('weldhr.attendance.schedule.panel.time')}
            value={formatClockRange(new Date(shift.startsAt), new Date(shift.endsAt), timeFormat)}
            tabular
          />
          <PanelRow icon={Coffee} label={t('weldhr.attendance.schedule.panel.break')} value={breakRange} tabular />
          <PanelRow
            icon={Timer}
            label={t('weldhr.attendance.schedule.panel.plannedHours')}
            value={t('weldhr.attendance.schedule.hours', { hours: formatHours(shiftHours(shift)) })}
            tabular
          />
          <PanelRow icon={Briefcase} label={t('weldhr.attendance.schedule.form.workType')} value={shift.workType} />
          <PanelRow icon={Building2} label={t('weldhr.attendance.schedule.form.client')} value={shift.companyName} />
          <PanelRow icon={FileText} label={t('weldhr.attendance.schedule.form.notes')} value={shift.notes} />
        </div>
      )}

      {editing && shift && (
        <ShiftDialog
          shift={shift}
          onClose={() => setEditing(false)}
          onDelete={canDelete ? () => setConfirmingDelete(true) : undefined}
          deleting={deleteShift.isPending}
        />
      )}

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={(next) => !next && setConfirmingDelete(false)}
        title={t('weldhr.attendance.schedule.deleteConfirmTitle')}
        description={t('weldhr.attendance.schedule.deleteConfirmDescription')}
        variant="destructive"
        onConfirm={confirmDelete}
      />
    </EntityDetailView>
  );
}
