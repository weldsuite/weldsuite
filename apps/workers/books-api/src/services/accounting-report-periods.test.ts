import { describe, expect, it } from 'vitest';
import { ReportInputError } from './accounting-reports-basis';
import {
  fiscalYearContaining,
  fiscalYearNamed,
  parseCompare,
  parsePeriods,
  periodColumns,
  pointInTimeColumns,
  requireIsoDate,
  resolvePeriod,
  splitColumns,
  todayFor,
} from './accounting-report-periods';

const calendar = { fiscalYearStart: 1, fiscalYearConfig: null, timezone: 'America/Chicago' };
const july = { fiscalYearStart: 7, fiscalYearConfig: null, timezone: 'America/Los_Angeles' };
/** Ends on the last Saturday of June. */
const weeks = {
  fiscalYearStart: 7,
  fiscalYearConfig: { type: 'fifty_two_fifty_three' as const, endMonth: 6, weekday: 6, rule: 'last' as const },
  timezone: 'America/New_York',
};

describe('fiscal years', () => {
  it('finds the year around a date, month-based or in weeks', () => {
    expect(fiscalYearContaining(calendar, '2026-02-10')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(fiscalYearContaining(july, '2026-02-10')).toEqual({ from: '2025-07-01', to: '2026-06-30' });
    expect(fiscalYearContaining(july, '2026-07-01')).toEqual({ from: '2026-07-01', to: '2027-06-30' });
    expect(fiscalYearContaining(weeks, '2026-02-10')).toEqual({ from: '2025-06-29', to: '2026-06-27' });
  });

  it('names a year for the calendar year it ends in', () => {
    expect(fiscalYearNamed(july, 2026)).toEqual({ from: '2025-07-01', to: '2026-06-30' });
    expect(fiscalYearNamed(calendar, 2026)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });

  it('a 53-week year ends a week later', () => {
    // last Saturday of June: 2029 ends 30 June, 2028 on 24 June, so FY2029 has 53 weeks
    const range = fiscalYearNamed(weeks, 2029);
    expect(range).toEqual({ from: '2028-06-25', to: '2029-06-30' });
  });

  it('today is the date in the entity time zone', () => {
    const now = new Date('2026-07-01T03:00:00Z');
    expect(todayFor({ timezone: 'America/Los_Angeles' }, now)).toBe('2026-06-30');
    expect(todayFor({ timezone: 'Europe/Amsterdam' }, now)).toBe('2026-07-01');
    expect(todayFor({ timezone: null }, now)).toBe('2026-07-01');
    expect(todayFor({ timezone: 'Not/AZone' }, now)).toBe('2026-07-01');
  });
});

describe('resolvePeriod', () => {
  it('uses explicit dates, today for a missing end and the fiscal year start for a missing start', () => {
    expect(resolvePeriod(july, { from: '2026-03-01', to: '2026-03-31' }, '2026-10-08')).toEqual({ from: '2026-03-01', to: '2026-03-31' });
    expect(resolvePeriod(july, {}, '2026-10-08')).toEqual({ from: '2026-07-01', to: '2026-10-08' });
    expect(resolvePeriod(july, { to: '2026-02-10' }, '2026-10-08')).toEqual({ from: '2025-07-01', to: '2026-02-10' });
    expect(resolvePeriod(calendar, { from: '2026-05-01' }, '2026-10-08')).toEqual({ from: '2026-05-01', to: '2026-10-08' });
  });

  it('refuses dates that are not dates, and a start after the end', () => {
    expect(() => resolvePeriod(calendar, { from: '2026-02-30' })).toThrow(ReportInputError);
    expect(() => resolvePeriod(calendar, { from: '2026-05-02', to: '2026-05-01' })).toThrow('from must be on or before to');
    expect(requireIsoDate('2026-05-01T10:00:00Z', 'from')).toBe('2026-05-01');
  });
});

describe('columns', () => {
  it('compares with the previous period or the same dates a year earlier', () => {
    const march = { from: '2026-03-01', to: '2026-03-31' };
    expect(periodColumns(calendar, march, null).map((c) => c.key)).toEqual(['current']);
    expect(periodColumns(calendar, march, 'prior_period')[1]).toMatchObject({ key: 'prior', from: '2026-02-01', to: '2026-02-28' });
    expect(periodColumns(calendar, march, 'prior_year')[1]).toMatchObject({ from: '2025-03-01', to: '2025-03-31' });
    // a quarter compares with the quarter before it
    expect(periodColumns(calendar, { from: '2026-04-01', to: '2026-06-30' }, 'prior_period')[1]).toMatchObject({ from: '2026-01-01', to: '2026-03-31' });
    // comparable weeks in a 52–53-week year
    expect(periodColumns(weeks, { from: '2026-01-04', to: '2026-01-31' }, 'prior_year')[1]).toMatchObject({ from: '2025-01-05', to: '2025-02-01' });
  });

  it('point-in-time columns step back a month, to the period start, or a year', () => {
    expect(pointInTimeColumns('2026-07-31', 'prior_period', null)[1].to).toBe('2026-06-30');
    expect(pointInTimeColumns('2026-07-15', 'prior_period', null)[1].to).toBe('2026-06-15');
    expect(pointInTimeColumns('2026-07-31', 'prior_period', '2026-07-01')[1].to).toBe('2026-06-30');
    expect(pointInTimeColumns('2026-02-28', 'prior_year', null)[1].to).toBe('2025-02-28');
    expect(pointInTimeColumns('2026-07-31', null, null)).toHaveLength(1);
  });

  it('months clip to the range and end with a total', () => {
    const columns = splitColumns(calendar, { from: '2026-01-15', to: '2026-03-10' }, 'months');
    expect(columns.map((c) => [c.key, c.from, c.to])).toEqual([
      ['2026-01', '2026-01-15', '2026-01-31'],
      ['2026-02', '2026-02-01', '2026-02-28'],
      ['2026-03', '2026-03-01', '2026-03-10'],
      ['total', '2026-01-15', '2026-03-10'],
    ]);
  });

  it('quarters follow the fiscal year start', () => {
    const columns = splitColumns(july, { from: '2026-07-01', to: '2027-06-30' }, 'quarters');
    expect(columns.map((c) => [c.from, c.to])).toEqual([
      ['2026-07-01', '2026-09-30'],
      ['2026-10-01', '2026-12-31'],
      ['2027-01-01', '2027-03-31'],
      ['2027-04-01', '2027-06-30'],
      ['2026-07-01', '2027-06-30'],
    ]);
    expect(() => splitColumns(calendar, { from: '2000-01-01', to: '2026-12-31' }, 'months')).toThrow(ReportInputError);
  });

  it('a 52–53-week year splits into 4-4-5 week periods and 13-week quarters', () => {
    const year = { from: '2025-06-29', to: '2026-06-27' };
    const periods = splitColumns(weeks, year, 'months');
    expect(periods).toHaveLength(13);
    expect(periods.slice(0, 3).map((c) => [c.key, c.from, c.to])).toEqual([
      ['2026-P01', '2025-06-29', '2025-07-26'],
      ['2026-P02', '2025-07-27', '2025-08-23'],
      ['2026-P03', '2025-08-24', '2025-09-27'],
    ]);
    const quarters = splitColumns(weeks, year, 'quarters');
    expect(quarters.map((c) => c.key)).toEqual(['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4', 'total']);
    expect(quarters[0]).toMatchObject({ from: '2025-06-29', to: '2025-09-27' });
    expect(quarters[3].to).toBe('2026-06-27');
  });

  it('parses the query values', () => {
    expect(parseCompare(undefined)).toBeNull();
    expect(parseCompare('prior_year')).toBe('prior_year');
    expect(() => parseCompare('last_year')).toThrow(ReportInputError);
    expect(parsePeriods('quarters')).toBe('quarters');
    expect(() => parsePeriods('weeks')).toThrow(ReportInputError);
  });
});
