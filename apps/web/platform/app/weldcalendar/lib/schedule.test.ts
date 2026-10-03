import { describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/queries/use-settings-queries', () => ({ useUserPreferences: () => ({ data: undefined }) }));

import { formatEventTimeRange, formatScheduleTime, getDateGroup } from './schedule';

// Today: Sat 3 Oct 2026 (the week runs Mon 28 Sep - Sun 4 Oct).
const now = new Date(2026, 9, 3, 14, 30);
const day = (month: number, d: number, h = 12, m = 0) => new Date(2026, month, d, h, m);

describe('getDateGroup', () => {
  it('names yesterday, today and tomorrow first', () => {
    expect(getDateGroup(day(9, 2), now)).toBe('yesterday');
    expect(getDateGroup(day(9, 3, 0, 0), now)).toBe('today');
    expect(getDateGroup(day(9, 3, 23, 59), now)).toBe('today');
    expect(getDateGroup(day(9, 4, 0, 0), now)).toBe('tomorrow');
  });

  it('keeps the rest of the current Monday-Sunday week as this week', () => {
    const wednesday = new Date(2026, 9, 7, 10);
    expect(getDateGroup(new Date(2026, 9, 9, 10), wednesday)).toBe('this_week');
    expect(getDateGroup(new Date(2026, 9, 11, 23, 59, 59), wednesday)).toBe('this_week');
    expect(getDateGroup(new Date(2026, 9, 5, 8), wednesday)).toBe('this_week');
  });

  it('puts next week Monday 00:00 through Sunday in next week', () => {
    // now is Sat 3 Oct: next week is Mon 5 Oct - Sun 11 Oct.
    expect(getDateGroup(day(9, 5, 0, 0), now)).toBe('next_week');
    expect(getDateGroup(day(9, 5, 9), now)).toBe('next_week');
    expect(getDateGroup(new Date(2026, 9, 11, 23, 59, 59), now)).toBe('next_week');
  });

  it('puts the day after next week into this month, or later when in another month', () => {
    expect(getDateGroup(day(9, 12), now)).toBe('this_month');
    expect(getDateGroup(day(9, 31), now)).toBe('this_month');
    expect(getDateGroup(day(10, 1), now)).toBe('later');
    expect(getDateGroup(new Date(2027, 9, 12), now)).toBe('later');
  });

  it('groups days before the current week that are not yesterday as earlier', () => {
    expect(getDateGroup(day(9, 1), now)).toBe('this_week');
    expect(getDateGroup(day(8, 27), now)).toBe('earlier');
    expect(getDateGroup(day(8, 28, 0, 0), now)).toBe('this_week');
  });

  it('treats a Monday "today" correctly (yesterday is last week Sunday)', () => {
    const monday = new Date(2026, 9, 5, 9);
    expect(getDateGroup(new Date(2026, 9, 4, 12), monday)).toBe('yesterday');
    expect(getDateGroup(new Date(2026, 9, 3, 12), monday)).toBe('earlier');
    expect(getDateGroup(new Date(2026, 9, 12, 0, 0), monday)).toBe('next_week');
  });
});

describe('formatScheduleTime', () => {
  const start = new Date(2026, 9, 3, 11, 0);
  const end = new Date(2026, 9, 3, 11, 30);

  it('uses the same spaced, upper-case 12h format as the grid', () => {
    expect(formatScheduleTime(start, end, null, '12h')).toBe('11:00 AM – 11:30 AM');
  });

  it('follows the 24h preference', () => {
    expect(formatScheduleTime(start, end, null, '24h')).toBe('11:00 – 11:30');
  });

  it('shows only the start when there is no end', () => {
    expect(formatScheduleTime(start, null, null, '12h')).toBe('11:00 AM');
  });

  it('shows only the start when the end is before the start', () => {
    const backwards = new Date(2026, 9, 3, 9, 30);
    expect(formatScheduleTime(new Date(2026, 9, 3, 10, 0), backwards, null, '12h')).toBe('10:00 AM');
    expect(formatEventTimeRange(start, new Date('invalid'), '12h')).toBe('11:00 AM');
  });

  it('returns the all-day label when given', () => {
    expect(formatScheduleTime(start, end, 'All day', '12h')).toBe('All day');
  });
});
