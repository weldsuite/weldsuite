import { describe, it, expect } from 'vitest';
import {
  defaultReportRange,
  fiscalPeriodOf,
  fiscalPeriods,
  fiscalYearConfigOf,
  fiscalYearFor,
  fiscalYearRange,
  isFiftyThreeWeekYear,
  priorPeriod,
  priorYear,
  type FiscalYearConfig,
} from './fiscal-year';

const calendar: FiscalYearConfig = { type: 'month', startMonth: 1 };
const july: FiscalYearConfig = { type: 'month', startMonth: 7 };
const lastSunday: FiscalYearConfig = { type: 'fifty_two_fifty_three', endMonth: 12, weekday: 0, rule: 'last' };
const nearestSaturday: FiscalYearConfig = { type: 'fifty_two_fifty_three', endMonth: 12, weekday: 6, rule: 'nearest' };

describe('month-based fiscal years', () => {
  it('uses the calendar year when the year starts in January', () => {
    expect(fiscalYearFor(calendar, 2026)).toEqual({ year: 2026, start: '2026-01-01', end: '2026-12-31', weeks: null });
    expect(fiscalYearRange(calendar, '2026-10-08').year).toBe(2026);
  });

  it('names a July-June year for the year it ends in', () => {
    expect(fiscalYearFor(july, 2026)).toEqual({ year: 2026, start: '2025-07-01', end: '2026-06-30', weeks: null });
    expect(fiscalYearRange(july, '2025-07-01').year).toBe(2026);
    expect(fiscalYearRange(july, '2026-06-30').year).toBe(2026);
    expect(fiscalYearRange(july, '2025-06-30').year).toBe(2025);
    expect(fiscalYearRange(july, '2026-07-01').year).toBe(2027);
  });

  it('covers a September start and a February end in a leap year', () => {
    expect(fiscalYearFor({ type: 'month', startMonth: 3 }, 2028)).toMatchObject({ start: '2027-03-01', end: '2028-02-29' });
  });

  it('builds twelve calendar months in quarters of three', () => {
    const periods = fiscalPeriods(july, 2026);
    expect(periods).toHaveLength(12);
    expect(periods[0]).toEqual({ number: 1, quarter: 1, start: '2025-07-01', end: '2025-07-31', weeks: null });
    expect(periods[7]).toEqual({ number: 8, quarter: 3, start: '2026-02-01', end: '2026-02-28', weeks: null });
    expect(periods[11]).toMatchObject({ number: 12, quarter: 4, end: '2026-06-30' });
    expect(isFiftyThreeWeekYear(july, 2026)).toBe(false);
  });

  it('reads the entity columns', () => {
    expect(fiscalYearConfigOf({ fiscalYearStart: 4, fiscalYearConfig: null })).toEqual({ type: 'month', startMonth: 4 });
    expect(fiscalYearConfigOf({})).toEqual({ type: 'month', startMonth: 1 });
    expect(fiscalYearConfigOf({ fiscalYearStart: 4, fiscalYearConfig: lastSunday })).toEqual(lastSunday);
  });
});

describe('52-53-week fiscal years', () => {
  it('ends on the last Sunday of December', () => {
    expect(fiscalYearFor(lastSunday, 2026)).toEqual({ year: 2026, start: '2025-12-29', end: '2026-12-27', weeks: 52 });
    expect(fiscalYearFor(lastSunday, 2027)).toMatchObject({ start: '2026-12-28', end: '2027-12-26', weeks: 52 });
  });

  it('adds a 53rd week when the last Sunday falls on 31 December', () => {
    expect(fiscalYearFor(lastSunday, 2028)).toEqual({ year: 2028, start: '2027-12-27', end: '2028-12-31', weeks: 53 });
    expect(isFiftyThreeWeekYear(lastSunday, 2028)).toBe(true);
    expect(isFiftyThreeWeekYear(lastSunday, 2027)).toBe(false);
  });

  it('ends on the Saturday nearest 31 December, which can be in January', () => {
    expect(fiscalYearFor(nearestSaturday, 2026)).toEqual({ year: 2026, start: '2026-01-04', end: '2027-01-02', weeks: 52 });
    expect(fiscalYearFor(nearestSaturday, 2025).end).toBe('2026-01-03');
    expect(fiscalYearFor(nearestSaturday, 2028).end).toBe('2028-12-30');
  });

  it('finds the year containing a date, including dates around the boundary', () => {
    expect(fiscalYearRange(lastSunday, '2025-12-28').year).toBe(2025);
    expect(fiscalYearRange(lastSunday, '2025-12-29').year).toBe(2026);
    expect(fiscalYearRange(lastSunday, '2026-12-27').year).toBe(2026);
    expect(fiscalYearRange(lastSunday, '2026-12-28').year).toBe(2027);
    expect(fiscalYearRange(nearestSaturday, '2026-01-02').year).toBe(2025);
    expect(fiscalYearRange(nearestSaturday, '2027-01-02').year).toBe(2026);
  });

  it('lays the periods out 4-4-5 and gives the extra week to the last period', () => {
    const periods = fiscalPeriods(lastSunday, 2026);
    expect(periods.map((period) => period.weeks)).toEqual([4, 4, 5, 4, 4, 5, 4, 4, 5, 4, 4, 5]);
    expect(periods[0]).toMatchObject({ start: '2025-12-29', end: '2026-01-25' });
    expect(periods[2]).toMatchObject({ start: '2026-02-23', end: '2026-03-29', quarter: 1 });
    expect(periods[11]).toMatchObject({ start: '2026-11-23', end: '2026-12-27', quarter: 4 });

    const leap = fiscalPeriods(lastSunday, 2028);
    expect(leap[11]).toMatchObject({ weeks: 6, start: '2028-11-20', end: '2028-12-31' });
    // contiguous, no gaps or overlaps
    for (let i = 1; i < leap.length; i += 1) {
      expect(leap[i]!.start > leap[i - 1]!.end).toBe(true);
    }
  });

  it('finds the period of a date', () => {
    expect(fiscalPeriodOf(lastSunday, '2026-10-08')).toMatchObject({ number: 10, quarter: 4, fiscalYear: 2026, start: '2026-09-28' });
    expect(fiscalPeriodOf(lastSunday, '2025-12-29')).toMatchObject({ number: 1, fiscalYear: 2026 });
  });
});

