/**
 * Attendance → Schedule: a roster by day, week or month. Employees run down
 * the left, the days across the top, and each cell holds that person's shifts
 * for the day. The toolbar is WeldCalendar's (filter, period, search, view,
 * create) and the day header and shift blocks follow its look.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { addDays, addMonths, format, getDaysInMonth, isToday, startOfMonth } from 'date-fns';
import { ChevronLeft, ChevronRight, Plus, Search } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrShift } from '@weldsuite/app-api-client/domains/weldhr';
import { HEADER_HEIGHT, TODAY_BG_CLASS, TODAY_BLUE } from '@/app/weldcalendar/components/calendar-shared';
import { formatClockRange, useTimeFormat, type TimeFormat } from '@/app/weldcalendar/lib/calendar-format';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FilterPills, type ActiveFilter, type FilterConfig } from '@/components/entity-list';
import { PageLoader } from '@/components/page-loader';
import { useDeleteHrShift, useHrEmployees, useHrShifts } from '@/hooks/queries/use-weldhr-queries';
import { cn } from '@/lib/utils';
import { EmployeeAvatar, ErrorBanner, errorMessage, shiftIsoDate, todayIso } from '../../components/shared';
import { ShiftDialog } from './shift-dialog';

/** Width of the leading employee column. */
const EMPLOYEE_COLUMN_WIDTH = 232;
const DAY_COLUMN_MIN_WIDTH = 140;

