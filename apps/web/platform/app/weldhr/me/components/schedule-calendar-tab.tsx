/**
 * My HR → Schedule → Shifts, as a calendar: your days in WeldCalendar's style, as a day, a
 * week or a month. Leave and sick days, your shifts and the hours you clocked
 * show per day: in the day and week views by the hour (the shift as planned,
 * and beside it the time you were clocked in), in the month view as chips.
 * Every item opens its own details panel.
 */

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { format } from 'date-fns';
import { ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useTranslations } from '@weldsuite/i18n/client';
import { formatClockCompact, formatClockRange, useTimeFormat } from '@/app/weldcalendar/lib/calendar-format';
import { DEFAULT_HOUR_HEIGHT, TODAY_BLUE, formatHourLabel } from '@/app/weldcalendar/components/calendar-shared';
import { FilterPills, type ActiveFilter, type FilterConfig } from '@/components/entity-list';
import { useObjectPanel } from '@/components/object-panel';
import {
  MY_ATTENDANCE_PANEL_TYPE,
  MY_LEAVE_REQUEST_PANEL_TYPE,
  MY_SHIFT_PANEL_TYPE,
  MY_SICK_REPORT_PANEL_TYPE,
} from '@/components/objects/hr-my-hr/types';
import { useMyHrAbsences, useMyHrAttendance, useMyHrLeave } from '@/hooks/queries/use-weldhr-queries';
import { cn } from '@/lib/utils';
import {
  DEFAULT_SHIFT_COLOR,
  ROSTER_VIEWS,
  hoursIntoDay,
  monthGridWeeks,
  passesFilters,
  periodLabel,
  stepAnchor,
  timeOffCovers,
  viewDays,
  type RosterView,
  type TimeOff,
} from '../../attendance/components/schedule-model';
import { RosterSearchInput, TimeOffBar, useTimeOffText } from '../../attendance/components/schedule-parts';
import { formatMinutes, formatWeekdayDate, formatWeekdayShort, shiftIsoDate, todayIso, useFormatTime } from '../../components/shared';
import type { MyAttendanceRecord } from './schedule-hours-tab';
import type { MyShift } from './schedule-shifts-tab';

/** Items a month day shows before summing up the rest. */
const MAX_ITEMS = 3;
const HOUR_HEIGHT = DEFAULT_HOUR_HEIGHT;
const TIME_COLUMN_WIDTH = 64;
const DAY_COLUMN_MIN_WIDTH = 120;
/** The clocked-time bar's share of a day column in the day and week views. */
const RECORD_WIDTH = '32%';

/** A clock record's colours: green when on time, amber when late, red when absent, grey otherwise. */
const RECORD_TONE: Record<string, { text: string; color: string }> = {
  present: { text: 'text-emerald-700 dark:text-emerald-400', color: '#10b981' },
  remote: { text: 'text-emerald-700 dark:text-emerald-400', color: '#10b981' },
  late: { text: 'text-amber-700 dark:text-amber-400', color: '#f59e0b' },
  half_day: { text: 'text-amber-700 dark:text-amber-400', color: '#f59e0b' },
  absent: { text: 'text-red-600 dark:text-red-400', color: '#ef4444' },
};
const NEUTRAL_TONE = { text: 'text-muted-foreground', color: '#94a3b8' };

type DayItem =
  | { kind: 'timeOff'; key: string; item: TimeOff }
  | { kind: 'shift'; key: string; shift: MyShift }
  | { kind: 'record'; key: string; record: MyAttendanceRecord };

/** The "Show" filter's value for an item. */
const SHOW_VALUE: Record<DayItem['kind'], string> = { shift: 'shifts', record: 'hours', timeOff: 'timeOff' };

/** The client account an item belongs to; time off has none. */
function clientOf(item: DayItem): string | null {
  if (item.kind === 'shift') return item.shift.companyName;
  if (item.kind === 'record') return item.record.companyName;
  return null;
}

/** The day a shift shows on: the local day it starts. */
function shiftDay(shift: MyShift): string {
  return format(new Date(shift.startsAt), 'yyyy-MM-dd');
}

