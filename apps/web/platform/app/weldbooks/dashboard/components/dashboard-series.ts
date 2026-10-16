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

/** Change from `previous` to `current` in percent; `null` when there is nothing to compare with. */
export function percentChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / Math.abs(previous)) * 100;
}