describe('defaultReportRange', () => {
  const today = '2026-10-08';

  it('uses calendar quarters and months for a calendar year', () => {
    expect(defaultReportRange(calendar, today, 'ytd')).toEqual({ start: '2026-01-01', end: today });
    expect(defaultReportRange(calendar, today, 'last_year')).toEqual({ start: '2025-01-01', end: '2025-12-31' });
    expect(defaultReportRange(calendar, today, 'this_quarter')).toEqual({ start: '2026-10-01', end: '2026-12-31' });
    expect(defaultReportRange(calendar, today, 'last_quarter')).toEqual({ start: '2026-07-01', end: '2026-09-30' });
    expect(defaultReportRange(calendar, today, 'this_month')).toEqual({ start: '2026-10-01', end: '2026-10-31' });
    expect(defaultReportRange(calendar, today, 'last_month')).toEqual({ start: '2026-09-01', end: '2026-09-30' });
  });

  it('reaches into the previous fiscal year at the start of a year', () => {
    expect(defaultReportRange(calendar, '2026-01-15', 'last_month')).toEqual({ start: '2025-12-01', end: '2025-12-31' });
    expect(defaultReportRange(calendar, '2026-01-15', 'last_quarter')).toEqual({ start: '2025-10-01', end: '2025-12-31' });
  });

  it('follows a July fiscal year', () => {
    expect(defaultReportRange(july, '2026-03-15', 'ytd')).toEqual({ start: '2025-07-01', end: '2026-03-15' });
    expect(defaultReportRange(july, '2026-03-15', 'this_quarter')).toEqual({ start: '2026-01-01', end: '2026-03-31' });
    expect(defaultReportRange(july, '2026-03-15', 'last_year')).toEqual({ start: '2024-07-01', end: '2025-06-30' });
    expect(defaultReportRange(july, '2026-07-02', 'last_quarter')).toEqual({ start: '2026-04-01', end: '2026-06-30' });
  });

  it('follows a 52-53-week year by period and quarter', () => {
    expect(defaultReportRange(lastSunday, today, 'ytd')).toEqual({ start: '2025-12-29', end: today });
    expect(defaultReportRange(lastSunday, today, 'this_month')).toEqual({ start: '2026-09-28', end: '2026-10-25' });
    expect(defaultReportRange(lastSunday, today, 'last_month')).toEqual({ start: '2026-08-24', end: '2026-09-27' });
    expect(defaultReportRange(lastSunday, today, 'this_quarter')).toEqual({ start: '2026-09-28', end: '2026-12-27' });
    expect(defaultReportRange(lastSunday, today, 'last_quarter')).toEqual({ start: '2026-06-29', end: '2026-09-27' });
    expect(defaultReportRange(lastSunday, today, 'last_year')).toEqual({ start: '2024-12-30', end: '2025-12-28' });
  });
});

describe('comparative ranges', () => {
  it('moves whole-month ranges back by their number of months', () => {
    expect(priorPeriod({ start: '2026-07-01', end: '2026-09-30' })).toEqual({ start: '2026-04-01', end: '2026-06-30' });
    expect(priorPeriod({ start: '2026-01-01', end: '2026-03-31' })).toEqual({ start: '2025-10-01', end: '2025-12-31' });
    expect(priorPeriod({ start: '2026-03-01', end: '2026-03-31' })).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(priorPeriod({ start: '2026-05-01', end: '2026-05-31' })).toEqual({ start: '2026-04-01', end: '2026-04-30' });
  });

  it('moves other ranges back by their length in days', () => {
    expect(priorPeriod({ start: '2026-03-10', end: '2026-03-20' })).toEqual({ start: '2026-02-27', end: '2026-03-09' });
    expect(priorPeriod({ start: '2026-09-28', end: '2026-10-25' })).toEqual({ start: '2026-08-31', end: '2026-09-27' });
  });

  it('moves ranges back a year', () => {
    expect(priorYear({ start: '2026-01-01', end: '2026-03-31' })).toEqual({ start: '2025-01-01', end: '2025-03-31' });
    expect(priorYear({ start: '2028-02-01', end: '2028-02-29' })).toEqual({ start: '2027-02-01', end: '2027-02-28' });
    expect(priorYear({ start: '2028-02-29', end: '2028-03-15' })).toEqual({ start: '2027-02-28', end: '2027-03-15' });
    expect(priorYear({ start: '2026-01-01', end: '2026-10-08' })).toEqual({ start: '2025-01-01', end: '2025-10-08' });
  });

  it('moves 52-53-week ranges back 52 weeks so weekdays line up', () => {
    expect(priorYear({ start: '2026-09-28', end: '2026-10-25' }, lastSunday)).toEqual({ start: '2025-09-29', end: '2025-10-26' });
  });
});
