/**
 * Turns the dashboard's monthly ledger trend into the series the charts draw.
 * Pure functions, no React, so the period maths is tested on its own.
 *
 * `monthlyTrend` carries 24 months (revenue, expenses, profit). An older API
 * only returns 12 months of revenue (`monthlyRevenue`): expenses and profit are
 * then unknown (`null`) here, and each chart decides how to draw that (the
 * overview cards draw it as zero).
 */

import type { Dashboard } from '@/lib/api/domains/weldbooks';

export type Metric = 'revenue' | 'expenses' | 'profit';
export type Compare = 'previousPeriod' | 'previousYear';

export type TrendMonth = { month: string; revenue: number; expenses: number | null; profit: number | null };

/** One x position: the period's value and, when there is one, the value it is compared with. */
export type SeriesPoint = { month: string; value?: number; compareMonth?: string; compareValue?: number };

export type RangeSeries = {
  points: SeriesPoint[];
  total: number | null;
  /** `null` when comparison is off or the data does not reach back far enough. */
  compareTotal: number | null;
};

export function trendMonths(dashboard: Pick<Dashboard, 'monthlyTrend' | 'monthlyRevenue'>): TrendMonth[] {
  if (dashboard.monthlyTrend?.length) {
    return dashboard.monthlyTrend.map((m) => ({
      month: m.month,
      revenue: Number(m.revenue),
      expenses: Number(m.expenses),
      profit: Number(m.profit),
    }));
  }
  return (dashboard.monthlyRevenue ?? []).map((m) => ({ month: m.month, revenue: Number(m.total), expenses: null, profit: null }));
}

const sum = (values: Array<number | undefined>) => values.reduce<number>((total, v) => total + (v ?? 0), 0);

/**
 * The last `size` months of a metric, each paired with the month it is
 * compared with: `size` months earlier (previous period) or 12 months earlier
 * (previous year).
 */
export function rangeSeries(months: TrendMonth[], metric: Metric, size: number, compare: Compare | null): RangeSeries {
  const length = Math.min(size, months.length);
  const start = months.length - length;
  const shift = compare === 'previousYear' ? 12 : length;
  const points = months.slice(start).map((m, i): SeriesPoint => {
    const before = compare ? months[start + i - shift] : undefined;
    return {
      month: m.month,
      value: m[metric] ?? undefined,
      compareMonth: before?.month,
      compareValue: before?.[metric] ?? undefined,
    };
  });
  const known = points.length > 0 && points.every((p) => p.value !== undefined);
  const comparable = compare !== null && points.length > 0 && points.every((p) => p.compareValue !== undefined);
  return {
    points,
    total: known ? sum(points.map((p) => p.value)) : null,
    compareTotal: comparable ? sum(points.map((p) => p.compareValue)) : null,
  };
}

/**
 * This calendar year so far, cumulative: January to December on the x axis,
 * the running total up to the current month, and last year's running total
 * for all twelve months, the way Stripe's "Today" chart runs to "now" against
 * a full day of yesterday.
 */
export function yearToDateSeries(months: TrendMonth[], metric: Metric): RangeSeries & { year: number; throughMonth: string | null } {
  const current = months[months.length - 1]?.month;
  if (!current) return { points: [], total: null, compareTotal: null, year: new Date().getFullYear(), throughMonth: null };
  const year = Number(current.slice(0, 4));
  const byMonth = new Map(months.map((m) => [m.month, m[metric]]));
  const key = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;

  let running: number | undefined = 0;
  let lastYearRunning: number | undefined = 0;
  const points: SeriesPoint[] = [];
  for (let m = 1; m <= 12; m++) {
    const month = key(year, m);
    const previous = key(year - 1, m);
    const value = byMonth.get(month);
    const lastYearValue = byMonth.get(previous);
    const inRange = month <= current;
    running = inRange && running !== undefined && value !== undefined && value !== null ? running + value : undefined;
    lastYearRunning =
      lastYearRunning !== undefined && lastYearValue !== undefined && lastYearValue !== null ? lastYearRunning + lastYearValue : undefined;
    points.push({
      month,
      value: inRange ? running : undefined,
      compareMonth: previous,
      compareValue: lastYearRunning,
    });
  }
  const now = points.find((p) => p.month === current);
  return {
    points,
    total: now?.value ?? null,
    // This month's point carries last year's running total up to the same month,
    // so the two figures cover the same stretch of the year.
    compareTotal: now?.compareValue ?? null,
    year,
    throughMonth: current,
  };
}

