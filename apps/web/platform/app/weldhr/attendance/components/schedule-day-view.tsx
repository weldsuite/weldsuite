/**
 * Attendance → Schedule, day view: one day by the hour, one column per
 * employee (grouped by department), the shifts drawn at their times with the
 * break shaded. Night shifts that began the day before show from midnight. A
 * narrow column after the hours counts how many people are working each hour,
 * so thin cover stands out. Leave and sickness fill the employee's column;
 * clicking an empty column adds a shift.
 */

import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { format } from 'date-fns';
import { Users } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrShift } from '@weldsuite/app-api-client/domains/weldhr';
import { DEFAULT_HOUR_HEIGHT, formatHourLabel } from '@/app/weldcalendar/components/calendar-shared';
import type { TimeFormat } from '@/app/weldcalendar/lib/calendar-format';
import { cn } from '@/lib/utils';
import { EmployeeAvatar, todayIso } from '../../components/shared';
import {
  DEFAULT_SHIFT_COLOR,
  dayHourRange,
  formatHours,
  hourlyCoverage,
  hoursIntoDay,
  hoursWithinDay,
  timeOffColor,
  timeOffCovers,
  type RosterEmployee,
  type RosterGroup,
  type TimeOff,
} from './schedule-model';
import { ShiftBlock, useTimeOffText } from './schedule-parts';

const HOUR_HEIGHT = DEFAULT_HOUR_HEIGHT;
const TIME_COLUMN_WIDTH = 64;
const COVERAGE_COLUMN_WIDTH = 44;
const EMPLOYEE_COLUMN_MIN_WIDTH = 132;
const DEPARTMENT_ROW_HEIGHT = 28;
const EMPLOYEE_ROW_HEIGHT = 64;

/** Hours since midnight now, ticking every minute. */
function useNowHours(): number {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now.getHours() + now.getMinutes() / 60;
}

