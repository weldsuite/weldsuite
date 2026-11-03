/**
 * Calendar periods of the BTW-aangifte and the Opgaaf ICP: a month, a quarter
 * or a year. books-api only accepts dates that span exactly one of them.
 */

export type ReturnPeriodType = 'monthly' | 'quarterly' | 'yearly';

/** One period: its year and, for monthly and quarterly, the month (0-11) or quarter (0-3). */
export interface ReturnPeriod {
  year: number;
  index: number;
}

const PERIOD_MONTHS: Record<ReturnPeriodType, number> = { monthly: 1, quarterly: 3, yearly: 12 };

const day = (year: number, month: number, date: number) =>
  new Date(Date.UTC(year, month, date)).toISOString().slice(0, 10);

/** First and last day (YYYY-MM-DD) of a period. */
export function periodBounds(type: ReturnPeriodType, period: ReturnPeriod): { start: string; end: string } {
  const months = PERIOD_MONTHS[type];
  const firstMonth = type === 'yearly' ? 0 : period.index * months;
  return {
    start: day(period.year, firstMonth, 1),
    // Day 0 of the month after the period is its last day.
    end: day(period.year, firstMonth + months, 0),
  };
}

/** The last period that has fully ended on `today`: the one you normally file next. */
export function lastFinishedPeriod(type: ReturnPeriodType, today: Date): ReturnPeriod {
  const year = today.getFullYear();
  const month = today.getMonth();
  if (type === 'yearly') return { year: year - 1, index: 0 };
  const months = PERIOD_MONTHS[type];
  const current = Math.floor(month / months);
  const perYear = 12 / months;
  return current === 0 ? { year: year - 1, index: perYear - 1 } : { year, index: current - 1 };
}

/** "Q4 2026", "oktober 2026" or "2026". */
export function periodLabel(type: ReturnPeriodType, period: ReturnPeriod, language: string): string {
  if (type === 'yearly') return String(period.year);
  if (type === 'quarterly') return `Q${period.index + 1} ${period.year}`;
  return new Intl.DateTimeFormat(language, { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(period.year, period.index, 1)));
}

/** Month names for the month picker, January first. */
export function monthNames(language: string): string[] {
  const format = new Intl.DateTimeFormat(language, { month: 'long', timeZone: 'UTC' });
  return Array.from({ length: 12 }, (_, month) => format.format(new Date(Date.UTC(2000, month, 1))));
}

/** Whether `start`..`end` (YYYY-MM-DD) is exactly one period of the type. */
export function isWholePeriod(type: ReturnPeriodType, start: string, end: string): boolean {
  const [year, month, date] = start.split('-').map(Number);
  if (!year || !month || date !== 1) return false;
  const months = PERIOD_MONTHS[type];
  if ((month - 1) % months !== 0) return false;
  return periodBounds(type, { year, index: Math.floor((month - 1) / months) }).end === end;
}
