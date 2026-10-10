import { describe, expect, it } from 'vitest';
import { ageOn, nextPeriodToRun, periodContaining, weekdaysBetween, type PayScheduleSpec } from './periods';

const nlMonthly: PayScheduleSpec = { frequency: 'monthly', anchorDate: '2026-01-01', payDateRule: { kind: 'day_of_month', day: 25 } };

describe('pay periods', () => {
  it('monthly NL periods are calendar months paid on the 25th, moved off weekends', () => {
    const p = periodContaining(nlMonthly, 'NL', '2026-04-10');
    expect(p).toMatchObject({ start: '2026-04-01', end: '2026-04-30', taxYear: 2026, periodNumber: 4, periodsPerYear: 12 });
    // 25 April 2026 is a Saturday.
    expect(p.payDate).toBe('2026-04-24');
  });

  it('runs the next period after the last one, across the year boundary', () => {
    const next = nextPeriodToRun(nlMonthly, 'NL', { start: '2026-12-01', end: '2026-12-31' });
    expect(next).toMatchObject({ start: '2027-01-01', end: '2027-01-31', taxYear: 2027, periodNumber: 1 });
  });

  it('biweekly US periods count from the anchor and take the pay date year as tax year', () => {
    const spec: PayScheduleSpec = { frequency: 'biweekly', anchorDate: '2025-12-21', payDateRule: { kind: 'offset_after_end', days: 5 } };
    const first = periodContaining(spec, 'US', '2025-12-25');
    expect(first).toMatchObject({ start: '2025-12-21', end: '2026-01-03', payDate: '2026-01-08', taxYear: 2026, periodNumber: 1, periodsPerYear: 26 });
    const second = nextPeriodToRun(spec, 'US', first);
    expect(second).toMatchObject({ start: '2026-01-04', end: '2026-01-17', periodNumber: 2 });
  });

  it('semimonthly periods split the month on the 15th', () => {
    const spec: PayScheduleSpec = { frequency: 'semimonthly', anchorDate: '2026-01-01', payDateRule: { kind: 'day_of_month', day: 15 } };
    expect(periodContaining(spec, 'US', '2026-02-20')).toMatchObject({ start: '2026-02-16', end: '2026-02-28', periodNumber: 4 });
  });

  it('counts weekdays and ages', () => {
    expect(weekdaysBetween('2026-06-01', '2026-06-30')).toBe(22);
    expect(ageOn('1959-07-15', '2026-07-14')).toBe(66);
    expect(ageOn('1959-07-15', '2026-07-15')).toBe(67);
  });
});
