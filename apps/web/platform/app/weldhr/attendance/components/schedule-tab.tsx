/**
 * Attendance → Schedule: the team's shifts, leave and sickness by day, week or
 * month. Week is the roster (employees down the left, days across), Day is
 * one day by the hour with a column per employee, Month is a calendar grid.
 * The toolbar is WeldCalendar's (filter, period, search, view, create).
 */

import { useMemo, useState, type ReactNode } from 'react';
import { format } from 'date-fns';
import { ChevronLeft, ChevronRight, Plus, Search } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrShift } from '@weldsuite/app-api-client/domains/weldhr';
import { useTimeFormat } from '@/app/weldcalendar/lib/calendar-format';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { FilterPills, type ActiveFilter, type FilterConfig } from '@/components/entity-list';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { useDeleteHrShift, useHrAbsences, useHrEmployees, useHrLeaveRequests, useHrShifts } from '@/hooks/queries/use-weldhr-queries';
import { cn } from '@/lib/utils';
import { errorMessage, shiftIsoDate, todayIso } from '../../components/shared';
import { ShiftDialog } from './shift-dialog';
import { ErrorBanner } from '@weldsuite/ui/components/error-banner';
import {
  ROSTER_VIEWS,
  buildDayStats,
  groupByDepartment,
  passesFilters,
  periodLabel,
  shiftDay,
  shiftHours,
  stepAnchor,
  timeOffOverlaps,
  toTimeOff,
  viewDays,
  type RosterEmployee,
  type RosterView,
  type TimeOff,
} from './schedule-model';
import { ScheduleDayView } from './schedule-day-view';
import { ScheduleMonthView } from './schedule-month-view';
import { ScheduleWeekView } from './schedule-week-view';

/** Sick reports come newest first without a date filter; this many reach back well past the periods people page through. */
const ABSENCE_LIMIT = 200;

/** The collapsing search box from WeldCalendar's toolbar: an icon button that opens into an input. */
function RosterSearchInput({
  open,
  query,
  placeholder,
  toggleLabel,
  onOpenChange,
  onQueryChange,
}: Readonly<{
  open: boolean;
  query: string;
  placeholder: string;
  toggleLabel: string;
  onOpenChange: (open: boolean) => void;
  onQueryChange: (query: string) => void;
}>) {
  return (
    <div className="relative flex items-center">
      <div className={cn('flex items-center transition-all duration-200 ease-out', open ? 'w-36 md:w-48' : 'w-8')}>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-8 w-8 flex-shrink-0 p-0 shadow-none transition-opacity duration-200',
            open && 'pointer-events-none absolute opacity-0',
          )}
          onClick={() => onOpenChange(true)}
          aria-label={toggleLabel}
          tabIndex={open ? -1 : 0}
        >
          <Search className="h-4 w-4" />
        </Button>
        <div
          className={cn(
            'relative transition-all duration-200 ease-out',
            open ? 'w-36 opacity-100 md:w-48' : 'pointer-events-none w-0 opacity-0',
          )}
        >
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder={placeholder}
            aria-label={placeholder}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onBlur={() => !query && onOpenChange(false)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                onQueryChange('');
                onOpenChange(false);
              }
            }}
            ref={(el) => {
              if (el && open) el.focus();
            }}
            className="h-8 w-full rounded-md border border-gray-200 bg-white pl-8 pr-3 text-sm focus:outline-none dark:border-border dark:bg-background"
          />
        </div>
      </div>
    </div>
  );
}

