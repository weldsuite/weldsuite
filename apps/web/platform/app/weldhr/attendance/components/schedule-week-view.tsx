/**
 * Attendance → Schedule, week view: the roster. Employees run down the left,
 * the days across the top, each cell holds that person's shifts for the day,
 * and leave and sickness run as bars across the days they cover. The day
 * header counts who works and who is away; clicking it opens that day.
 *
 * Every row is equally tall, whatever it holds: a shift shows its hours and
 * type of work (the rest in its tooltip), a bar takes the place of a shift
 * rather than a line of its own, and a day with more shifts than fit shows
 * "+N more", which opens that day.
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
import { formatHours, timeOffSpans, type DayStats, type RosterEmployee, type RosterGroup, type TimeOff, type TimeOffSpan } from './schedule-model';
import { ShiftBlock, TimeOffBar, useTimeOffText } from './schedule-parts';

/** Width of the leading employee column. */
const EMPLOYEE_COLUMN_WIDTH = 200;
/** As narrow as a shift's time range allows, so a week needs little sideways scrolling in a ~960px window. */
const DAY_COLUMN_MIN_WIDTH = 112;
/** Height of every employee row, its 1px bottom border included. */
const ROW_HEIGHT = 57;
/** Padding around a cell's content, and the gap between its blocks. */
const CELL_PADDING = 4;
const GAP = 4;
/** What a cell's content has: room for one two-line shift, or two one-line ones. */
const SLOT = ROW_HEIGHT - 1 - 2 * CELL_PADDING;

/**
 * The leave and sickness bars that start in day column `index`, each reaching
 * across the days it covers. They share the row's height: one bar fills it,
 * overlapping ones split it.
 */
function CellTimeOffBars({ spans, index, lanes }: Readonly<{ spans: TimeOffSpan[]; index: number; lanes: number }>) {
  const timeOffText = useTimeOffText();
  const laneHeight = (SLOT - (lanes - 1) * GAP) / Math.max(lanes, 1);
  return spans
    .filter((span) => span.startIndex === index)
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
            top: CELL_PADDING + span.lane * (laneHeight + GAP),
            height: laneHeight,
            // Each day column is equally wide and carries a 1px right border.
            width: `calc(${covered} * 100% + ${covered - 1}px - 8px)`,
          }}
        />
      );
    });
}

/** One employee's day: their leave or sickness bars, their shifts, and (on hover) a button to add one. */
function RosterCell({
  employee,
  day,
  date,
  index,
  spans,
  lanes,
  shifts,
  timeFormat,
  canCreate,
  onAddShift,
  onOpenShift,
  onOpenDay,
}: Readonly<{
  employee: RosterEmployee;
  day: string;
  date: Date;
  index: number;
  spans: TimeOffSpan[];
  /** Bar lanes in the employee's row, which split its height. */
  lanes: number;
  shifts: HrShift[];
  timeFormat: TimeFormat;
  canCreate: boolean;
  onAddShift: (employee: RosterEmployee, day: string) => void;
  /** Opens the shift's details panel. */
  onOpenShift: (shift: HrShift) => void;
  onOpenDay: (day: string) => void;
}>) {
  const t = useTranslations();
  // Under a leave or sickness bar, the add button moves to the corner, above the bar.
  const underBar = spans.some((span) => span.startIndex <= index && index <= span.endIndex);
  // One shift shows two lines; two show one line each; more show the first and "+N more".
  const shown = shifts.length > 2 ? shifts.slice(0, 1) : shifts;
  const hidden = shifts.length - shown.length;
  const addLabel = `${t('weldhr.attendance.schedule.addShift')}: ${employee.name}, ${format(date, 'EEE d MMM')}`;
  const fillCell = shifts.length === 0 && !underBar;
  return (
    <div
      role="cell"
      className={cn(
        'group/cell relative flex min-w-0 flex-col border-b border-r border-border last:border-r-0',
        isToday(date) && TODAY_BG_CLASS,
      )}
      style={{ height: ROW_HEIGHT, padding: CELL_PADDING, gap: GAP }}
    >
      {/* A bar sits in the cell of its first visible day and reaches across the rest. */}
      <CellTimeOffBars spans={spans} index={index} lanes={lanes} />
      {shown.map((shift) => (
        <ShiftBlock
          key={shift.id}
          shift={shift}
          timeFormat={timeFormat}
          lines={shifts.length === 1 ? 2 : 1}
          // Above a bar it overlaps; the blocks share the cell's height.
          className="relative z-[6] flex min-h-0 flex-1 flex-col justify-center"
          onClick={() => onOpenShift(shift)}
        />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => onOpenDay(day)}
          className="relative z-[6] flex min-h-0 flex-1 items-center rounded-[6px] px-2.5 text-[11px] font-medium text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('weldhr.attendance.schedule.more', { count: hidden })}
        </button>
      )}
      {canCreate &&
        (fillCell ? (
          <button
            type="button"
            aria-label={addLabel}
            onClick={() => onAddShift(employee, day)}
            className="flex w-full flex-1 items-center justify-center rounded-[6px] text-muted-foreground opacity-0 transition-opacity hover:bg-muted/60 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/cell:opacity-100"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        ) : (
          <button
            type="button"
            aria-label={addLabel}
            onClick={() => onAddShift(employee, day)}
            className="absolute right-1.5 top-1.5 z-[7] flex h-5 w-5 items-center justify-center rounded-[5px] bg-background/90 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/cell:opacity-100"
          >
            <Plus className="h-3 w-3" />
          </button>
        ))}
    </div>
  );
}

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
  onAddShift,
  onOpenShift,
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
  onAddShift: (employee: RosterEmployee, day: string) => void;
  /** Opens the shift's details panel. */
  onOpenShift: (shift: HrShift) => void;
  onOpenDay: (day: string) => void;
}>) {
  const t = useTranslations();
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
                    className="sticky left-0 z-10 flex min-w-0 items-center gap-2.5 border-b border-r border-border bg-background px-4"
                    style={{ height: ROW_HEIGHT }}
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
                    <RosterCell
                      key={day}
                      employee={employee}
                      day={day}
                      date={dayDates[i]!}
                      index={i}
                      spans={spans}
                      lanes={lanes}
                      shifts={shiftsByCell.get(`${employee.id}|${day}`) ?? []}
                      timeFormat={timeFormat}
                      canCreate={canCreate}
                      onAddShift={onAddShift}
                      onOpenShift={onOpenShift}
                      onOpenDay={onOpenDay}
                    />
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
