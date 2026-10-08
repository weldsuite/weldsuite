import { describe, expect, it } from 'vitest';
import { fiscalYearContaining, fiscalYearFor, startMonthOfWeekYear, type WeekFiscalYearConfig } from './fiscal-year';

describe('month-based fiscal years', () => {
  it('runs the calendar year when it starts in January', () => {
    expect(fiscalYearFor({ type: 'month', startMonth: 1 }, 2026)).toEqual({
      year: 2026,
      start: '2026-01-01',
      end: '2026-12-31',
      weeks: null,
    });
  });

  it('names a July-June year for the year it ends in', () => {
    const fy = fiscalYearFor({ type: 'month', startMonth: 7 }, 2026);
    expect(fy.start).toBe('2025-07-01');
    expect(fy.end).toBe('2026-06-30');
  });

  it('finds the year that contains a date', () => {
    const config = { type: 'month', startMonth: 7 } as const;
    expect(fiscalYearContaining(config, '2026-06-30').year).toBe(2026);
    expect(fiscalYearContaining(config, '2026-07-01').year).toBe(2027);
  });
});

describe('52-53-week fiscal years', () => {
  const lastSunday: WeekFiscalYearConfig = { type: 'fifty_two_fifty_three', endMonth: 12, weekday: 0, rule: 'last' };

  it('ends on the last Sunday of December', () => {
    const fy = fiscalYearFor(lastSunday, 2026);
    expect(fy.end).toBe('2026-12-27');
    expect(fy.start).toBe('2025-12-29');
    expect(fy.weeks).toBe(52);
  });

  it('has 53 weeks when the end falls a week later', () => {
    // The last Sunday of December 2027 is the 26th, 2028's is the 31st: a 53-week FY2028.
    const fy = fiscalYearFor(lastSunday, 2028);
    expect(fy.end).toBe('2028-12-31');
    expect(fy.weeks).toBe(53);
  });

  it('uses the weekday nearest the end of the month with the nearest rule', () => {
    const nearestSaturday: WeekFiscalYearConfig = { type: 'fifty_two_fifty_three', endMonth: 12, weekday: 6, rule: 'nearest' };
    // 31 December 2026 is a Thursday: the nearest Saturday is 2 January 2027.
    expect(fiscalYearFor(nearestSaturday, 2026).end).toBe('2027-01-02');
  });

  it('finds the year of a date near the boundary', () => {
    expect(fiscalYearContaining(lastSunday, '2026-12-28').year).toBe(2027);
    expect(fiscalYearContaining(lastSunday, '2026-12-27').year).toBe(2026);
  });

  it('starts the month after the end month', () => {
    expect(startMonthOfWeekYear(lastSunday)).toBe(1);
    expect(startMonthOfWeekYear({ ...lastSunday, endMonth: 6 })).toBe(7);
  });
});
