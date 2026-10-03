import { addDays, addHours, differenceInCalendarDays, format, parseISO } from 'date-fns';

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
