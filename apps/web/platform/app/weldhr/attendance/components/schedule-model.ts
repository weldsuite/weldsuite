/**
 * Attendance → Schedule: the pure part of the roster. Periods, shift maths,
 * grouping, and the leave and sickness ("time off") the three views draw next
 * to the shifts. No React here, so it can be unit tested.
 */

import { addDays, addMonths, endOfMonth, format, getDaysInMonth, isWeekend, startOfMonth } from 'date-fns';
import type { HrAbsence, HrLeaveRequest, HrShift } from '@weldsuite/app-api-client/domains/weldhr';
import { shiftIsoDate } from '../../components/shared';

export type RosterView = 'day' | 'week' | 'month';
export const ROSTER_VIEWS: RosterView[] = ['day', 'week', 'month'];

export interface RosterEmployee {
  id: string;
  name: string;
  avatarUrl: string | null;
  departmentName: string | null;
  jobTitle: string | null;
  /** Client accounts this employee is assigned to. */
  clientIds: string[];
}

export interface RosterGroup {
  /** `null` is the "no department" group. */
  departmentName: string | null;
  employees: RosterEmployee[];
}

/** Shifts without a client account use WeldCalendar's default blue. */
export const DEFAULT_SHIFT_COLOR = '#3b82f6';
/** WeldCalendar's calendar palette (minus the default blue), one colour per client account. */
const CLIENT_SHIFT_COLORS = ['#22c55e', '#14b8a6', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4', '#f97316', '#6366f1', '#ef4444'];
/** Leave whose type has no colour of its own. */
export const DEFAULT_LEAVE_COLOR = '#14b8a6';
export const SICK_COLOR = '#ef4444';

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

export function mondayOf(dateIso: string): string {
  const d = new Date(`${dateIso}T12:00:00`);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return format(d, 'yyyy-MM-dd');
}

/** The days a view shows around `anchor`: that day, its Mon–Sun week, or its calendar month. */
export function viewDays(anchor: string, view: RosterView): string[] {
  if (view === 'day') return [anchor];
  if (view === 'week') {
    const monday = mondayOf(anchor);
    return Array.from({ length: 7 }, (_, i) => shiftIsoDate(monday, i));
  }
  const first = startOfMonth(new Date(`${anchor}T12:00:00`));
  return Array.from({ length: getDaysInMonth(first) }, (_, i) => format(addDays(first, i), 'yyyy-MM-dd'));
}

/** `anchor` moved one period back or forward. */
export function stepAnchor(anchor: string, view: RosterView, direction: 1 | -1): string {
  if (view === 'day') return shiftIsoDate(anchor, direction);
  if (view === 'week') return shiftIsoDate(anchor, 7 * direction);
  return format(addMonths(startOfMonth(new Date(`${anchor}T12:00:00`)), direction), 'yyyy-MM-dd');
}

/** The Monday-first weeks a month grid shows for `anchor`'s month, padded with days of the months either side. */
export function monthGridWeeks(anchor: string): string[][] {
  const first = startOfMonth(new Date(`${anchor}T12:00:00`));
  const last = format(endOfMonth(first), 'yyyy-MM-dd');
  const weeks: string[][] = [];
  for (let monday = mondayOf(format(first, 'yyyy-MM-dd')); monday <= last; monday = shiftIsoDate(monday, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => shiftIsoDate(monday, i)));
  }
  return weeks;
}

