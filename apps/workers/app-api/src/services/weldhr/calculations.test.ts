/**
 * The WeldHR numbers people will argue about: weighted evaluation scores,
 * working days in a leave request, worked and late minutes.
 */

import { describe, expect, it } from 'vitest';
import { overallScore } from './performance';
import { addDays, assertDateOrder, HrValidationError, workingDaysBetween } from './shared';
import { lateMinutesFor, workedMinutes } from './time';

describe('overallScore', () => {
  const criteria = [
    { id: 'quality', label: 'Quality', weight: 30, maxScore: 5 },
    { id: 'speed', label: 'Speed', weight: 10, maxScore: 10 },
  ];

  it('is the weighted mean of each criterion as a percentage of its max', () => {
    // quality 4/5 = 80% × 30, speed 5/10 = 50% × 10 → (2400 + 500) / 40 = 72.5
    expect(overallScore(criteria, [
      { criterionId: 'quality', score: 4 },
      { criterionId: 'speed', score: 5 },
    ])).toBe(72.5);
  });

  it('ignores unscored criteria instead of counting them as zero', () => {
    expect(overallScore(criteria, [{ criterionId: 'quality', score: 5 }])).toBe(100);
  });

  it('is null until something is scored', () => {
    expect(overallScore(criteria, [])).toBeNull();
  });

  it('caps a score at the criterion max', () => {
    expect(overallScore(criteria, [{ criterionId: 'quality', score: 9 }])).toBe(100);
  });

  it('skips zero-weight criteria', () => {
    const withZero = [...criteria, { id: 'extra', label: 'Extra', weight: 0, maxScore: 5 }];
    expect(overallScore(withZero, [
      { criterionId: 'quality', score: 5 },
      { criterionId: 'extra', score: 0 },
    ])).toBe(100);
  });
});

describe('workingDaysBetween', () => {
  it('counts Monday to Friday inclusive', () => {
    // 2026-09-21 is a Monday.
    expect(workingDaysBetween('2026-09-21', '2026-09-25')).toBe(5);
  });

  it('skips the weekend', () => {
    expect(workingDaysBetween('2026-09-25', '2026-09-28')).toBe(2);
    expect(workingDaysBetween('2026-09-26', '2026-09-27')).toBe(0);
  });

  it('is zero for a reversed range', () => {
    expect(workingDaysBetween('2026-09-25', '2026-09-21')).toBe(0);
  });
});

describe('dates', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('rejects an end before the start', () => {
    expect(() => assertDateOrder('2026-09-10', '2026-09-01', 'Leave')).toThrow(HrValidationError);
    expect(() => assertDateOrder('2026-09-01', null, 'Leave')).not.toThrow();
  });
});

describe('attendance minutes', () => {
  const at = (hhmm: string) => new Date(`2026-09-23T${hhmm}:00Z`);

  it('subtracts breaks from worked time', () => {
    expect(workedMinutes(at('09:00'), at('17:30'), 30)).toBe(480);
  });

  it('has no worked time while still clocked in', () => {
    expect(workedMinutes(at('09:00'), null, 0)).toBeNull();
  });

  it('never goes negative', () => {
    expect(workedMinutes(at('09:00'), at('09:10'), 30)).toBe(0);
  });

  it('allows a five-minute grace period before counting late', () => {
    expect(lateMinutesFor(at('09:05'), at('09:00'))).toBe(0);
    expect(lateMinutesFor(at('09:06'), at('09:00'))).toBe(6);
  });

  it('is never late without a shift', () => {
    expect(lateMinutesFor(at('11:00'), null)).toBe(0);
  });
});
