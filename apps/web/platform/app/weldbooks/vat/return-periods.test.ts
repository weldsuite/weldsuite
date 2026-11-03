import { describe, expect, it } from 'vitest';
import { isWholePeriod, lastFinishedPeriod, monthNames, periodBounds, periodLabel } from './return-periods';

describe('periodBounds', () => {
  it('gives the first and last day of a month, quarter and year', () => {
    expect(periodBounds('monthly', { year: 2024, index: 1 })).toEqual({ start: '2024-02-01', end: '2024-02-29' });
    expect(periodBounds('quarterly', { year: 2026, index: 3 })).toEqual({ start: '2026-10-01', end: '2026-12-31' });
    expect(periodBounds('yearly', { year: 2026, index: 0 })).toEqual({ start: '2026-01-01', end: '2026-12-31' });
  });
});

describe('lastFinishedPeriod', () => {
  it('is the period before the one today falls in', () => {
    const today = new Date(2026, 10, 3); // 3 November 2026
    expect(lastFinishedPeriod('monthly', today)).toEqual({ year: 2026, index: 9 });
    expect(lastFinishedPeriod('quarterly', today)).toEqual({ year: 2026, index: 2 });
    expect(lastFinishedPeriod('yearly', today)).toEqual({ year: 2025, index: 0 });
  });

  it('goes back to the previous year in January', () => {
    const today = new Date(2027, 0, 15);
    expect(lastFinishedPeriod('monthly', today)).toEqual({ year: 2026, index: 11 });
    expect(lastFinishedPeriod('quarterly', today)).toEqual({ year: 2026, index: 3 });
  });
});

describe('periodLabel', () => {
  it('names the period', () => {
    expect(periodLabel('quarterly', { year: 2026, index: 3 }, 'en')).toBe('Q4 2026');
    expect(periodLabel('yearly', { year: 2026, index: 0 }, 'en')).toBe('2026');
    expect(periodLabel('monthly', { year: 2026, index: 9 }, 'en')).toBe('October 2026');
    expect(periodLabel('monthly', { year: 2026, index: 9 }, 'nl')).toBe('oktober 2026');
  });

  it('lists the month names in the language', () => {
    expect(monthNames('nl')[0]).toBe('januari');
    expect(monthNames('en')).toHaveLength(12);
  });
});

describe('isWholePeriod', () => {
  it('accepts exactly one month, quarter or year', () => {
    expect(isWholePeriod('monthly', '2026-02-01', '2026-02-28')).toBe(true);
    expect(isWholePeriod('quarterly', '2026-10-01', '2026-12-31')).toBe(true);
    expect(isWholePeriod('yearly', '2026-01-01', '2026-12-31')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isWholePeriod('quarterly', '2026-12-31', '2026-10-01')).toBe(false);
    expect(isWholePeriod('quarterly', '2026-11-01', '2027-01-31')).toBe(false);
    expect(isWholePeriod('quarterly', '2026-10-01', '2026-12-30')).toBe(false);
    expect(isWholePeriod('monthly', '2026-10-02', '2026-10-31')).toBe(false);
    expect(isWholePeriod('yearly', '2026-01-01', '2026-06-30')).toBe(false);
    expect(isWholePeriod('monthly', '', '')).toBe(false);
  });
});
