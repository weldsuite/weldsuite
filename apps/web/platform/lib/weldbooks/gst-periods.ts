/**
 * Period presets of the GST return worksheet: whole calendar months and
 * quarters (the GST return periods) around a `YYYY-MM-DD` date.
 */

export interface GstPeriod {
  periodStart: string;
  periodEnd: string;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Last day of a month (1-12). */
function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parts(isoDate: string): { year: number; month: number } {
  const [year, month] = isoDate.split('-').map(Number);
  return { year, month };
}

/** The calendar month a date is in. */
export function monthPeriod(isoDate: string): GstPeriod {
  const { year, month } = parts(isoDate);
  return { periodStart: iso(year, month, 1), periodEnd: iso(year, month, lastDay(year, month)) };
}

/** The calendar month before the one a date is in. */
export function previousMonthPeriod(isoDate: string): GstPeriod {
  const { year, month } = parts(isoDate);
  return month === 1 ? monthPeriod(iso(year - 1, 12, 1)) : monthPeriod(iso(year, month - 1, 1));
}

/** The calendar quarter (Jan-Mar, Apr-Jun, ...) a date is in. */
export function quarterPeriod(isoDate: string): GstPeriod {
  const { year, month } = parts(isoDate);
  const firstMonth = Math.floor((month - 1) / 3) * 3 + 1;
  return { periodStart: iso(year, firstMonth, 1), periodEnd: iso(year, firstMonth + 2, lastDay(year, firstMonth + 2)) };
}

/** True for two valid `YYYY-MM-DD` dates in order. */
export function isValidPeriod(period: GstPeriod): boolean {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  return day.test(period.periodStart) && day.test(period.periodEnd) && period.periodStart <= period.periodEnd;
}
