import { describe, expect, it } from 'vitest';
import { percentChange, rangeSeries, trendMonths, yearToDateSeries, type TrendMonth } from './dashboard-series';

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

describe('percentChange', () => {
  it('is relative to the previous value, and unknown from zero', () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(-50, -100)).toBe(50);
    expect(percentChange(5, 0)).toBeNull();
    expect(percentChange(0, 0)).toBe(0);
    expect(percentChange(5, null)).toBeNull();
  });
});
