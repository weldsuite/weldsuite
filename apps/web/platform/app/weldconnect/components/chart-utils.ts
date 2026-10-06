/** Dashboard period selector values, and how they map onto the trends endpoint. */
export type DashboardPeriod = 'today' | 'weekly' | 'monthly' | 'yearly';
export type TrendApiPeriod = 'day' | 'week' | 'month' | 'year';

export function mapPeriodToApi(period: string): TrendApiPeriod {
  switch (period) {
    case 'today': return 'day';
    case 'monthly': return 'month';
    case 'yearly': return 'year';
    case 'weekly':
    default: return 'week';
  }
}

/**
 * Trend buckets arrive as `YYYY-MM-DD` (or `YYYY-MM-01` for the yearly view).
 * `new Date('2026-10-01')` is UTC midnight, which reads as the previous day west
 * of Greenwich, so date-only values are built in local time.
 */
export function parseTrendDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return new Date(value);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** Axis tick: month names for the yearly view, `Oct 6` otherwise. */
export function formatTrendTick(value: string, period: TrendApiPeriod, locale: string): string {
  const date = parseTrendDate(value);
  if (Number.isNaN(date.getTime())) return value;
  return period === 'year'
    ? date.toLocaleDateString(locale, { month: 'short' })
    : date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

/** Tooltip heading: `October 2026` for a monthly bucket, `Oct 6, 2026` otherwise. */
export function formatTrendLabel(value: string, period: TrendApiPeriod, locale: string): string {
  const date = parseTrendDate(value);
  if (Number.isNaN(date.getTime())) return value;
  return period === 'year'
    ? date.toLocaleDateString(locale, { month: 'long', year: 'numeric' })
    : date.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}