/** True when nothing is booked yet: every month is zero or unknown (or there are no months). */
export function isEmptyTrend(months: TrendMonth[]): boolean {
  return months.every((m) => !m.revenue && !m.expenses && !m.profit);
}

const monthKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

/** Busy spring and autumn, a quiet summer and December, by calendar month (January first). */
const SEASON = [0.92, 0.96, 1.05, 1.08, 1.04, 0.97, 0.82, 0.86, 1.06, 1.1, 1.08, 0.9];
const cents = (value: number) => Math.round(value * 100) / 100;

/**
 * Illustrative figures for books with nothing booked yet, so a new workspace
 * sees what its dashboard will look like: 24 months ending at `lastMonth`
 * (`YYYY-MM`), revenue growing about 2.5% a month with a seasonal swing,
 * expenses a fixed base plus about half of revenue, and a fixed wobble so the
 * lines read as booked rather than drawn. The same months always get the
 * same figures.
 */
export function sampleTrend(lastMonth: string): TrendMonth[] {
  const year = Number(lastMonth.slice(0, 4));
  const month = Number(lastMonth.slice(5, 7));
  return Array.from({ length: 24 }, (_, i) => {
    const date = new Date(year, month - 24 + i, 1);
    const revenue = cents(14_000 * 1.025 ** i * SEASON[date.getMonth()] * (1 + 0.06 * Math.sin(i * 2.7)));
    const expenses = cents(3_200 + revenue * 0.52 * (1 + 0.08 * Math.sin(i * 1.3)));
    return { month: monthKey(date), revenue, expenses, profit: cents(revenue - expenses) };
  });
}

/**
 * The months the charts draw: the ledger trend, or the sample trend (`sample`)
 * while nothing is booked, ending at the trend's last month or else this one.
 */
export function dashboardTrend(
  dashboard: Pick<Dashboard, 'monthlyTrend' | 'monthlyRevenue'>,
  now = new Date(),
): { months: TrendMonth[]; sample: boolean } {
  const months = trendMonths(dashboard);
  if (!isEmptyTrend(months)) return { months, sample: false };
  return { months: sampleTrend(months[months.length - 1]?.month ?? monthKey(now)), sample: true };
}

/** The smallest of 1, 2, 2.5 and 5 times a power of ten that is at least `value`. */
function niceStep(value: number): number {
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((f) => f * power >= value - 1e-9) ?? 10;
  return step * power;
}

/**
 * Round y-axis values (0, 10K, 20K, 30K) that take in `min` to `max` and zero:
 * 3 or 4 even steps (at most five labels in a card), whichever wastes the
 * least room above and below the data, 3 on a tie.
 * Nothing but zero gives just the zero line.
 */
export function niceTicks(min: number, max: number): number[] {
  const low = Math.min(0, min);
  const high = Math.max(0, max);
  if (high - low <= 0) return [0];
  const [best] = [3, 4]
    .map((intervals) => {
      const step = niceStep((high - low) / intervals);
      return { from: Math.floor(low / step) * step, to: Math.ceil(high / step) * step, step };
    })
    .sort((a, b) => a.to - a.from - (b.to - b.from));
  const count = Math.round((best.to - best.from) / best.step) + 1;
  // toPrecision drops float noise such as 0.30000000000000004.
  return Array.from({ length: count }, (_, i) => Number((best.from + i * best.step).toPrecision(12)));
}

/** Change from `previous` to `current` in percent; `null` when there is nothing to compare with. */
export function percentChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / Math.abs(previous)) * 100;
}
