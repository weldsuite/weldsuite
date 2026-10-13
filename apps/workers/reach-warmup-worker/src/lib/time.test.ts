import { describe, expect, it } from 'vitest';
import {
  businessWindow,
  businessWindowOn,
  intoBusinessHours,
  localDate,
  localParts,
  nextBusinessDate,
  safeTimeZone,
  zonedTimeToUtc,
} from './time';

const AMS = 'Europe/Amsterdam';
const NY = 'America/New_York';

describe('local time', () => {
  it('reads the local date and weekday in a zone', () => {
    // 23:30 UTC on Monday 12 Oct 2026 is 01:30 on Tuesday in Amsterdam (CEST, +2).
    const at = new Date('2026-10-12T23:30:00Z');
    expect(localDate(at, 'UTC')).toBe('2026-10-12');
    expect(localDate(at, AMS)).toBe('2026-10-13');
    expect(localParts(at, AMS)).toMatchObject({ weekday: 2, hour: 1, minute: 30 });
    expect(localDate(at, NY)).toBe('2026-10-12');
  });

  it('falls back to the default zone for an invalid one', () => {
    expect(safeTimeZone('Not/AZone')).toBe(AMS);
    expect(localDate(new Date('2026-10-12T23:30:00Z'), 'Not/AZone')).toBe('2026-10-13');
  });

  it('converts a wall-clock time to UTC, across DST', () => {
    expect(zonedTimeToUtc('2026-10-12', 9 * 60, AMS).toISOString()).toBe('2026-10-12T07:00:00.000Z'); // CEST
    expect(zonedTimeToUtc('2026-12-14', 9 * 60, AMS).toISOString()).toBe('2026-12-14T08:00:00.000Z'); // CET
    expect(zonedTimeToUtc('2026-10-12', 9 * 60, NY).toISOString()).toBe('2026-10-12T13:00:00.000Z'); // EDT
    expect(zonedTimeToUtc('2026-12-14', 9 * 60, NY).toISOString()).toBe('2026-12-14T14:00:00.000Z'); // EST
  });

  it('handles the day Europe falls back (25-hour day)', () => {
    // 25 Oct 2026: clocks go back at 03:00 CEST. 09:00 is already CET (+1).
    expect(zonedTimeToUtc('2026-10-25', 9 * 60, AMS).toISOString()).toBe('2026-10-25T08:00:00.000Z');
  });
});

describe('business hours', () => {
  it('is 09:00-17:30 local on a weekday', () => {
    const window = businessWindow(new Date('2026-10-13T05:00:00Z'), AMS); // Tuesday
    expect(window.businessDay).toBe(true);
    expect(window.date).toBe('2026-10-13');
    expect(window.start.toISOString()).toBe('2026-10-13T07:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-10-13T15:30:00.000Z');
  });

  it('is not a business day on a weekend', () => {
    expect(businessWindowOn('2026-10-17', AMS).businessDay).toBe(false); // Saturday
    expect(businessWindowOn('2026-10-18', AMS).businessDay).toBe(false); // Sunday
    expect(businessWindowOn('2026-10-19', AMS).businessDay).toBe(true); // Monday
  });

  it('finds the next business day, skipping the weekend', () => {
    expect(nextBusinessDate('2026-10-15')).toBe('2026-10-16');
    expect(nextBusinessDate('2026-10-16')).toBe('2026-10-19');
    expect(nextBusinessDate('2026-10-17')).toBe('2026-10-19');
  });

  describe('intoBusinessHours', () => {
    const zero = () => 0;
    const half = () => 0.5;

    it('leaves a time inside the window alone', () => {
      const at = new Date('2026-10-13T10:00:00Z');
      expect(intoBusinessHours(at, AMS, zero)).toBe(at);
    });

    it('moves an early-morning time to the opening, plus up to 90 minutes', () => {
      const at = new Date('2026-10-13T03:00:00Z'); // 05:00 Amsterdam
      expect(intoBusinessHours(at, AMS, zero).toISOString()).toBe('2026-10-13T07:00:00.000Z');
      expect(intoBusinessHours(at, AMS, half).toISOString()).toBe('2026-10-13T07:45:00.000Z');
    });

    it('moves an evening time to the next morning', () => {
      const at = new Date('2026-10-13T16:00:00Z'); // 18:00 Amsterdam, Tuesday
      expect(intoBusinessHours(at, AMS, zero).toISOString()).toBe('2026-10-14T07:00:00.000Z');
    });

    it('moves a Friday evening to Monday morning', () => {
      const at = new Date('2026-10-16T16:00:00Z'); // Friday 18:00 Amsterdam
      expect(intoBusinessHours(at, AMS, zero).toISOString()).toBe('2026-10-19T07:00:00.000Z');
    });

    it('moves a Saturday time to Monday morning', () => {
      const at = new Date('2026-10-17T10:00:00Z');
      expect(intoBusinessHours(at, AMS, zero).toISOString()).toBe('2026-10-19T07:00:00.000Z');
    });
  });
});