export function ScheduleTab() {
  const t = useTranslations();
  const timeFormat = useTimeFormat();
  const { can } = usePermissions();
  const canCreate = can('attendance:create');
  const canUpdate = can('attendance:update');
  const canDelete = can('attendance:delete');

  const [view, setView] = useState<RosterView>('week');
  const [anchor, setAnchor] = useState(todayIso);
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const days = useMemo(() => viewDays(anchor, view), [anchor, view]);
  const firstDay = days[0]!;
  const lastDay = days[days.length - 1]!;
  const todayInView = days.includes(todayIso());

  // The API filters on UTC days and the grid buckets on local ones, so fetch a
  // day either side and let the grid drop what falls outside the period.
  const {
    data: shifts,
    isLoading: shiftsLoading,
    error,
  } = useHrShifts({ from: shiftIsoDate(firstDay, -1), to: shiftIsoDate(lastDay, 1) });
  const { data: employeesData, isLoading: employeesLoading } = useHrEmployees({
    limit: 200,
    status: 'onboarding,active,on_leave,offboarding',
  });
  // Leave and sickness are drawn next to the shifts for whoever may read them.
  const { data: leaveRequests } = useHrLeaveRequests(
    { status: 'approved,pending', from: firstDay, to: lastDay },
    { enabled: can('leave:read'), keepPreviousData: true },
  );
  const { data: absences } = useHrAbsences({ limit: ABSENCE_LIMIT }, { enabled: can('absences:read') });
  const deleteShift = useDeleteHrShift();

  const [dialog, setDialog] = useState<{ employee?: RosterEmployee; date?: string; shift?: HrShift } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HrShift | null>(null);

  /** Shifts in the visible period that pass the client-account filter. */
  const periodShifts = useMemo(() => {
    const inView = new Set(days);
    return (shifts ?? []).filter(
      (shift) => inView.has(shiftDay(shift)) && passesFilters(activeFilters, 'companyId', shift.companyId ? [shift.companyId] : []),
    );
  }, [shifts, days, activeFilters]);

  /** Shifts per `employeeId|day`, earliest first. */
  const shiftsByCell = useMemo(() => {
    const map = new Map<string, HrShift[]>();
    for (const shift of [...periodShifts].sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
      const key = `${shift.employeeId}|${shiftDay(shift)}`;
      const list = map.get(key) ?? [];
      list.push(shift);
      map.set(key, list);
    }
    return map;
  }, [periodShifts]);

  /** For the day view: shifts from the day before still running after midnight (night shifts), per employee. */
  const overnightShifts = useMemo(() => {
    const map = new Map<string, HrShift[]>();
    if (view !== 'day') return map;
    const previousDay = shiftIsoDate(firstDay, -1);
    const midnight = new Date(`${firstDay}T00:00:00`).getTime();
    for (const shift of shifts ?? []) {
      if (shiftDay(shift) !== previousDay || new Date(shift.endsAt).getTime() <= midnight) continue;
      if (!passesFilters(activeFilters, 'companyId', shift.companyId ? [shift.companyId] : [])) continue;
      const list = map.get(shift.employeeId) ?? [];
      list.push(shift);
      map.set(shift.employeeId, list);
    }
    return map;
  }, [view, shifts, firstDay, activeFilters]);

  const { hoursByEmployee, totalHours } = useMemo(() => {
    const byEmployee = new Map<string, number>();
    let total = 0;
    for (const shift of periodShifts) {
      const hours = shiftHours(shift);
      byEmployee.set(shift.employeeId, (byEmployee.get(shift.employeeId) ?? 0) + hours);
      total += hours;
    }
    return { hoursByEmployee: byEmployee, totalHours: total };
  }, [periodShifts]);

  /** Leave and sickness that touch the period, per employee. */
  const timeOffByEmployee = useMemo(() => {
    const map = new Map<string, TimeOff[]>();
    for (const item of toTimeOff(leaveRequests ?? [], absences?.data ?? [])) {
      if (!timeOffOverlaps(item, firstDay, lastDay)) continue;
      const list = map.get(item.employeeId) ?? [];
      list.push(item);
      map.set(item.employeeId, list);
    }
    return map;
  }, [leaveRequests, absences, firstDay, lastDay]);

  /** Everyone schedulable, plus anyone who has a shift in view but is no longer in that list. */
  const roster = useMemo(() => {
    const map = new Map<string, RosterEmployee>();
    for (const employee of employeesData?.data ?? []) {
      map.set(employee.id, {
        id: employee.id,
        name: employee.displayName,
        avatarUrl: employee.avatarUrl,
        departmentName: employee.departmentName,
        jobTitle: employee.jobTitle,
        clientIds: employee.clients.map((client) => client.companyId),
      });
    }
    for (const shift of periodShifts) {
      if (map.has(shift.employeeId)) continue;
      map.set(shift.employeeId, {
        id: shift.employeeId,
        name: shift.employeeName,
        avatarUrl: null,
        departmentName: null,
        jobTitle: null,
        clientIds: [],
      });
    }
    return [...map.values()];
  }, [employeesData, periodShifts]);

  /** The roster narrowed by the search box and the toolbar filters. */
  const groups = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const scheduled = new Set(periodShifts.map((shift) => shift.employeeId));
    const visible = roster.filter((employee) => {
      if (query && !employee.name.toLowerCase().includes(query)) return false;
      if (!passesFilters(activeFilters, 'employeeId', [employee.id])) return false;
      if (!passesFilters(activeFilters, 'department', employee.departmentName ? [employee.departmentName] : [])) return false;
      // A client filter keeps people assigned to that client, and anyone with a shift that passed it.
      return scheduled.has(employee.id) || passesFilters(activeFilters, 'companyId', employee.clientIds);
    });
    return groupByDepartment(visible);
  }, [roster, periodShifts, activeFilters, searchQuery]);

  const dayStats = useMemo(
    () => buildDayStats(days, groups.flatMap((group) => group.employees), shiftsByCell, timeOffByEmployee),
    [days, groups, shiftsByCell, timeOffByEmployee],
  );

  const filterConfigs = useMemo<FilterConfig[]>(() => {
    const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);
    const departments = [...new Set((employeesData?.data ?? []).map((e) => e.departmentName).filter((name): name is string => Boolean(name)))];
    const clients = new Map<string, string>();
    for (const employee of employeesData?.data ?? []) {
      for (const client of employee.clients) clients.set(client.companyId, client.companyName ?? client.companyId);
    }
    for (const shift of shifts ?? []) {
      if (shift.companyId) clients.set(shift.companyId, shift.companyName ?? shift.companyId);
    }
    return [
      {
        field: 'employeeId',
        label: t('weldhr.attendance.records.filters.employee'),
        searchable: true,
        options: (employeesData?.data ?? []).map((e) => ({ value: e.id, label: e.displayName })).sort(byLabel),
      },
      {
        field: 'department',
        label: t('weldhr.attendance.schedule.filter.department'),
        options: departments.map((name) => ({ value: name, label: name })).sort(byLabel),
      },
      {
        field: 'companyId',
        label: t('weldhr.attendance.records.filters.client'),
        searchable: true,
        options: [...clients.entries()].map(([value, label]) => ({ value, label })).sort(byLabel),
      },
    ];
  }, [employeesData, shifts, t]);

  const viewLabels: Record<RosterView, string> = {
    day: t('weldhr.attendance.schedule.viewDay'),
    week: t('weldhr.attendance.schedule.viewWeek'),
    month: t('weldhr.attendance.schedule.viewMonth'),
  };

  const employeeCount = groups.reduce((sum, group) => sum + group.employees.length, 0);
  const showGroupHeaders = groups.length > 1 || groups[0]?.departmentName != null;
  const firstDate = new Date(`${firstDay}T12:00:00`);
  const title = view === 'day' ? format(firstDate, 'EEEE d MMMM yyyy') : periodLabel(firstDate, new Date(`${lastDay}T12:00:00`));

  function openDay(day: string) {
    setAnchor(day);
    setView('day');
  }

  const addShift = (employee: RosterEmployee, day: string) => setDialog({ employee, date: day });
  const editShift = (shift: HrShift) => setDialog({ shift });

  let scheduleContent: ReactNode;
  if (shiftsLoading || employeesLoading) {
    scheduleContent = <PageLoader fullScreen={false} />;
  } else if (roster.length > 0 && employeeCount === 0) {
    scheduleContent = (
      <div className="flex flex-1 items-center justify-center p-10 text-sm text-muted-foreground">{t('weldhr.common.noResults')}</div>
    );
  } else if (employeeCount === 0) {
    scheduleContent = (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center">
        <p className="text-sm font-medium">{t('weldhr.attendance.schedule.empty.title')}</p>
        <p className="max-w-md text-sm text-muted-foreground">{t('weldhr.attendance.schedule.empty.description')}</p>
        {canCreate && (
          <Button size="sm" className="mt-2 shadow-none" onClick={() => setDialog({ date: todayInView ? todayIso() : firstDay })}>
            {t('weldhr.attendance.schedule.addShift')}
          </Button>
        )}
      </div>
    );
  } else if (view === 'day') {
    scheduleContent = (
      <ScheduleDayView
        day={firstDay}
        groups={groups}
        showGroupHeaders={showGroupHeaders}
        shiftsByCell={shiftsByCell}
        overnightShifts={overnightShifts}
        timeOffByEmployee={timeOffByEmployee}
        timeFormat={timeFormat}
        canCreate={canCreate}
        canUpdate={canUpdate}
        onAddShift={addShift}
        onEditShift={editShift}
      />
    );
  } else if (view === 'month') {
    scheduleContent = <ScheduleMonthView anchor={anchor} dayStats={dayStats} onOpenDay={openDay} />;
  } else {
    scheduleContent = (
      <ScheduleWeekView
        days={days}
        groups={groups}
        showGroupHeaders={showGroupHeaders}
        employeeCount={employeeCount}
        totalHours={totalHours}
        hoursByEmployee={hoursByEmployee}
        shiftsByCell={shiftsByCell}
        timeOffByEmployee={timeOffByEmployee}
        dayStats={dayStats}
        timeFormat={timeFormat}
        canCreate={canCreate}
        canUpdate={canUpdate}
        onAddShift={addShift}
        onEditShift={editShift}
        onOpenDay={openDay}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar: the same row as WeldCalendar's (filter, period, search, view, create) */}
      <div className="z-10 flex shrink-0 items-center justify-between border-b bg-background px-4 py-2.5 max-md:gap-2">
        <div className="flex min-w-0 items-center gap-1 md:gap-2">
          <FilterPills
            filters={activeFilters}
            filterConfigs={filterConfigs}
            maxFilters={3}
            onFiltersChange={setActiveFilters}
            operatorLabels={{ is: t('weldhr.attendance.schedule.filter.is'), 'is not': t('weldhr.attendance.schedule.filter.isNot') }}
            labels={{
              filter: t('weldhr.attendance.schedule.filter.button'),
              selectCondition: t('weldhr.attendance.schedule.filter.selectCondition'),
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => setAnchor(stepAnchor(anchor, view, -1))}
            aria-label={t('weldhr.attendance.schedule.previous')}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => setAnchor(stepAnchor(anchor, view, 1))}
            aria-label={t('weldhr.attendance.schedule.next')}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          {/* One line: shrink + truncate rather than wrap. */}
          <h2 className="ml-1 hidden min-w-0 -translate-y-[1px] truncate whitespace-nowrap text-[18px] font-semibold md:block">{title}</h2>
        </div>

        <div className="flex shrink-0 items-center gap-1 md:gap-2">
          {!todayInView && (
            <Button variant="outline" size="sm" className="shrink-0 shadow-none" onClick={() => setAnchor(todayIso())}>
              {t('weldhr.attendance.schedule.today')}
            </Button>
          )}
          <RosterSearchInput
            open={searchOpen}
            query={searchQuery}
            placeholder={t('weldhr.attendance.schedule.searchPlaceholder')}
            toggleLabel={t('weldhr.attendance.schedule.searchToggle')}
            onOpenChange={setSearchOpen}
            onQueryChange={setSearchQuery}
          />
          <Select value={view} onValueChange={(v) => setView(v as RosterView)}>
            <SelectTrigger size="sm" className="w-[110px] shadow-none md:w-[130px]" aria-label={t('weldhr.attendance.schedule.viewLabel')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROSTER_VIEWS.map((option) => (
                <SelectItem key={option} value={option}>
                  {viewLabels[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {canCreate && (
            <Button
              size="sm"
              className="shadow-none max-md:h-8 max-md:px-2.5"
              onClick={() => setDialog({ date: todayInView ? todayIso() : firstDay })}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t('weldhr.attendance.schedule.addShift')}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className="shrink-0 px-4 pt-3">
          <ErrorBanner error={errorMessage(error, t('weldhr.attendance.schedule.loadFailed'))} />
        </div>
      )}

      {scheduleContent}

      {dialog && (
        <ShiftDialog
          defaultEmployeeId={dialog.employee?.id}
          defaultEmployeeName={dialog.employee?.name}
          defaultWorkType={dialog.employee?.jobTitle}
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
