/**
 * Attendance → Schedule, week view: the roster. Employees run down the left,
 * the days across the top, each cell holds that person's shifts for the day,
 * and leave and sickness run as bars across the days they cover. The day
 * header counts who works and who is away; clicking it opens that day.
 */

import { Link } from '@tanstack/react-router';
import { format, isToday } from 'date-fns';
import { Plus } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrShift } from '@weldsuite/app-api-client/domains/weldhr';
import { HEADER_HEIGHT, TODAY_BG_CLASS, TODAY_BLUE } from '@/app/weldcalendar/components/calendar-shared';
import type { TimeFormat } from '@/app/weldcalendar/lib/calendar-format';
import { cn } from '@/lib/utils';
import { EmployeeAvatar } from '../../components/shared';
import { formatHours, timeOffSpans, type DayStats, type RosterEmployee, type RosterGroup, type TimeOff } from './schedule-model';
import { ShiftBlock, TimeOffBar, useTimeOffText } from './schedule-parts';

/** Width of the leading employee column. */
const EMPLOYEE_COLUMN_WIDTH = 200;
/** As narrow as a shift's time range allows, so a week needs little sideways scrolling in a ~960px window. */
const DAY_COLUMN_MIN_WIDTH = 112;
/** A leave or sickness bar, and the gap above it. */
const BAR_HEIGHT = 22;
const BAR_GAP = 4;

export function ScheduleWeekView({
  days,
  groups,
  showGroupHeaders,
  employeeCount,
  totalHours,
  hoursByEmployee,
  shiftsByCell,
  timeOffByEmployee,
  dayStats,
  timeFormat,
  canCreate,
  canUpdate,
  onAddShift,
  onEditShift,
  onOpenDay,
}: Readonly<{
  days: string[];
  groups: RosterGroup[];
  showGroupHeaders: boolean;
  employeeCount: number;
  totalHours: number;
  hoursByEmployee: Map<string, number>;
  /** Shifts per `employeeId|day`, earliest first. */
  shiftsByCell: Map<string, HrShift[]>;
  timeOffByEmployee: Map<string, TimeOff[]>;
  dayStats: Map<string, DayStats>;
  timeFormat: TimeFormat;
  canCreate: boolean;
  canUpdate: boolean;
  onAddShift: (employee: RosterEmployee, day: string) => void;
  onEditShift: (shift: HrShift) => void;
  onOpenDay: (day: string) => void;
}>) {
  const t = useTranslations();
  const timeOffText = useTimeOffText();
  const dayDates = days.map((day) => new Date(`${day}T12:00:00`));
  const hoursLabel = (hours: number) => t('weldhr.attendance.schedule.hours', { hours: formatHours(hours) });

  return (
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
        {/* Day header, same strip as WeldCalendar's week view plus who works and who is away */}
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
            const stats = dayStats.get(day);
            const away = stats?.away.length ?? 0;
            return (
              <div
                key={day}
                role="columnheader"
                title={hoursLabel(stats?.hours ?? 0)}
                className="group/day sticky top-0 z-20 flex flex-col items-center justify-center border-b border-r border-border bg-background text-center last:border-r-0"
                style={{ height: HEADER_HEIGHT }}
              >
                {today && <div className={cn('absolute inset-0', TODAY_BG_CLASS)} aria-hidden />}
                <button
                  type="button"
                  onClick={() => onOpenDay(day)}
                  aria-label={t('weldhr.attendance.schedule.openDay', { date: format(date, 'EEEE d MMMM') })}
                  className="absolute inset-0 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                />
                <div
                  className={cn(
                    'pointer-events-none relative text-[11px] font-medium uppercase tracking-wide',
                    today ? 'font-semibold' : 'text-muted-foreground',
                  )}
                  style={today ? { color: TODAY_BLUE } : undefined}
                >
                  {format(date, 'EEE')}
                </div>
                <div
                  className={cn('pointer-events-none relative mt-1 text-[22px] font-medium leading-tight', today && 'font-semibold')}
                  style={today ? { color: TODAY_BLUE } : undefined}
                >
                  {format(date, 'd')}
                </div>
                <div className="pointer-events-none relative mt-0.5 flex flex-wrap justify-center gap-x-1 px-1 text-[11px] tabular-nums text-muted-foreground">
                  <span>{t('weldhr.attendance.schedule.dayOn', { count: stats?.working.length ?? 0 })}</span>
                  {away > 0 && (
                    <span className="text-amber-600 dark:text-amber-400">· {t('weldhr.attendance.schedule.dayAway', { count: away })}</span>
                  )}
                </div>
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
            {group.employees.map((employee) => {
              const spans = timeOffSpans(timeOffByEmployee.get(employee.id) ?? [], days);
              const lanes = spans.reduce((max, span) => Math.max(max, span.lane + 1), 0);
              return (
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
                        'group/cell relative flex min-h-[72px] min-w-0 flex-col gap-1 border-b border-r border-border p-1 last:border-r-0',
                        isToday(dayDates[i]!) && TODAY_BG_CLASS,
                      )}
                      // Room above the shifts for the leave and sickness bars.
                      style={lanes > 0 ? { paddingTop: BAR_GAP + lanes * (BAR_HEIGHT + BAR_GAP) } : undefined}
                    >
                      {/* A bar sits in the cell of its first visible day and reaches across the rest. */}
                      {spans
                        .filter((span) => span.startIndex === i)
                        .map((span) => {
                          const covered = span.endIndex - span.startIndex + 1;
                          const { label, title } = timeOffText(span.item, { startsBefore: span.continuesBefore });
                          return (
                            <TimeOffBar
                              key={span.item.id}
                              item={span.item}
                              label={label}
                              title={title}
                              className="absolute left-1 z-[5]"
                              style={{
                                top: BAR_GAP + span.lane * (BAR_HEIGHT + BAR_GAP),
                                height: BAR_HEIGHT,
                                // Each day column is equally wide and carries a 1px right border.
                                width: `calc(${covered} * 100% + ${covered - 1}px - 8px)`,
                              }}
                            />
                          );
                        })}
                      {(shiftsByCell.get(`${employee.id}|${day}`) ?? []).map((shift) => (
                        <ShiftBlock
                          key={shift.id}
                          shift={shift}
                          timeFormat={timeFormat}
                          onClick={canUpdate ? () => onEditShift(shift) : undefined}
                        />
                      ))}
                      {canCreate && (
                        <button
                          type="button"
                          aria-label={`${t('weldhr.attendance.schedule.addShift')}: ${employee.name}, ${format(dayDates[i]!, 'EEE d MMM')}`}
                          onClick={() => onAddShift(employee, day)}
                          className="flex min-h-6 w-full flex-1 items-center justify-center rounded-[6px] text-muted-foreground opacity-0 transition-opacity hover:bg-muted/60 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/cell:opacity-100"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
