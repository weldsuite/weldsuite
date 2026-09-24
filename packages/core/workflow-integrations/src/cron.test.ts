import { describe, it, expect } from 'vitest';
import { cronMatchesNow, cronMatchesAt, computeNextRunAt } from './cron';

describe('cronMatchesAt / cronMatchesNow', () => {
  // Thursday 2026-07-09 14:32:00 UTC
  const now = new Date(Date.UTC(2026, 6, 9, 14, 32, 0));
  const weekday = now.getUTCDay();

  it('matches "* * * * *" always', () => {
    expect(cronMatchesNow('* * * * *', 'UTC', now)).toBe(true);
  });

  it('matches an exact minute + hour', () => {
    expect(cronMatchesAt('32 14 * * *', 'UTC', now)).toBe(true);
  });

  it('does not match a different minute or hour', () => {
    expect(cronMatchesAt('0 14 * * *', 'UTC', now)).toBe(false);
    expect(cronMatchesAt('32 9 * * *', 'UTC', now)).toBe(false);
  });

  it('handles step values (*/n)', () => {
    expect(cronMatchesAt('*/16 * * * *', 'UTC', now)).toBe(true); // 32 % 16 === 0
    expect(cronMatchesAt('*/15 * * * *', 'UTC', now)).toBe(false); // 32 % 15 !== 0
  });

  it('handles comma lists and ranges', () => {
    expect(cronMatchesAt('0,15,32,45 * * * *', 'UTC', now)).toBe(true);
    expect(cronMatchesAt('0,15,45 * * * *', 'UTC', now)).toBe(false);
    expect(cronMatchesAt('30-40 * * * *', 'UTC', now)).toBe(true);
    expect(cronMatchesAt('0-30 * * * *', 'UTC', now)).toBe(false);
  });

  it('matches the current day-of-week', () => {
    expect(cronMatchesAt(`* * * * ${weekday}`, 'UTC', now)).toBe(true);
    expect(cronMatchesAt(`* * * * ${(weekday + 1) % 7}`, 'UTC', now)).toBe(false);
  });

  it('evaluates in the schedule timezone, not UTC', () => {
    // Etc/GMT+5 is fixed UTC-5: 14:32 UTC -> 09:32 local.
    expect(cronMatchesAt('32 9 * * *', 'Etc/GMT+5', now)).toBe(true);
    expect(cronMatchesAt('32 14 * * *', 'Etc/GMT+5', now)).toBe(false);
    // Etc/GMT-9 is fixed UTC+9: 14:32 UTC -> 23:32 local.
    expect(cronMatchesAt('32 23 * * *', 'Etc/GMT-9', now)).toBe(true);
  });

  it('returns false for a malformed cron instead of throwing', () => {
    expect(cronMatchesAt('not a cron', 'UTC', now)).toBe(false);
  });
});

describe('computeNextRunAt', () => {
  it('returns the next matching minute strictly after `from`', () => {
    const from = new Date(Date.UTC(2026, 6, 9, 14, 32, 30));
    // every minute -> next whole minute is 14:33:00
    const next = computeNextRunAt('* * * * *', 'UTC', from);
    expect(next?.toISOString()).toBe('2026-07-09T14:33:00.000Z');
  });

  it('never returns `from`\'s own minute even on a minute boundary', () => {
    const from = new Date(Date.UTC(2026, 6, 9, 14, 32, 0));
    const next = computeNextRunAt('* * * * *', 'UTC', from);
    expect(next?.toISOString()).toBe('2026-07-09T14:33:00.000Z');
  });

  it('finds a daily time later today', () => {
    const from = new Date(Date.UTC(2026, 6, 9, 8, 0, 0));
    const next = computeNextRunAt('0 9 * * *', 'UTC', from);
    expect(next?.toISOString()).toBe('2026-07-09T09:00:00.000Z');
  });

  it('rolls a daily time to tomorrow when today\'s has passed', () => {
    const from = new Date(Date.UTC(2026, 6, 9, 10, 0, 0));
    const next = computeNextRunAt('0 9 * * *', 'UTC', from);
    expect(next?.toISOString()).toBe('2026-07-10T09:00:00.000Z');
  });

  it('computes in the schedule timezone', () => {
    // 09:00 in Etc/GMT+5 (UTC-5) == 14:00 UTC.
    const from = new Date(Date.UTC(2026, 6, 9, 0, 0, 0));
    const next = computeNextRunAt('0 9 * * *', 'Etc/GMT+5', from);
    expect(next?.toISOString()).toBe('2026-07-09T14:00:00.000Z');
  });

  it('honours startDate (does not fire before it)', () => {
    const from = new Date(Date.UTC(2026, 6, 9, 8, 0, 0));
    const startDate = new Date(Date.UTC(2026, 6, 12, 0, 0, 0));
    const next = computeNextRunAt('0 9 * * *', 'UTC', from, { startDate });
    expect(next?.toISOString()).toBe('2026-07-12T09:00:00.000Z');
  });

  it('returns null when endDate has passed', () => {
    const from = new Date(Date.UTC(2026, 6, 9, 10, 0, 0));
    const endDate = new Date(Date.UTC(2026, 6, 9, 9, 30, 0));
    expect(computeNextRunAt('0 9 * * *', 'UTC', from, { endDate })).toBeNull();
  });

  it('returns null for a malformed cron', () => {
    expect(computeNextRunAt('nope', 'UTC', new Date())).toBeNull();
  });
});
