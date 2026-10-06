import { describe, expect, it } from 'vitest';
import { isValidCronExpression, nextCronRun } from './cron';

describe('isValidCronExpression', () => {
  it.each(['0 9 * * *', '*/5 * * * *', '0 9 * * 1-5', '0,30 8-18 1 * 0', ' 0 9 * * * '])(
    'accepts %s',
    (expression) => {
      expect(isValidCronExpression(expression)).toBe(true);
    },
  );

  it.each([
    'banana every day', // the QA case: stored as typed, never fired
    '0 9 * *', // four fields
    '0 9 * * * *', // six fields
    '60 9 * * *', // minute out of range
    '0 24 * * *', // hour out of range
    '0 9 0 * *', // day of month starts at 1
    '0 9 * * 7', // weekday is 0-6
    '0 9 * * 5-1', // reversed range
    '*/0 * * * *', // zero step
    '0 9 * * MON', // names are not supported by the sweep
  ])('rejects %s', (expression) => {
    expect(isValidCronExpression(expression)).toBe(false);
  });
});

describe('nextCronRun', () => {
  it('returns the next matching minute, strictly after `from`', () => {
    const from = new Date('2026-10-05T20:44:20.878Z');
    expect(nextCronRun('*/2 * * * *', 'UTC', from)?.toISOString()).toBe('2026-10-05T20:46:00.000Z');
    // `from` sits exactly on a slot: that slot has passed.
    expect(nextCronRun('*/2 * * * *', 'UTC', new Date('2026-10-05T20:44:00.000Z'))?.toISOString()).toBe(
      '2026-10-05T20:46:00.000Z',
    );
  });

  it('evaluates the expression in the schedule timezone', () => {
    // 09:00 in Amsterdam is 07:00 UTC during summer time.
    const from = new Date('2026-10-05T12:00:00.000Z');
    expect(nextCronRun('0 9 * * *', 'Europe/Amsterdam', from)?.toISOString()).toBe('2026-10-06T07:00:00.000Z');
    expect(nextCronRun('0 9 * * *', 'UTC', from)?.toISOString()).toBe('2026-10-06T09:00:00.000Z');
  });

  it('handles weekday and day-of-month fields', () => {
    // 2026-10-05 is a Monday; the next Friday is the 9th.
    const from = new Date('2026-10-05T12:00:00.000Z');
    expect(nextCronRun('30 8 * * 5', 'UTC', from)?.toISOString()).toBe('2026-10-09T08:30:00.000Z');
    expect(nextCronRun('0 0 1 * *', 'UTC', from)?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('finds minute slots in a timezone with a 45-minute offset', () => {
    // Asia/Kathmandu is UTC+5:45, so local 09:00 is 03:15 UTC.
    const from = new Date('2026-10-05T12:00:00.000Z');
    expect(nextCronRun('0 9 * * *', 'Asia/Kathmandu', from)?.toISOString()).toBe('2026-10-06T03:15:00.000Z');
  });

  it('returns null for an invalid expression, an unknown timezone, or a date that never comes', () => {
    const from = new Date('2026-10-05T12:00:00.000Z');
    expect(nextCronRun('banana every day', 'UTC', from)).toBeNull();
    expect(nextCronRun('0 9 * * *', 'Not/AZone', from)).toBeNull();
    expect(nextCronRun('0 0 31 2 *', 'UTC', from)).toBeNull();
  });
});
