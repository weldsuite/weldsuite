/**
 * Shared rules of the period-based filings (BTW-aangifte, Opgaaf ICP): which
 * period a calculation covers, and which returns are still open to change.
 */

/** Statuses of a return that was submitted to the Belastingdienst: immutable. */
export const FILED_RETURN_STATUSES = ['filed', 'submitted', 'accepted'] as const;

/** A return in these statuses can still be recalculated, edited or deleted. */
export function isUnfiledReturn(status: string): boolean {
  return !(FILED_RETURN_STATUSES as readonly string[]).includes(status);
}

export type ParsedPeriod = { ok: true; start: Date; end: Date } | { ok: false; error: string };

export type ReturnPeriodType = 'monthly' | 'quarterly' | 'yearly';

const PERIOD_MONTHS: Record<ReturnPeriodType, number> = { monthly: 1, quarterly: 3, yearly: 12 };

const PERIOD_SHAPE_ERRORS: Record<ReturnPeriodType, string> = {
  monthly: 'A monthly period runs from the first to the last day of one calendar month',
  quarterly: 'A quarterly period runs from the first day of a quarter (January, April, July or October) to its last day',
  yearly: 'A yearly period runs from 1 January to 31 December of one year',
};

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Parse a return period; the end must not be before the start and, when the
 * period type is given, the dates must span exactly one calendar month,
 * quarter or year.
 */
export function parseReturnPeriod(periodStart: string, periodEnd: string, periodType?: ReturnPeriodType): ParsedPeriod {
  const start = new Date(periodStart);
  const end = new Date(periodEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { ok: false, error: 'The period start and end must be valid dates' };
  }
  if (end.getTime() < start.getTime()) {
    return { ok: false, error: 'The period end must not be before the period start' };
  }
  if (periodType) {
    const months = PERIOD_MONTHS[periodType];
    const year = start.getUTCFullYear();
    const month = start.getUTCMonth();
    // Day 0 of the month after the period is its last day.
    const lastDay = new Date(Date.UTC(year, month + months, 0));
    if (start.getUTCDate() !== 1 || month % months !== 0 || dayOf(end) !== dayOf(lastDay)) {
      return { ok: false, error: PERIOD_SHAPE_ERRORS[periodType] };
    }
  }
  return { ok: true, start, end };
}

/** "2026-10-01 to 2026-12-31", for error messages. */
export function formatPeriod(start: Date, end: Date): string {
  return `${dayOf(start)} to ${dayOf(end)}`;
}

/** Whether two periods are the same days. */
export function isSamePeriod(a: { start: Date; end: Date }, b: { start: Date; end: Date }): boolean {
  return dayOf(a.start) === dayOf(b.start) && dayOf(a.end) === dayOf(b.end);
}