/**
 * The day a clock record shows on: the local day it was clocked in, as a shift
 * shows on the day it starts. The record's own date is the UTC day of the
 * clock-in, which away from UTC is the day before or after around midnight (an
 * evening in New York is the next day). A record never clocked in has only that date.
 */
function recordDay(record: MyAttendanceRecord): string {
  return record.clockIn ? format(new Date(record.clockIn), 'yyyy-MM-dd') : record.date;
}

/** The start and end an item has on the clock; time off has none. */
function clockTimesOf(item: DayItem): Array<string | null | undefined> {
  if (item.kind === 'shift') return [item.shift.startsAt, item.shift.endsAt];
  if (item.kind === 'record') return [item.record.clockIn, item.record.clockOut];
  return [];
}

/** Hours since midnight now, ticking every minute. */
function useNowHours(): number {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now.getHours() + now.getMinutes() / 60;
}

/** Leave (approved or requested) and sick reports, as the roster draws them. */
function toMyTimeOff(
  leave: ReturnType<typeof useMyHrLeave>['data'],
  absences: ReturnType<typeof useMyHrAbsences>['data'],
): TimeOff[] {
  const out: TimeOff[] = [];
  for (const request of leave?.requests ?? []) {
    if (request.status !== 'approved' && request.status !== 'pending') continue;
    out.push({
      id: request.id,
      employeeId: '',
      kind: 'leave',
      pending: request.status === 'pending',
      typeName: request.leaveTypeName,
      color: request.leaveTypeColor,
      startDate: request.startDate,
      endDate: request.endDate,
    });
  }
  const reports = [...(absences?.current ? [absences.current] : []), ...(absences?.history ?? [])];
  for (const report of new Map(reports.map((r) => [r.id, r])).values()) {
    out.push({
      id: report.id,
      employeeId: '',
      kind: 'sick',
      pending: false,
      typeName: null,
      color: null,
      startDate: report.startDate,
      endDate: report.endDate,
    });
  }
  return out;
}

