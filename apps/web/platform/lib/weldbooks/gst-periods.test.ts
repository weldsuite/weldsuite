import { describe, expect, it } from 'vitest';
import { isValidPeriod, monthPeriod, previousMonthPeriod, quarterPeriod } from './gst-periods';

describe('gst periods', () => {
  it('takes the calendar month of a date', () => {
    expect(monthPeriod('2026-10-12')).toEqual({ periodStart: '2026-10-01', periodEnd: '2026-10-31' });
    expect(monthPeriod('2028-02-10')).toEqual({ periodStart: '2028-02-01', periodEnd: '2028-02-29' });
  });

  it('takes the month before, across a year end', () => {
    expect(previousMonthPeriod('2026-10-12')).toEqual({ periodStart: '2026-09-01', periodEnd: '2026-09-30' });
    expect(previousMonthPeriod('2026-01-05')).toEqual({ periodStart: '2025-12-01', periodEnd: '2025-12-31' });
  });

  it('takes the calendar quarter', () => {
    expect(quarterPeriod('2026-05-20')).toEqual({ periodStart: '2026-04-01', periodEnd: '2026-06-30' });
    expect(quarterPeriod('2026-12-31')).toEqual({ periodStart: '2026-10-01', periodEnd: '2026-12-31' });
  });

  it('accepts only two valid dates in order', () => {
    expect(isValidPeriod({ periodStart: '2026-10-01', periodEnd: '2026-10-31' })).toBe(true);
    expect(isValidPeriod({ periodStart: '2026-10-31', periodEnd: '2026-10-01' })).toBe(false);
    expect(isValidPeriod({ periodStart: '', periodEnd: '2026-10-01' })).toBe(false);
  });
});
