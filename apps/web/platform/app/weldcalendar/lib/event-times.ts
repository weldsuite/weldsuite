import { endOfDay, startOfDay } from 'date-fns';

export type EventTimesResult =
  | { ok: true; start: Date; end: Date | null }
  | { ok: false; error: 'invalid-start' | 'end-before-start' };

const isValidDate = (d: Date | null | undefined): d is Date => d instanceof Date && !Number.isNaN(d.getTime());

/**
 * Normalises the start / end the edit dialog collected so calendar-api (which
 * rejects `endTime <= startTime`) accepts them.
 *
 *  - All-day events span whole days: the start snaps to 00:00 and the end to
 *    23:59:59 of the end date (a missing end means a single day). An end date
 *    before the start date is an error.
 *  - Timed events: the dialog collects explicit date + time values, so an end
 *    that is equal to or before the start is an error ("End must be after
 *    start"), also on the same date. It is never rolled to the next day on the
 *    user's behalf: a past-midnight event is entered with the next day's date.
 *    (The quick-create card has its own normaliser, which does roll 23:00 -
 *    00:00 over, because it only asks for times.)
 *  - No end is fine; the server then keeps / defaults its own.
 */
export function normalizeEventTimes(
  start: Date | null | undefined,
  end: Date | null | undefined,
  allDay: boolean,
): EventTimesResult {
  if (!isValidDate(start)) return { ok: false, error: 'invalid-start' };
  const validEnd = isValidDate(end) ? end : null;

  if (allDay) {
    const from = startOfDay(start);
    if (!validEnd) return { ok: true, start: from, end: endOfDay(start) };
    if (startOfDay(validEnd).getTime() < from.getTime()) return { ok: false, error: 'end-before-start' };
    return { ok: true, start: from, end: endOfDay(validEnd) };
  }

  if (!validEnd) return { ok: true, start, end: null };
  if (validEnd.getTime() > start.getTime()) return { ok: true, start, end: validEnd };
  return { ok: false, error: 'end-before-start' };
}