export function MyScheduleCalendar({ viewToggle }: Readonly<{ /** The list / calendar switch, first in the toolbar. */ viewToggle?: ReactNode }>) {
  const t = useTranslations();
  const timeFormat = useTimeFormat();
  const formatTime = useFormatTime();
  const timeOffText = useTimeOffText();
  const nowHours = useNowHours();
  const { open: openPanel } = useObjectPanel();
  const [view, setView] = useState<RosterView>('week');
  const [anchor, setAnchor] = useState(todayIso);
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const weeks = useMemo(() => monthGridWeeks(anchor), [anchor]);
  const days = useMemo(() => (view === 'month' ? weeks.flat() : viewDays(anchor, view)), [view, anchor, weeks]);
  const first = days[0]!;
  const last = days.at(-1)!;
  const month = anchor.slice(0, 7);
  const today = todayIso();

  // A day either side too: a record or shift filed under its UTC day can fall on a shown local day.
  const { data: attendance } = useMyHrAttendance({ from: shiftIsoDate(first, -1), to: shiftIsoDate(last, 1) });
  const { data: leave } = useMyHrLeave();
  const { data: absences } = useMyHrAbsences();
  const inView = new Set(days);
  const shiftsInView = (attendance?.shifts ?? []).filter((s) => inView.has(shiftDay(s)));
  const recordsInView = (attendance?.records ?? []).filter((r) => inView.has(recordDay(r)));

  /** The words an item is found by in the search. */
  const searchText = (item: DayItem): string => {
    if (item.kind === 'shift') return [item.shift.workType, item.shift.companyName, item.shift.notes].join(' ');
    if (item.kind === 'record') return [item.record.companyName, item.record.notes, t(`weldhr.status.attendance.${item.record.status}`)].join(' ');
    return timeOffText(item.item).label;
  };
  const query = searchQuery.trim().toLowerCase();
  /** Whether an item passes the filters and the search. */
  const shows = (item: DayItem) =>
    passesFilters(activeFilters, 'show', [SHOW_VALUE[item.kind]]) &&
    passesFilters(activeFilters, 'client', clientOf(item) ? [clientOf(item)!] : []) &&
    (!query || searchText(item).toLowerCase().includes(query));

  /** Everything per day that passes the filters: time off first, then shifts (earliest first), then the clock record. */
  // A few dozen items at most, so it is simply rebuilt on each render.
  const itemsByDay = (() => {
    const map = new Map<string, DayItem[]>();
    const add = (day: string, item: DayItem) => {
      if (shows(item)) map.set(day, [...(map.get(day) ?? []), item]);
    };
    const timeOff = toMyTimeOff(leave, absences);
    for (const day of days) {
      for (const item of timeOff) if (timeOffCovers(item, day)) add(day, { kind: 'timeOff', key: `off|${item.id}`, item });
    }
    for (const shift of [...shiftsInView].sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
      add(shiftDay(shift), { kind: 'shift', key: `shift|${shift.id}`, shift });
    }
    for (const record of recordsInView) add(recordDay(record), { kind: 'record', key: `record|${record.id}`, record });
    return map;
  })();

  const clients = [
    ...new Set(
      [...shiftsInView.map((s) => s.companyName), ...recordsInView.map((r) => r.companyName)].filter(
        (name): name is string => !!name,
      ),
    ),
  ].sort((a, b) => a.localeCompare(b));
  const filterConfigs: FilterConfig[] = [
    {
      field: 'show',
      label: t('weldhr.me.schedule.filters.show'),
      options: [
        { value: 'shifts', label: t('weldhr.me.schedule.tabs.shifts') },
        { value: 'hours', label: t('weldhr.me.schedule.tabs.hours') },
        { value: 'timeOff', label: t('weldhr.me.schedule.filters.timeOff') },
      ],
    },
    ...(clients.length > 0
      ? [{ field: 'client', label: t('weldhr.me.schedule.filters.client'), options: clients.map((name) => ({ value: name, label: name })) }]
      : []),
  ];

  function openItem(item: DayItem) {
    if (item.kind === 'shift') openPanel({ type: MY_SHIFT_PANEL_TYPE, id: item.shift.id });
    else if (item.kind === 'record') openPanel({ type: MY_ATTENDANCE_PANEL_TYPE, id: item.record.id });
    else openPanel({ type: item.item.kind === 'sick' ? MY_SICK_REPORT_PANEL_TYPE : MY_LEAVE_REQUEST_PANEL_TYPE, id: item.item.id });
  }

  const compactRange = (startsAt: string, endsAt: string) =>
    `${formatClockCompact(new Date(startsAt), timeFormat)} – ${formatClockCompact(new Date(endsAt), timeFormat)}`;
  const recordTitle = (record: MyAttendanceRecord) =>
    `${t('weldhr.me.attendance.table.clockIn')} ${formatTime(record.clockIn)} · ${t('weldhr.me.attendance.table.clockOut')} ${formatTime(record.clockOut)}`;
  const recordLabel = (record: MyAttendanceRecord) =>
    record.workedMinutes !== null ? formatMinutes(record.workedMinutes) : t(`weldhr.status.attendance.${record.status}`);

  /** A leave or sick chip that opens its panel. */
  function timeOffChip(item: Extract<DayItem, { kind: 'timeOff' }>) {
    const { label, title } = timeOffText(item.item);
    return (
      <button
        key={item.key}
        type="button"
        onClick={() => openItem(item)}
        className="block w-full rounded-[6px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <TimeOffBar item={item.item} label={label} title={title} className="h-5 hover:brightness-95" />
      </button>
    );
  }

  // ---- Month: chips per day ------------------------------------------------

  function monthChip(item: DayItem) {
    if (item.kind === 'timeOff') return timeOffChip(item);
    if (item.kind === 'shift') {
      const { shift } = item;
      const range = compactRange(shift.startsAt, shift.endsAt);
      return (
        <button
          key={item.key}
          type="button"
          onClick={() => openItem(item)}
          title={[range, shift.workType, shift.companyName].filter(Boolean).join(' · ')}
          className="flex h-5 w-full items-center rounded-[6px] px-1.5 text-left text-[11px] font-semibold leading-none text-white hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{ backgroundColor: DEFAULT_SHIFT_COLOR }}
        >
          <span className="truncate tabular-nums">{range}</span>
        </button>
      );
    }
    const { record } = item;
    return (
      <button
        key={item.key}
        type="button"
        onClick={() => openItem(item)}
        title={recordTitle(record)}
        className={cn(
          'flex h-5 w-full items-center gap-1 rounded-[6px] border border-border bg-background px-1.5 text-left text-[11px] font-medium leading-none hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          (RECORD_TONE[record.status] ?? NEUTRAL_TONE).text,
        )}
      >
        <Clock className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate tabular-nums">{recordLabel(record)}</span>
      </button>
    );
  }

  function renderMonth() {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <div className="grid shrink-0 grid-cols-7 border-b border-border">
          {weeks[0]!.map((day) => (
            <div
              key={day}
              className="border-r border-border py-2 text-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground last:border-r-0"
            >
              {formatWeekdayShort(day)}
            </div>
          ))}
        </div>
        <div className="grid flex-1" style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(116px, 1fr))` }}>
          {weeks.map((week) => (
            <div key={week[0]} className="grid grid-cols-7 border-b border-border last:border-b-0">
              {week.map((day) => {
                const inMonth = day.startsWith(month);
                const items = itemsByDay.get(day) ?? [];
                const shown = items.length > MAX_ITEMS ? items.slice(0, MAX_ITEMS - 1) : items;
                return (
                  <div key={day} className={cn('min-w-0 overflow-hidden border-r border-border p-1.5 last:border-r-0', !inMonth && 'bg-muted/50')}>
                    <div className="flex justify-end">
                      <DayNumber day={day} today={today} muted={!inMonth} onOpen={() => showDay(day)} />
                    </div>
                    <div className="mt-1 space-y-1">
                      {shown.map(monthChip)}
                      {items.length > shown.length && (
                        <button
                          type="button"
                          onClick={() => showDay(day)}
                          className="pl-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                        >
                          {t('weldhr.attendance.schedule.more', { count: items.length - shown.length })}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ---- Day and week: by the hour -------------------------------------------

  function renderTimeGrid() {
    // From 8 to 18 at least, wider when a shift or clock record falls outside it.
    let from = 8;
    let to = 18;
    for (const day of days) {
      const times = (itemsByDay.get(day) ?? []).flatMap(clockTimesOf).filter((iso): iso is string => !!iso);
      for (const iso of times) {
        from = Math.min(from, Math.floor(hoursIntoDay(iso, day)));
        to = Math.max(to, Math.ceil(hoursIntoDay(iso, day)));
      }
    }
    from = Math.max(0, from);
    to = Math.min(24, to);
    const hours = Array.from({ length: to - from }, (_, i) => from + i);
    const bodyHeight = hours.length * HOUR_HEIGHT;
    const yOf = (hour: number) => (Math.min(Math.max(hour, from), to) - from) * HOUR_HEIGHT;
    const anyTimeOff = days.some((day) => (itemsByDay.get(day) ?? []).some((item) => item.kind === 'timeOff'));

    return (
      <div className="min-h-0 flex-1 overflow-auto">
        <div
          className="grid"
          style={{
            gridTemplateColumns: `${TIME_COLUMN_WIDTH}px repeat(${days.length}, minmax(${DAY_COLUMN_MIN_WIDTH}px, 1fr))`,
            minWidth: TIME_COLUMN_WIDTH + days.length * DAY_COLUMN_MIN_WIDTH,
          }}
        >
          {/* Days: weekday and date; in the week view a date opens that day */}
          <div className="sticky left-0 top-0 z-30 border-b border-r border-border bg-background" />
          {days.map((day) => (
            <div
              key={day}
              className="sticky top-0 z-20 flex items-center justify-center gap-1.5 border-b border-r border-border bg-background py-2 last:border-r-0"
            >
              <span
                className={cn('text-[11px] font-medium uppercase tracking-wide', day === today ? 'font-semibold' : 'text-muted-foreground')}
                style={day === today ? { color: TODAY_BLUE } : undefined}
              >
                {formatWeekdayShort(day)}
              </span>
              <DayNumber day={day} today={today} onOpen={view === 'week' ? () => showDay(day) : undefined} />
            </div>
          ))}

          {/* Leave and sick days, all day */}
          {anyTimeOff && (
            <>
              <div className="sticky left-0 z-10 border-b border-r border-border bg-background" />
              {days.map((day) => (
                <div key={day} className="min-w-0 space-y-1 border-b border-r border-border p-1 last:border-r-0">
                  {(itemsByDay.get(day) ?? []).flatMap((item) => (item.kind === 'timeOff' ? [timeOffChip(item)] : []))}
                </div>
              ))}
            </>
          )}

          {/* The hours */}
          <div className="sticky left-0 z-10 border-r border-border bg-background" style={{ height: bodyHeight }}>
            {hours.map((hour) => (
              <div key={hour} className="border-b border-border/60 pr-2 pt-1 text-right" style={{ height: HOUR_HEIGHT }}>
                <span className="text-[11px] tabular-nums text-muted-foreground">{formatHourLabel(hour, timeFormat)}</span>
              </div>
            ))}
          </div>
          {days.map((day) => {
            const items = itemsByDay.get(day) ?? [];
            const shifts = items.flatMap((item) => (item.kind === 'shift' ? [item] : []));
            // Only records with a clock-in draw a bar; one never clocked in leaves the shift its full width.
            const records = items.flatMap((item) =>
              item.kind === 'record' && item.record.clockIn ? [{ ...item, clockIn: item.record.clockIn }] : [],
            );
            return (
              <div key={day} className="relative min-w-0 border-r border-border last:border-r-0" style={{ height: bodyHeight }}>
                {hours.map((hour) => (
                  <div key={hour} className="border-b border-border/60" style={{ height: HOUR_HEIGHT }} aria-hidden />
                ))}

                {/* The shift as planned, leaving room on the right for the clocked time */}
                {shifts.map((item) => {
                  const { shift } = item;
                  const top = yOf(hoursIntoDay(shift.startsAt, day));
                  const height = Math.max(20, yOf(hoursIntoDay(shift.endsAt, day)) - top);
                  const pause =
                    shift.breakStartsAt && shift.breakEndsAt
                      ? {
                          top: yOf(hoursIntoDay(shift.breakStartsAt, day)) - top,
                          height: yOf(hoursIntoDay(shift.breakEndsAt, day)) - yOf(hoursIntoDay(shift.breakStartsAt, day)),
                        }
                      : null;
                  const style: CSSProperties = {
                    top: top + 1,
                    height: height - 2,
                    right: records.length > 0 ? `calc(${RECORD_WIDTH} + 8px)` : 4,
                    backgroundColor: DEFAULT_SHIFT_COLOR,
                  };
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => openItem(item)}
                      title={[formatClockRange(new Date(shift.startsAt), new Date(shift.endsAt), timeFormat), shift.workType, shift.companyName]
                        .filter(Boolean)
                        .join(' · ')}
                      // A fixed-height button centres its content; keep the text at the top like a calendar event.
                      className="absolute left-1 flex flex-col justify-start overflow-hidden rounded-[6px] border border-white/10 px-2 py-1.5 text-left text-[12px] leading-tight text-white hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      style={style}
                    >
                      {pause && pause.height > 0 && (
                        <span className="pointer-events-none absolute inset-x-0 bg-black/20" style={{ top: pause.top, height: pause.height }} aria-hidden />
                      )}
                      <span className="relative block break-words font-semibold tabular-nums">{compactRange(shift.startsAt, shift.endsAt)}</span>
                      {shift.workType && <span className="relative mt-[3px] block truncate text-white/80">{shift.workType}</span>}
                    </button>
                  );
                })}

                {/* The time you were clocked in: a narrow bar on the right */}
                {records.map((item) => {
                  const { record } = item;
                  const start = hoursIntoDay(item.clockIn, day);
                  let end = record.clockOut ? hoursIntoDay(record.clockOut, day) : start + 0.5;
                  // Still clocked in today: up to now.
                  if (!record.clockOut && day === today) end = Math.max(start + 0.25, nowHours);
                  const top = yOf(start);
                  const height = Math.max(18, yOf(end) - top);
                  const tone = RECORD_TONE[record.status] ?? NEUTRAL_TONE;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => openItem(item)}
                      title={recordTitle(record)}
                      className={cn(
                        'absolute right-1 flex flex-col justify-start overflow-hidden rounded-[6px] border-l-[3px] px-1.5 py-1 text-left text-[11px] font-medium leading-tight hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        tone.text,
                      )}
                      style={{
                        top: top + 1,
                        height: height - 2,
                        width: shifts.length > 0 ? RECORD_WIDTH : 'calc(100% - 8px)',
                        borderLeftColor: tone.color,
                        backgroundColor: `color-mix(in srgb, ${tone.color} 14%, transparent)`,
                      }}
                    >
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3 shrink-0" aria-hidden />
                        <span className="truncate tabular-nums">{recordLabel(record)}</span>
                      </span>
                    </button>
                  );
                })}

                {day === today && nowHours >= from && nowHours <= to && (
                  <div className="pointer-events-none absolute left-0 right-0 z-[5] flex items-center" style={{ top: yOf(nowHours) - 1 }} aria-hidden>
                    <div className="-ml-[5px] h-2.5 w-2.5 rounded-full bg-red-500" />
                    <div className="h-[2px] flex-1 bg-red-500" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function showDay(day: string) {
    setAnchor(day);
    setView('day');
  }

  const firstDate = new Date(`${first}T12:00:00`);
  let title = periodLabel(firstDate, new Date(`${last}T12:00:00`));
  if (view === 'day') title = formatWeekdayDate(anchor);
  else if (view === 'month') title = periodLabel(new Date(`${anchor}T12:00:00`), new Date(`${anchor}T12:00:00`));
  const todayInView = view === 'month' ? today.startsWith(month) : days.includes(today);
  const viewLabels: Record<RosterView, string> = {
    day: t('weldhr.attendance.schedule.viewDay'),
    week: t('weldhr.attendance.schedule.viewWeek'),
    month: t('weldhr.attendance.schedule.viewMonth'),
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The list pages' top bar: same height and padding. */}
      <div className="flex h-[53px] shrink-0 items-center justify-between gap-2 border-b border-border px-3 md:px-4">
        <div className="flex min-w-0 items-center gap-1 md:gap-2">
          {/* As in the list: Filter first, then the list / calendar switch. */}
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
          {viewToggle}
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
          <h2 className="ml-1 min-w-0 -translate-y-[1px] truncate text-[18px] font-semibold">{title}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!todayInView && (
            <Button variant="outline" size="sm" className="shrink-0 shadow-none" onClick={() => setAnchor(today)}>
              {t('weldhr.attendance.schedule.today')}
            </Button>
          )}
          <RosterSearchInput
            open={searchOpen}
            query={searchQuery}
            placeholder={t('weldhr.me.schedule.search.shifts')}
            toggleLabel={t('weldhr.me.schedule.search.shifts')}
            onOpenChange={setSearchOpen}
            onQueryChange={setSearchQuery}
          />
          <Select value={view} onValueChange={(next) => setView(next as RosterView)}>
            <SelectTrigger size="sm" className="w-[110px] shadow-none md:w-[130px]" aria-label={t('weldhr.attendance.schedule.viewLabel')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {ROSTER_VIEWS.map((option) => (
                <SelectItem key={option} value={option}>
                  {viewLabels[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {view === 'month' ? renderMonth() : renderTimeGrid()}
    </div>
  );
}

/** A day's number, blue on today; a button when it opens that day. */
function DayNumber({ day, today, muted, onOpen }: Readonly<{ day: string; today: string; muted?: boolean; onOpen?: () => void }>) {
  const isToday = day === today;
  const className = cn(
    'flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] text-sm font-medium tabular-nums',
    isToday && 'font-semibold',
    muted && 'text-muted-foreground',
    onOpen && 'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
  );
  const style = isToday ? { color: TODAY_BLUE } : undefined;
  const label = Number(day.slice(8));
  if (!onOpen) {
    return (
      <span className={className} style={style}>
        {label}
      </span>
    );
  }
  return (
    <button type="button" onClick={onOpen} aria-label={formatWeekdayDate(day)} className={className} style={style}>
      {label}
    </button>
  );
}
