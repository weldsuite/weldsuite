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

/** Parse a return period; the end must not be before the start. */
export function parseReturnPeriod(periodStart: string, periodEnd: string): ParsedPeriod {
  const start = new Date(periodStart);
  const end = new Date(periodEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { ok: false, error: 'The period start and end must be valid dates' };
  }
  if (end.getTime() < start.getTime()) {
    return { ok: false, error: 'The period end must not be before the period start' };
  }
  return { ok: true, start, end };
}
