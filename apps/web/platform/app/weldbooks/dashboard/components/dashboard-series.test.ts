import { describe, expect, it } from 'vitest';
import {
  dashboardTrend,
  isEmptyTrend,
  niceTicks,
  percentChange,
  rangeSeries,
  sampleTrend,
  trendMonths,
  yearToDateSeries,
  type TrendMonth,
} from './dashboard-series';

/** 24 months ending October 2026, revenue = month index + 1, expenses = 1 each month. */
const months: TrendMonth[] = Array.from({ length: 24 }, (_, i) => {
  const date = new Date(Date.UTC(2024, 10 + i, 1));
  return { month: date.toISOString().slice(0, 7), revenue: i + 1, expenses: 1, profit: i };
});

describe('trendMonths', () => {
  it('falls back to 12 months of revenue with expenses and profit unknown', () => {
    const result = trendMonths({ monthlyRevenue: [{ month: '2026-10', total: '5.00' }] });
    expect(result).toEqual([{ month: '2026-10', revenue: 5, expenses: null, profit: null }]);
  });
});

describe('rangeSeries', () => {
  it('compares the last months with the months right before them', () => {
    const series = rangeSeries(months, 'revenue', 3, 'previousPeriod');
    expect(series.points.map((p) => p.month)).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(series.points.map((p) => p.compareMonth)).toEqual(['2026-05', '2026-06', '2026-07']);
    expect(series.total).toBe(22 + 23 + 24);
    expect(series.compareTotal).toBe(19 + 20 + 21);
  });

  it('compares with the same months a year earlier', () => {
    const series = rangeSeries(months, 'revenue', 12, 'previousYear');
    expect(series.points[0]).toMatchObject({ month: '2025-11', compareMonth: '2024-11', value: 13, compareValue: 1 });
    expect(series.compareTotal).toBe(78);
  });

  it('has no comparison when it is off or the data does not reach back', () => {
    expect(rangeSeries(months, 'revenue', 12, null).compareTotal).toBeNull();
    expect(rangeSeries(months.slice(-12), 'revenue', 12, 'previousPeriod').compareTotal).toBeNull();
  });

  it('has no total for a metric the API did not return', () => {
    const fallback = months.map((m) => ({ ...m, expenses: null }));
    expect(rangeSeries(fallback, 'expenses', 3, 'previousPeriod').total).toBeNull();
  });
});

describe('yearToDateSeries', () => {
  it('runs this year up to the current month against all of last year', () => {
    const series = yearToDateSeries(months, 'revenue');
    expect(series.year).toBe(2026);
    expect(series.points).toHaveLength(12);
    // January 2026 is index 14 (revenue 15); October 2026 index 23 (revenue 24).
    expect(series.points[0]).toMatchObject({ month: '2026-01', value: 15, compareMonth: '2025-01', compareValue: 3 });
    expect(series.total).toBe(15 + 16 + 17 + 18 + 19 + 20 + 21 + 22 + 23 + 24);
    expect(series.points[10].value).toBeUndefined();
    expect(series.points[11].compareValue).toBe(3 + 4 + 5 + 6 + 7 + 8 + 9 + 10 + 11 + 12 + 13 + 14);
    // Last year up to October, the same stretch as this year's total.
    expect(series.compareTotal).toBe(3 + 4 + 5 + 6 + 7 + 8 + 9 + 10 + 11 + 12);
  });

  it('has no comparison without last year in the data', () => {
    expect(yearToDateSeries(months.slice(-12), 'revenue').compareTotal).toBeNull();
  });
});

describe('dashboardTrend', () => {
  const zero = months.map((m) => ({ month: m.month, revenue: '0.00', expenses: '0.00', profit: '0.00' }));

  it('keeps the ledger trend once anything is booked', () => {
    const booked = zero.map((m, i) => (i === 5 ? { ...m, expenses: '12.50', profit: '-12.50' } : m));
    expect(isEmptyTrend(trendMonths({ monthlyTrend: booked, monthlyRevenue: [] }))).toBe(false);
    expect(dashboardTrend({ monthlyTrend: booked, monthlyRevenue: [] }).sample).toBe(false);
  });

  it('shows the sample trend over the same months while nothing is booked', () => {
    const trend = dashboardTrend({ monthlyTrend: zero, monthlyRevenue: [] });
    expect(trend.sample).toBe(true);
    expect(trend.months.map((m) => m.month)).toEqual(months.map((m) => m.month));
  });

  it('ends the sample trend at this month when the API returns no months', () => {
    const trend = dashboardTrend({ monthlyTrend: [], monthlyRevenue: [] }, new Date(2026, 0, 15));
    expect(trend.sample).toBe(true);
    expect(trend.months[0].month).toBe('2024-02');
    expect(trend.months[23].month).toBe('2026-01');
  });
});

describe('sampleTrend', () => {
  const sample = sampleTrend('2026-10');

  it('is the same every time, with every metric filled in and profit adding up', () => {
    expect(sampleTrend('2026-10')).toEqual(sample);
    expect(sample).toHaveLength(24);
    for (const m of sample) {
      expect(m.revenue).toBeGreaterThan(0);
      expect(m.expenses).toBeGreaterThan(0);
      expect(m.profit).toBeCloseTo(m.revenue - (m.expenses ?? 0), 2);
    }
  });

  it('grows year on year, so the comparisons have something to show', () => {
    const lastYear = rangeSeries(sample, 'revenue', 12, 'previousYear');
    expect(lastYear.total).toBeGreaterThan(lastYear.compareTotal ?? Infinity);
  });
});

describe('niceTicks', () => {
  it('puts round values over the data, from zero', () => {
    expect(niceTicks(0, 26_100)).toEqual([0, 10_000, 20_000, 30_000]);
    expect(niceTicks(0, 11_900)).toEqual([0, 5_000, 10_000, 15_000]);
    expect(niceTicks(0, 218_208)).toEqual([0, 100_000, 200_000, 300_000]);
    expect(niceTicks(0, 0.8)).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
  });

  it('reaches below zero for a loss, with zero still a tick', () => {
    const ticks = niceTicks(-4_000, 11_000);
    expect(ticks[0]).toBeLessThanOrEqual(-4_000);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(11_000);
    expect(ticks).toContain(0);
  });

  it('is just the zero line when there is nothing', () => {
    expect(niceTicks(0, 0)).toEqual([0]);
  });
});

describe('percentChange', () => {
  it('is relative to the previous value, and unknown from zero', () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(-50, -100)).toBe(50);
    expect(percentChange(5, 0)).toBeNull();
    expect(percentChange(0, 0)).toBe(0);
    expect(percentChange(5, null)).toBeNull();
  });
});