export function ScheduleDayView({
  day,
  groups,
  showGroupHeaders,
  shiftsByCell,
  overnightShifts,
  timeOffByEmployee,
  timeFormat,
  canCreate,
  canUpdate,
  onAddShift,
  onEditShift,
}: Readonly<{
  day: string;
  groups: RosterGroup[];
  showGroupHeaders: boolean;
  /** Shifts per `employeeId|day`, earliest first. */
  shiftsByCell: Map<string, HrShift[]>;
  /** Per employee, shifts that began the day before and are still running after midnight. */
  overnightShifts: Map<string, HrShift[]>;
  timeOffByEmployee: Map<string, TimeOff[]>;
  timeFormat: TimeFormat;
  canCreate: boolean;
  canUpdate: boolean;
  onAddShift: (employee: RosterEmployee, day: string) => void;
  onEditShift: (shift: HrShift) => void;
}>) {
  const t = useTranslations();
  const timeOffText = useTimeOffText();
  const nowHours = useNowHours();

  const employees = groups.flatMap((group) => group.employees);
  /** An employee's shifts on the day: last night's still running, then the day's own. */
  const shiftsOf = (employeeId: string) => [...(overnightShifts.get(employeeId) ?? []), ...(shiftsByCell.get(`${employeeId}|${day}`) ?? [])];
  const dayShifts = employees.flatMap((employee) => shiftsOf(employee.id));
  const { from, to } = dayHourRange(dayShifts, day);
  const hours = Array.from({ length: to - from }, (_, i) => from + i);
  const coverage = hourlyCoverage(dayShifts, day, from, to);
  const busiest = Math.max(1, ...coverage);
  const bodyHeight = hours.length * HOUR_HEIGHT;
  const showNow = day === todayIso() && nowHours >= from && nowHours <= to;

  const headerRows = showGroupHeaders ? 2 : 1;
  const bodyRow = headerRows + 1;
  const employeeHeaderTop = showGroupHeaders ? DEPARTMENT_ROW_HEIGHT : 0;
  const yOf = (hour: number) => (Math.min(Math.max(hour, from), to) - from) * HOUR_HEIGHT;

  /** The hour gridlines every body column draws behind its content. */
  const hourLines = hours.map((hour) => (
    <div key={hour} className="border-b border-border/60" style={{ height: HOUR_HEIGHT }} aria-hidden />
  ));

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div
        role="table"
        aria-label={t('weldhr.attendance.schedule.title')}
        className="grid"
        style={{
          gridTemplateColumns: `${TIME_COLUMN_WIDTH}px ${COVERAGE_COLUMN_WIDTH}px repeat(${employees.length}, minmax(${EMPLOYEE_COLUMN_MIN_WIDTH}px, 1fr))`,
          minWidth: TIME_COLUMN_WIDTH + COVERAGE_COLUMN_WIDTH + employees.length * EMPLOYEE_COLUMN_MIN_WIDTH,
        }}
      >
        {/* Departments, each spanning its employees' columns */}
        {showGroupHeaders && (
          <div role="row" className="contents">
            <div
              className="sticky left-0 top-0 z-30 border-b border-r border-border bg-background"
              style={{ gridRow: 1, gridColumn: '1 / span 2', height: DEPARTMENT_ROW_HEIGHT }}
              aria-hidden
            />
            {groups.map((group, index) => {
              const start = 3 + groups.slice(0, index).reduce((sum, g) => sum + g.employees.length, 0);
              return (
                <div
                  key={group.departmentName ?? ''}
                  role="columnheader"
                  className="sticky top-0 z-20 flex items-center border-b border-r border-border bg-muted/40 last:border-r-0"
                  style={{ gridRow: 1, gridColumn: `${start} / span ${group.employees.length}`, height: DEPARTMENT_ROW_HEIGHT }}
                >
                  <span className="truncate px-3 text-[12px] font-semibold">
                    {group.departmentName ?? t('weldhr.attendance.schedule.noDepartment')}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Employees: who, and their hours or why they are not working */}
        <div role="row" className="contents">
          <div
            role="columnheader"
            className="sticky left-0 z-30 border-b border-r border-border bg-background"
            style={{ gridRow: headerRows, gridColumn: 1, top: employeeHeaderTop, height: EMPLOYEE_ROW_HEIGHT }}
          />
          <div
            role="columnheader"
            title={t('weldhr.attendance.schedule.coverage')}
            className="sticky z-30 flex items-end justify-center border-b border-r border-border bg-background pb-2 text-muted-foreground"
            style={{ gridRow: headerRows, gridColumn: 2, left: TIME_COLUMN_WIDTH, top: employeeHeaderTop, height: EMPLOYEE_ROW_HEIGHT }}
          >
            <Users className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">{t('weldhr.attendance.schedule.coverage')}</span>
          </div>
          {employees.map((employee, index) => {
            const off = (timeOffByEmployee.get(employee.id) ?? []).find((item) => timeOffCovers(item, day));
            const shifts = shiftsOf(employee.id);
            let status = t('weldhr.attendance.schedule.off');
            if (shifts.length > 0) {
              const hours = shifts.reduce((sum, shift) => sum + hoursWithinDay(shift, day), 0);
              status = t('weldhr.attendance.schedule.hours', { hours: formatHours(hours) });
            }
            else if (off) status = timeOffText(off).label;
            return (
              <div
                key={employee.id}
                role="columnheader"
                className="sticky z-20 flex min-w-0 items-center gap-2 border-b border-r border-border bg-background px-3 last:border-r-0"
                style={{ gridRow: headerRows, gridColumn: index + 3, top: employeeHeaderTop, height: EMPLOYEE_ROW_HEIGHT }}
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
                  <div className="mt-0.5 truncate text-[11px] tabular-nums text-muted-foreground">{status}</div>
                </div>
              </div>
            );
          })}
        </div>

        {/* The day, hour by hour */}
        <div role="row" className="contents">
          <div
            role="rowheader"
            className="sticky left-0 z-10 border-r border-border bg-background"
            style={{ gridRow: bodyRow, gridColumn: 1, height: bodyHeight }}
          >
            {hours.map((hour) => (
              <div key={hour} className="border-b border-border/60 pr-2 pt-1 text-right" style={{ height: HOUR_HEIGHT }}>
                <span className="text-[11px] tabular-nums text-muted-foreground">{formatHourLabel(hour, timeFormat)}</span>
              </div>
            ))}
          </div>
          <div
            role="cell"
            className="sticky z-10 border-r border-border bg-background"
            style={{ gridRow: bodyRow, gridColumn: 2, left: TIME_COLUMN_WIDTH, height: bodyHeight }}
          >
            {hours.map((hour, i) => {
              const count = coverage[i] ?? 0;
              return (
                <div
                  key={hour}
                  className={cn(
                    'flex items-center justify-center border-b border-border/60 text-[12px] font-medium tabular-nums',
                    count === 0 && 'font-normal text-muted-foreground',
                  )}
                  style={{
                    height: HOUR_HEIGHT,
                    backgroundColor:
                      count > 0 ? `color-mix(in srgb, ${DEFAULT_SHIFT_COLOR} ${Math.round(8 + (32 * count) / busiest)}%, transparent)` : undefined,
                  }}
                >
                  {count}
                </div>
              );
            })}
          </div>
          {employees.map((employee, index) => {
            const shifts = shiftsOf(employee.id);
            const off = (timeOffByEmployee.get(employee.id) ?? []).filter((item) => timeOffCovers(item, day));
            return (
              <div
                key={employee.id}
                role="cell"
                className="group/col relative min-w-0 border-r border-border last:border-r-0"
                style={{ gridRow: bodyRow, gridColumn: index + 3, height: bodyHeight }}
              >
                {hourLines}
                {canCreate && (
                  <button
                    type="button"
                    aria-label={`${t('weldhr.attendance.schedule.addShift')}: ${employee.name}, ${format(new Date(`${day}T12:00:00`), 'EEE d MMM')}`}
                    onClick={() => onAddShift(employee, day)}
                    className="absolute inset-0 transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  />
                )}
                {/* Leave or sickness fills the column, behind any shift that still stands */}
                {off.map((item) => {
                  const color = timeOffColor(item);
                  const { label, title } = timeOffText(item, { startsBefore: item.startDate < day });
                  return (
                    <div
                      key={item.id}
                      title={title}
                      className="pointer-events-none absolute inset-1 rounded-[6px] px-2 py-1.5 text-[11px] font-medium text-foreground"
                      style={
                        item.pending
                          ? { border: `1px dashed ${color}` }
                          : { backgroundColor: `color-mix(in srgb, ${color} 18%, transparent)` }
                      }
                    >
                      <span className="block truncate">{label}</span>
                    </div>
                  );
                })}
                {shifts.map((shift) => {
                  const start = hoursIntoDay(shift.startsAt, day);
                  const end = hoursIntoDay(shift.endsAt, day);
                  const top = yOf(start);
                  const height = Math.max(20, yOf(end) - top);
                  const pause =
                    shift.breakStartsAt && shift.breakEndsAt
                      ? { top: yOf(hoursIntoDay(shift.breakStartsAt, day)) - top, height: yOf(hoursIntoDay(shift.breakEndsAt, day)) - yOf(hoursIntoDay(shift.breakStartsAt, day)) }
                      : null;
                  return (
                    <ShiftBlock
                      key={shift.id}
                      shift={shift}
                      timeFormat={timeFormat}
                      onClick={canUpdate ? () => onEditShift(shift) : undefined}
                      // A fixed-height button centres its content; keep the text at the top like a calendar event.
                      className="absolute left-1 right-1 flex w-auto flex-col justify-start overflow-hidden"
                      style={{ top: top + 1, height: height - 2 }}
                      wrapTime
                    >
                      {pause && pause.height > 0 && (
                        <span className="pointer-events-none absolute inset-x-0 bg-black/20" style={{ top: pause.top, height: pause.height }} aria-hidden />
                      )}
                    </ShiftBlock>
                  );
                })}
              </div>
            );
          })}
          {showNow && (
            <div
              className="pointer-events-none relative z-[15]"
              style={{ gridRow: bodyRow, gridColumn: '2 / -1', height: bodyHeight }}
              aria-hidden
            >
              <div className="absolute left-0 right-0 flex items-center" style={{ top: yOf(nowHours) - 1 }}>
                <div className="-ml-[5px] h-2.5 w-2.5 rounded-full bg-red-500" />
                <div className="h-[2px] flex-1 bg-red-500" />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