/** Shifts without a client account use WeldCalendar's default blue. */
const DEFAULT_SHIFT_COLOR = '#3b82f6';
/** WeldCalendar's calendar palette (minus the default blue), one colour per client account. */
const CLIENT_SHIFT_COLORS = ['#22c55e', '#14b8a6', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4', '#f97316', '#6366f1', '#ef4444'];

type RosterView = 'day' | 'week' | 'month';
const ROSTER_VIEWS: RosterView[] = ['day', 'week', 'month'];

interface RosterEmployee {
  id: string;
  name: string;
  avatarUrl: string | null;
  departmentName: string | null;
  jobTitle: string | null;
  /** Client accounts this employee is assigned to. */
  clientIds: string[];
}

interface RosterGroup {
  /** `null` is the "no department" group. */
  departmentName: string | null;
  employees: RosterEmployee[];
}

function mondayOf(dateIso: string): string {
  const d = new Date(`${dateIso}T12:00:00`);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return format(d, 'yyyy-MM-dd');
}

/** The days a view shows around `anchor`: that day, its Mon–Sun week, or its calendar month. */
function viewDays(anchor: string, view: RosterView): string[] {
  if (view === 'day') return [anchor];
  if (view === 'week') {
    const monday = mondayOf(anchor);
    return Array.from({ length: 7 }, (_, i) => shiftIsoDate(monday, i));
  }
  const first = startOfMonth(new Date(`${anchor}T12:00:00`));
  return Array.from({ length: getDaysInMonth(first) }, (_, i) => format(addDays(first, i), 'yyyy-MM-dd'));
}

/** `anchor` moved one period back or forward. */
function stepAnchor(anchor: string, view: RosterView, direction: 1 | -1): string {
  if (view === 'day') return shiftIsoDate(anchor, direction);
  if (view === 'week') return shiftIsoDate(anchor, 7 * direction);
  return format(addMonths(startOfMonth(new Date(`${anchor}T12:00:00`)), direction), 'yyyy-MM-dd');
}

/** Whether `values` satisfy every completed "is" / "is not" filter on `field`. */
function passesFilters(filters: ActiveFilter[], field: string, values: string[]): boolean {
  return filters
    .filter((f) => f.field === field && f.operator && f.value)
    .every((f) => (f.operator === 'is not' ? !values.includes(f.value) : values.includes(f.value)));
}

/** The local calendar day a shift starts on (`startsAt` is a UTC instant). */
function shiftDay(shift: HrShift): string {
  return format(new Date(shift.startsAt), 'yyyy-MM-dd');
}

/** Planned hours: the shift's length minus its (unpaid) break. */
function shiftHours(shift: HrShift): number {
  const length = new Date(shift.endsAt).getTime() - new Date(shift.startsAt).getTime();
  const pause =
    shift.breakStartsAt && shift.breakEndsAt ? new Date(shift.breakEndsAt).getTime() - new Date(shift.breakStartsAt).getTime() : 0;
  return Math.max(0, (length - Math.max(0, pause)) / 3_600_000);
}

/** 29 → "29", 111.5 → "111.5". */
function formatHours(hours: number): string {
  return String(Math.round(hours * 10) / 10);
}

function shiftColor(shift: HrShift): string {
  if (!shift.companyId) return DEFAULT_SHIFT_COLOR;
  let hash = 0;
  for (const char of shift.companyId) hash = (hash * 31 + char.charCodeAt(0)) % 9973;
  return CLIENT_SHIFT_COLORS[hash % CLIENT_SHIFT_COLORS.length]!;
}

/** "October 2026", or "Sep – Oct 2026" for a week that straddles two months (same as WeldCalendar's header). */
function periodLabel(start: Date, end: Date): string {
  if (start.getMonth() === end.getMonth()) return format(start, 'MMMM yyyy');
  const yearLabel = start.getFullYear() === end.getFullYear() ? format(end, 'yyyy') : `${format(start, 'yyyy')} – ${format(end, 'yyyy')}`;
  return `${format(start, 'MMM')} – ${format(end, 'MMM')} ${yearLabel}`;
}

/** Split the roster into departments; a single unnamed group when nobody has one. */
function groupByDepartment(employees: RosterEmployee[]): RosterGroup[] {
  const byName = (a: RosterEmployee, b: RosterEmployee) => a.name.localeCompare(b.name);
  if (!employees.some((e) => e.departmentName)) return [{ departmentName: null, employees: [...employees].sort(byName) }];
  const map = new Map<string | null, RosterEmployee[]>();
  for (const employee of employees) {
    const list = map.get(employee.departmentName) ?? [];
    list.push(employee);
    map.set(employee.departmentName, list);
  }
  return [...map.entries()]
    .sort(([a], [b]) => {
      if (a === null) return 1;
      if (b === null) return -1;
      return a.localeCompare(b);
    })
    .map(([departmentName, list]) => ({ departmentName, employees: list.sort(byName) }));
}

/** A shift in WeldCalendar's event style: hours, then type of work, client account, break and notes. */
function ShiftBlock({
  shift,
  timeFormat,
  onClick,
}: Readonly<{ shift: HrShift; timeFormat: TimeFormat; onClick?: () => void }>) {
  const t = useTranslations();
  const breakRange =
    shift.breakStartsAt && shift.breakEndsAt
      ? formatClockRange(new Date(shift.breakStartsAt), new Date(shift.breakEndsAt), timeFormat)
      : null;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="block w-full shrink-0 rounded-[6px] border border-white/10 px-2.5 py-1.5 text-left text-[12px] leading-tight text-white transition-[filter] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:brightness-100"
      style={{ backgroundColor: shiftColor(shift) }}
    >
      <span className="block truncate font-semibold">
        {formatClockRange(new Date(shift.startsAt), new Date(shift.endsAt), timeFormat)}
      </span>
      {shift.workType && <span className="mt-[3px] block truncate">{shift.workType}</span>}
      {shift.companyName && <span className="mt-[3px] block truncate text-white/70">{shift.companyName}</span>}
      {breakRange && (
        <span className="mt-[3px] block truncate text-white/70">{t('weldhr.attendance.schedule.break', { range: breakRange })}</span>
      )}
      {shift.notes && <span className="mt-[3px] block truncate text-white/70">{shift.notes}</span>}
    </button>
  );
}

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
  const dayDates = useMemo(() => days.map((day) => new Date(`${day}T12:00:00`)), [days]);
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
  const deleteShift = useDeleteHrShift();

  const [dialog, setDialog] = useState<{ employee?: RosterEmployee; date?: string; shift?: HrShift } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HrShift | null>(null);

  /** Shifts in the visible period that pass the client-account filter. */
  const weekShifts = useMemo(() => {
    const inView = new Set(days);
    return (shifts ?? []).filter(
      (shift) => inView.has(shiftDay(shift)) && passesFilters(activeFilters, 'companyId', shift.companyId ? [shift.companyId] : []),
    );
  }, [shifts, days, activeFilters]);

  /** Shifts per `employeeId|day`, earliest first. */
  const shiftsByCell = useMemo(() => {
    const map = new Map<string, HrShift[]>();
    for (const shift of [...weekShifts].sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
      const key = `${shift.employeeId}|${shiftDay(shift)}`;
      const list = map.get(key) ?? [];
      list.push(shift);
      map.set(key, list);
    }
    return map;
  }, [weekShifts]);

  const { hoursByEmployee, hoursByDay, totalHours } = useMemo(() => {
    const byEmployee = new Map<string, number>();
    const byDay = new Map<string, number>();
    let total = 0;
    for (const shift of weekShifts) {
      const hours = shiftHours(shift);
      byEmployee.set(shift.employeeId, (byEmployee.get(shift.employeeId) ?? 0) + hours);
      byDay.set(shiftDay(shift), (byDay.get(shiftDay(shift)) ?? 0) + hours);
      total += hours;
    }
    return { hoursByEmployee: byEmployee, hoursByDay: byDay, totalHours: total };
  }, [weekShifts]);

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
    for (const shift of weekShifts) {
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
  }, [employeesData, weekShifts]);

  /** The roster narrowed by the search box and the toolbar filters. */
  const groups = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const scheduled = new Set(weekShifts.map((shift) => shift.employeeId));
    const visible = roster.filter((employee) => {
      if (query && !employee.name.toLowerCase().includes(query)) return false;
      if (!passesFilters(activeFilters, 'employeeId', [employee.id])) return false;
      if (!passesFilters(activeFilters, 'department', employee.departmentName ? [employee.departmentName] : [])) return false;
      // A client filter keeps people assigned to that client, and anyone with a shift that passed it.
      return scheduled.has(employee.id) || passesFilters(activeFilters, 'companyId', employee.clientIds);
    });
    return groupByDepartment(visible);
  }, [roster, weekShifts, activeFilters, searchQuery]);

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
  const hoursLabel = (hours: number) => t('weldhr.attendance.schedule.hours', { hours: formatHours(hours) });

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
  } else {
    scheduleContent = (
      <div className="min-h-0 flex-1 overflow-auto">
        <div
          role="table"
          aria-label={t('weldhr.attendance.schedule.title')}
          className="grid"
          style={{
            gridTemplateColumns: `${EMPLOYEE_COLUMN_WIDTH}px repeat(${days.length}, minmax(${DAY_COLUMN_MIN_WIDTH}px, 1fr))`,
            minWidth: EMPLOYEE_COLUMN_WIDTH + days.length * DAY_COLUMN_MIN_WIDTH,
          }}
        >
          {/* Day header, same strip as WeldCalendar's week view plus the day's planned hours */}
          <div role="row" className="contents">
            <div
              role="columnheader"
              className="sticky left-0 top-0 z-30 flex flex-col justify-center border-b border-r border-border bg-background px-4"
              style={{ height: HEADER_HEIGHT }}
            >
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t('weldhr.attendance.schedule.employees')}
              </div>
              <div className="mt-1 text-[22px] font-medium leading-tight">{employeeCount}</div>
              <div className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">{hoursLabel(totalHours)}</div>
            </div>
            {days.map((day, i) => {
              const date = dayDates[i]!;
              const today = isToday(date);
              return (
                <div
                  key={day}
                  role="columnheader"
                  className="sticky top-0 z-20 flex flex-col items-center justify-center border-b border-r border-border bg-background text-center last:border-r-0"
                  style={{ height: HEADER_HEIGHT }}
                >
                  {today && <div className={cn('absolute inset-0', TODAY_BG_CLASS)} aria-hidden />}
                  <div
                    className={cn('relative text-[11px] font-medium uppercase tracking-wide', today ? 'font-semibold' : 'text-muted-foreground')}
                    style={today ? { color: TODAY_BLUE } : undefined}
                  >
                    {format(date, 'EEE')}
                  </div>
                  <div
                    className={cn('relative mt-1 text-[22px] font-medium leading-tight', today && 'font-semibold')}
                    style={today ? { color: TODAY_BLUE } : undefined}
                  >
                    {format(date, 'd')}
                  </div>
                  <div className="relative mt-0.5 text-[11px] tabular-nums text-muted-foreground">{hoursLabel(hoursByDay.get(day) ?? 0)}</div>
                </div>
              );
            })}
          </div>

          {groups.map((group) => (
            <div key={group.departmentName ?? ''} role="rowgroup" className="contents">
              {showGroupHeaders && (
                <div role="row" className="contents">
                  <div role="cell" className="col-span-full border-b border-border bg-muted/40">
                    <span className="sticky left-0 inline-block px-4 py-1.5 text-[12px] font-semibold">
                      {group.departmentName ?? t('weldhr.attendance.schedule.noDepartment')}
                    </span>
                  </div>
                </div>
              )}
              {group.employees.map((employee) => (
                <div key={employee.id} role="row" className="contents">
                  <div
                    role="rowheader"
                    className="sticky left-0 z-10 flex min-w-0 items-start gap-2.5 border-b border-r border-border bg-background px-4 py-2.5"
                  >
                    <EmployeeAvatar name={employee.name} src={employee.avatarUrl} className="h-7 w-7 shrink-0" />
                    <div className="min-w-0">
                      <Link
                        to="/weldhr/employees/$employeeId"
                        params={{ employeeId: employee.id }}
                        className="block truncate text-[13px] font-medium hover:underline"
                      >
                        {employee.name}
                      </Link>
                      <div className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
                        {hoursLabel(hoursByEmployee.get(employee.id) ?? 0)}
                      </div>
                    </div>
                  </div>
                  {days.map((day, i) => (
                    <div
                      key={day}
                      role="cell"
                      className={cn(
                        'group/cell flex min-h-[72px] min-w-0 flex-col gap-1 border-b border-r border-border p-1 last:border-r-0',
                        isToday(dayDates[i]!) && TODAY_BG_CLASS,
                      )}
                    >
                      {(shiftsByCell.get(`${employee.id}|${day}`) ?? []).map((shift) => (
                        <ShiftBlock
                          key={shift.id}
                          shift={shift}
                          timeFormat={timeFormat}
                          onClick={canUpdate ? () => setDialog({ shift }) : undefined}
                        />
                      ))}
                      {canCreate && (
                        <button
                          type="button"
                          aria-label={`${t('weldhr.attendance.schedule.addShift')}: ${employee.name}, ${format(dayDates[i]!, 'EEE d MMM')}`}
                          onClick={() => setDialog({ employee, date: day })}
                          className="flex min-h-6 w-full flex-1 items-center justify-center rounded-[6px] text-muted-foreground opacity-0 transition-opacity hover:bg-muted/60 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/cell:opacity-100"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
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
          <h2 className="ml-1 hidden min-w-0 -translate-y-[1px] truncate whitespace-nowrap text-[18px] font-semibold md:block">
            {periodLabel(dayDates[0]!, dayDates[dayDates.length - 1]!)}
          </h2>
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
