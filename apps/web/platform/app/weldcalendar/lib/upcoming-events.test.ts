import { describe, it, expect } from 'vitest';
import { effectiveEnd, isUpcomingOrOngoing } from './upcoming-events';

const now = new Date(2026, 9, 5, 14, 0); // Mon 5 Oct 2026, 14:00 local

describe('isUpcomingOrOngoing', () => {
  it('keeps an all-day event of today (it starts at 00:00, before now)', () => {
    expect(
      isUpcomingOrOngoing({ allDay: true, startTime: new Date(2026, 9, 5, 0, 0).toISOString() }, now),
    ).toBe(true);
  });

  it('drops an all-day event of yesterday', () => {
    expect(
      isUpcomingOrOngoing(
        { allDay: true, startTime: new Date(2026, 9, 4, 0, 0).toISOString(), endTime: new Date(2026, 9, 4, 23, 59).toISOString() },
        now,
      ),
    ).toBe(false);
  });

  it('keeps an ongoing timed event and drops one that already ended', () => {
    expect(
      isUpcomingOrOngoing(
        { startTime: new Date(2026, 9, 5, 13, 0).toISOString(), endTime: new Date(2026, 9, 5, 15, 0).toISOString() },
        now,
      ),
    ).toBe(true);
    expect(
      isUpcomingOrOngoing(
        { startTime: new Date(2026, 9, 5, 9, 0).toISOString(), endTime: new Date(2026, 9, 5, 10, 0).toISOString() },
        now,
      ),
    ).toBe(false);
  });

  it('keeps a future event with no end', () => {
    expect(isUpcomingOrOngoing({ startTime: new Date(2026, 9, 6, 9, 0).toISOString() }, now)).toBe(true);
  });
});

describe('effectiveEnd', () => {
  it('never returns an end before the start', () => {
    const start = new Date(2026, 9, 5, 9, 0);
    const earlier = new Date(2026, 9, 5, 8, 0);
    expect(effectiveEnd({ startTime: start.toISOString(), endTime: earlier.toISOString() }).getTime()).toBe(start.getTime());
  });
});
