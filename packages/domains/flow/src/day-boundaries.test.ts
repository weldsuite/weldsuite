import { describe, expect, it } from 'vitest';
import { dayBoundsInTimezone } from './day-boundaries';

const iso = (date: Date) => date.toISOString();

describe('dayBoundsInTimezone', () => {
  it('cuts the day at UTC midnight for UTC', () => {
    const bounds = dayBoundsInTimezone('UTC', new Date('2031-03-12T15:30:00.000Z')); // a Wednesday
    expect(iso(bounds.startOfToday)).toBe('2031-03-12T00:00:00.000Z');
    expect(iso(bounds.startOfTomorrow)).toBe('2031-03-13T00:00:00.000Z');
    // Tomorrow is Thursday: this week runs up to the next Monday.
    expect(iso(bounds.startOfNextWeek)).toBe('2031-03-17T00:00:00.000Z');
  });

  it('uses the zone’s local midnight, ahead of UTC', () => {
    // 23:30Z on Mar 12 is already Mar 13, 00:30 in Amsterdam (UTC+1).
    const bounds = dayBoundsInTimezone('Europe/Amsterdam', new Date('2031-03-12T23:30:00.000Z'));
    expect(iso(bounds.startOfToday)).toBe('2031-03-12T23:00:00.000Z');
    expect(iso(bounds.startOfTomorrow)).toBe('2031-03-13T23:00:00.000Z');
  });

  it('uses the zone’s local midnight, behind UTC', () => {
    // 03:00Z on Mar 5 is still Mar 4, 22:00 in New York (UTC-5 before DST on Mar 9).
    const bounds = dayBoundsInTimezone('America/New_York', new Date('2031-03-05T03:00:00.000Z'));
    expect(iso(bounds.startOfToday)).toBe('2031-03-04T05:00:00.000Z');
    expect(iso(bounds.startOfTomorrow)).toBe('2031-03-05T05:00:00.000Z');
  });

  it('puts a task due at local midnight today into today, not overdue (UTC+2)', () => {
    const bounds = dayBoundsInTimezone('Europe/Amsterdam', new Date('2031-07-10T10:00:00.000Z')); // UTC+2
    const dueAtLocalMidnight = new Date('2031-07-09T22:00:00.000Z');
    expect(dueAtLocalMidnight.getTime()).toBeGreaterThanOrEqual(bounds.startOfToday.getTime());
    expect(dueAtLocalMidnight.getTime()).toBeLessThan(bounds.startOfTomorrow.getTime());
  });

  it('survives a DST change inside the week', () => {
    // Europe/Amsterdam springs forward on 2031-03-30. Sunday Mar 30 → next boundary is Monday Mar 31 00:00 local (UTC+2).
    const bounds = dayBoundsInTimezone('Europe/Amsterdam', new Date('2031-03-29T12:00:00.000Z')); // Saturday
    expect(iso(bounds.startOfToday)).toBe('2031-03-28T23:00:00.000Z');
    expect(iso(bounds.startOfTomorrow)).toBe('2031-03-29T23:00:00.000Z');
    expect(iso(bounds.startOfNextWeek)).toBe('2031-03-30T22:00:00.000Z');
  });

  it('week boundaries: Sunday rolls to the Monday 8 days out, Saturday to the Monday after', () => {
    const sunday = dayBoundsInTimezone('UTC', new Date('2031-03-16T10:00:00.000Z'));
    expect(iso(sunday.startOfNextWeek)).toBe('2031-03-24T00:00:00.000Z');
    const saturday = dayBoundsInTimezone('UTC', new Date('2031-03-15T10:00:00.000Z'));
    // Tomorrow is Sunday; the Monday after it is the 17th.
    expect(iso(saturday.startOfNextWeek)).toBe('2031-03-17T00:00:00.000Z');
  });

  it('falls back to UTC for a missing or unknown zone', () => {
    const now = new Date('2031-03-12T15:30:00.000Z');
    expect(iso(dayBoundsInTimezone(null, now).startOfToday)).toBe('2031-03-12T00:00:00.000Z');
    expect(iso(dayBoundsInTimezone('Not/AZone', now).startOfToday)).toBe('2031-03-12T00:00:00.000Z');
  });
});