/** "October 2026", or "Sep – Oct 2026" for a week that straddles two months (same as WeldCalendar's header). */
export function periodLabel(start: Date, end: Date): string {
  if (start.getMonth() === end.getMonth()) return format(start, 'MMMM yyyy');
  const yearLabel = start.getFullYear() === end.getFullYear() ? format(end, 'yyyy') : `${format(start, 'yyyy')} – ${format(end, 'yyyy')}`;
  return `${format(start, 'MMM')} – ${format(end, 'MMM')} ${yearLabel}`;
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

/** Whether `values` satisfy every completed "is" / "is not" filter on `field`. */
export function passesFilters(filters: { field: string; operator?: string; value?: string }[], field: string, values: string[]): boolean {
  return filters
    .filter((f) => f.field === field && f.operator && f.value)
    .every((f) => (f.operator === 'is not' ? !values.includes(f.value!) : values.includes(f.value!)));
}

/** The local calendar day a shift starts on (`startsAt` is a UTC instant). */
export function shiftDay(shift: HrShift): string {
  return format(new Date(shift.startsAt), 'yyyy-MM-dd');
}

/** Planned hours: the shift's length minus its (unpaid) break. */
export function shiftHours(shift: HrShift): number {
  const length = new Date(shift.endsAt).getTime() - new Date(shift.startsAt).getTime();
  const pause =
    shift.breakStartsAt && shift.breakEndsAt ? new Date(shift.breakEndsAt).getTime() - new Date(shift.breakStartsAt).getTime() : 0;
  return Math.max(0, (length - Math.max(0, pause)) / 3_600_000);
}

/** 29 → "29", 111.5 → "111.5". */
export function formatHours(hours: number): string {
  return String(Math.round(hours * 10) / 10);
}

export function shiftColor(shift: HrShift): string {
  if (!shift.companyId) return DEFAULT_SHIFT_COLOR;
  let hash = 0;
  for (const char of shift.companyId) hash = (hash * 31 + char.charCodeAt(0)) % 9973;
  return CLIENT_SHIFT_COLORS[hash % CLIENT_SHIFT_COLORS.length]!;
}

/** Hours from local midnight of `day` to the instant `iso`: 9.5 for 09:30 that day, 26 for 02:00 the next. */
export function hoursIntoDay(iso: string, day: string): number {
  return (new Date(iso).getTime() - new Date(`${day}T00:00:00`).getTime()) / 3_600_000;
}

/**
 * The hours a day view shows: always 08:00–18:00, widened to whole hours
 * around the day's shifts. A shift that runs past midnight ends the day at 24.
 */
export function dayHourRange(shifts: HrShift[], day: string): { from: number; to: number } {
  let from = 8;
  let to = 18;
  for (const shift of shifts) {
    from = Math.min(from, Math.floor(hoursIntoDay(shift.startsAt, day)));
    to = Math.max(to, Math.ceil(hoursIntoDay(shift.endsAt, day)));
  }
  return { from: Math.max(0, from), to: Math.min(24, to) };
}

/** For each hour in [from, to), how many employees have a shift running at half past. */
export function hourlyCoverage(shifts: HrShift[], day: string, from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from) }, (_, i) => {
    const middle = from + i + 0.5;
    const working = new Set<string>();
    for (const shift of shifts) {
      if (hoursIntoDay(shift.startsAt, day) <= middle && hoursIntoDay(shift.endsAt, day) > middle) working.add(shift.employeeId);
    }
    return working.size;
  });
}

