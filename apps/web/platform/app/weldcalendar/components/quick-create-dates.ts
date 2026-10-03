import { addDays, addHours, differenceInCalendarDays, format, isSameDay, parseISO } from 'date-fns';

export interface QuickCreateRange {
  /** yyyy-MM-dd */
  startDate: string;
  /** HH:mm */
  startTime: string;
  endDate: string;
  endTime: string;
}

/**
 * Initial date/time fields of the quick-create card. Without a given start it
 * is the next full hour, one hour long, and the dates come from those same
 * moments: late in the evening that is tomorrow 00:00, not today 00:00 (which
 * already passed).
 */
export function defaultQuickCreateRange(
  defaultStart?: Date,
  defaultEnd?: Date,
  now: Date = new Date(),
): QuickCreateRange {
  let start = defaultStart;
  if (!start) {
    start = new Date(now);
    start.setMinutes(0, 0, 0);
    start = addHours(start, 1);
  }
  const end = defaultEnd ?? addHours(start, 1);
  return {
    startDate: format(start, 'yyyy-MM-dd'),
    startTime: format(start, 'HH:mm'),
    endDate: format(end, 'yyyy-MM-dd'),
    endTime: format(end, 'HH:mm'),
  };
}

/**
 * The end date after the start date moved from `prevStart` to `nextStart`:
 * shifted by the same number of days, so the event keeps its length instead of
 * ending before it starts.
 */
export function shiftEndDate(prevStart: string, nextStart: string, end: string): string {
  const delta = differenceInCalendarDays(parseISO(nextStart), parseISO(prevStart));
  if (!delta || Number.isNaN(delta)) return end;
  return format(addDays(parseISO(end), delta), 'yyyy-MM-dd');
}

/** Hour a new event on a day other than today starts at. */
export const DEFAULT_EVENT_START_HOUR = 9;

/**
 * Default slot for a day that was clicked without a time (Month view): the
 * next full hour when the day is today, else 09:00 - 10:00. Never midnight,
 * so saving the untouched card does not create a 12 AM event.
 */
export function defaultRangeForDay(day: Date, now: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(day);
  if (isSameDay(day, now)) {
    start.setHours(now.getHours() + 1, 0, 0, 0);
    // Late evening: the next full hour is tomorrow, so stay on the clicked day.
    if (!isSameDay(start, day)) start.setTime(new Date(day).setHours(23, 0, 0, 0));
  } else {
    start.setHours(DEFAULT_EVENT_START_HOUR, 0, 0, 0);
  }
  let end = addHours(start, 1);
  if (!isSameDay(end, start)) end = new Date(new Date(start).setHours(23, 59, 0, 0));
  return { start, end };
}

/** `yyyy-MM-dd` + `HH:mm` as a local Date; a blank time counts as 00:00. */
function toLocalDate(date: string, time: string): Date {
  return new Date(`${date}T${time || '00:00'}`);
}

/**
 * The start and end moments the card saves. The end never lands on or before
 * the start: an end date before the start date is raised to it, and an end
 * time-of-day at or before the start's (23:00 - 00:00 on one date) rolls to the
 * next day. All-day events run from the start date's midnight to the end
 * date's last second.
 */
export function resolveQuickCreateTimes(range: QuickCreateRange, allDay: boolean): { start: Date; end: Date } {
  const endDate = range.endDate < range.startDate ? range.startDate : range.endDate;
  if (allDay) {
    return {
      start: toLocalDate(range.startDate, '00:00'),
      end: new Date(`${endDate}T23:59:59`),
    };
  }
  const start = toLocalDate(range.startDate, range.startTime);
  let end = toLocalDate(endDate, range.endTime);
  if (end <= start) end = addDays(end, 1);
  return { start, end };
}

/** The range as the card shows and saves it (see {@link resolveQuickCreateTimes}). */
export function normalizeQuickCreateRange(range: QuickCreateRange, allDay: boolean): QuickCreateRange {
  const { end } = resolveQuickCreateTimes(range, allDay);
  if (allDay) return { ...range, endDate: format(end, 'yyyy-MM-dd') };
  return { ...range, endDate: format(end, 'yyyy-MM-dd'), endTime: format(end, 'HH:mm') };
}

/**
 * Where a task created from the calendar is pinned: the due date at its time
 * when one is set, else the clicked slot (when the due date is still the clicked
 * day) or the default slot of that day. Null without a due date: the task is
 * then left to the auto-scheduler.
 */
export function resolveTaskSlot(
  dueDate: Date | undefined,
  dueTime: string,
  clicked: { start?: Date; end?: Date },
  now: Date = new Date(),
): { start: Date; durationMinutes: number | null } | null {
  if (!dueDate) return null;
  const onClickedDay = !!clicked.start && isSameDay(clicked.start, dueDate);
  const clickedMinutes =
    onClickedDay && clicked.start && clicked.end
      ? Math.round((clicked.end.getTime() - clicked.start.getTime()) / 60000)
      : 0;
  const durationMinutes = clickedMinutes > 0 ? clickedMinutes : null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(dueTime);
  if (match) {
    const start = new Date(dueDate);
    start.setHours(Number(match[1]), Number(match[2]), 0, 0);
    return { start, durationMinutes };
  }
  const start = onClickedDay && clicked.start ? new Date(clicked.start) : defaultRangeForDay(dueDate, now).start;
  return { start, durationMinutes };
}