/** Split the roster into departments; a single unnamed group when nobody has one. */
export function groupByDepartment(employees: RosterEmployee[]): RosterGroup[] {
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

// ---------------------------------------------------------------------------
// Time off: leave and sickness
// ---------------------------------------------------------------------------

/** Approved or requested leave, or a sick report, as the schedule draws it. */
export interface TimeOff {
  id: string;
  employeeId: string;
  kind: 'leave' | 'sick';
  /** A leave request still waiting for approval: drawn dashed and not counted as away. */
  pending: boolean;
  /** The leave type's name; null for sickness or a type without one. */
  typeName: string | null;
  /** The leave type's colour; null for sickness or a type without one. */
  color: string | null;
  startDate: string;
  /** Last day, inclusive; null while a sick report is still open. */
  endDate: string | null;
}

/** Approved and pending leave plus every sick report, as `TimeOff`. Rejected and cancelled leave is left out. */
export function toTimeOff(leave: HrLeaveRequest[], absences: HrAbsence[]): TimeOff[] {
  const out: TimeOff[] = [];
  for (const request of leave) {
    if (request.status !== 'approved' && request.status !== 'pending') continue;
    out.push({
      id: request.id,
      employeeId: request.employeeId,
      kind: 'leave',
      pending: request.status === 'pending',
      typeName: request.leaveTypeName,
      color: request.leaveTypeColor,
      startDate: request.startDate.slice(0, 10),
      endDate: request.endDate.slice(0, 10),
    });
  }
  for (const absence of absences) {
    out.push({
      id: absence.id,
      employeeId: absence.employeeId,
      kind: 'sick',
      pending: false,
      typeName: null,
      color: null,
      startDate: absence.startDate.slice(0, 10),
      endDate: absence.endDate ? absence.endDate.slice(0, 10) : null,
    });
  }
  return out;
}

export function timeOffColor(item: TimeOff): string {
  return item.kind === 'sick' ? SICK_COLOR : (item.color ?? DEFAULT_LEAVE_COLOR);
}

/** Whether `item` covers `day`; an open sick report covers every day from its start. */
export function timeOffCovers(item: TimeOff, day: string): boolean {
  return item.startDate <= day && (item.endDate === null || item.endDate >= day);
}

/** Whether `item` covers any day in [first, last]. */
export function timeOffOverlaps(item: TimeOff, first: string, last: string): boolean {
  return item.startDate <= last && (item.endDate === null || item.endDate >= first);
}

/** One time-off item clipped to the visible days, with the lane it sits in when items overlap. */
export interface TimeOffSpan {
  item: TimeOff;
  /** Index into the visible days of the first and the last day it covers. */
  startIndex: number;
  endIndex: number;
  /** It began before the first visible day. */
  continuesBefore: boolean;
  /** It goes on after the last visible day, or has no end yet. */
  continuesAfter: boolean;
  lane: number;
}

/**
 * The bars a row of `days` (consecutive ISO dates) needs for `items`: each
 * clipped to the period, and overlapping ones put in separate lanes, earliest
 * first.
 */
export function timeOffSpans(items: TimeOff[], days: string[]): TimeOffSpan[] {
  const first = days[0];
  const last = days.at(-1);
  if (!first || !last) return [];
  const spans: TimeOffSpan[] = [];
  for (const item of items) {
    if (!timeOffOverlaps(item, first, last)) continue;
    const continuesBefore = item.startDate < first;
    const continuesAfter = item.endDate === null || item.endDate > last;
    spans.push({
      item,
      startIndex: continuesBefore ? 0 : days.indexOf(item.startDate),
      endIndex: continuesAfter ? days.length - 1 : days.indexOf(item.endDate!),
      continuesBefore,
      continuesAfter,
      lane: 0,
    });
  }
  spans.sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex);
  const laneEnds: number[] = [];
  for (const span of spans) {
    const free = laneEnds.findIndex((end) => end < span.startIndex);
    span.lane = free === -1 ? laneEnds.length : free;
    laneEnds[span.lane] = span.endIndex;
  }
  return spans;
}

export interface DayStats {
  /** Employees with at least one shift that day. */
  working: RosterEmployee[];
  /** Employees on approved leave or sick that day (at weekends only those who also had a shift). */
  away: Array<{ employee: RosterEmployee; item: TimeOff }>;
  /** Employees with a leave request waiting for approval that day, and not otherwise away. */
  requested: Array<{ employee: RosterEmployee; item: TimeOff }>;
  /** Planned hours that day. */
  hours: number;
}

/** Who works, who is away and how many hours are planned, per day. */
export function buildDayStats(
  days: string[],
  employees: RosterEmployee[],
  shiftsByCell: Map<string, HrShift[]>,
  timeOffByEmployee: Map<string, TimeOff[]>,
): Map<string, DayStats> {
  const stats = new Map<string, DayStats>();
  for (const day of days) {
    const weekend = isWeekend(new Date(`${day}T12:00:00`));
    const entry: DayStats = { working: [], away: [], requested: [], hours: 0 };
    for (const employee of employees) {
      const shifts = shiftsByCell.get(`${employee.id}|${day}`) ?? [];
      if (shifts.length > 0) entry.working.push(employee);
      for (const shift of shifts) entry.hours += shiftHours(shift);
      const covering = (timeOffByEmployee.get(employee.id) ?? []).filter((item) => timeOffCovers(item, day));
      const away = covering.find((item) => !item.pending);
      if (away && (!weekend || shifts.length > 0)) {
        entry.away.push({ employee, item: away });
        continue;
      }
      const requested = covering.find((item) => item.pending);
      if (requested && (!weekend || shifts.length > 0)) entry.requested.push({ employee, item: requested });
    }
    stats.set(day, entry);
  }
  return stats;
}
