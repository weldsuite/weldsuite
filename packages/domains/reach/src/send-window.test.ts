import { describe, expect, it } from 'vitest';
import {
  getZonedParts,
  isValidTimeZone,
  isWithinWindow,
  parseHHMM,
  snapIntoWindow,
  spreadSendTimes,
  startOfNextZonedDay,
  startOfZonedDay,
  windowCloseOfDay,
  zonedTimeToUtc,
  type SendSchedule,
} from './send-window';

const AMS: SendSchedule = {
  timezone: 'Europe/Amsterdam',
  sendDays: [1, 2, 3, 4, 5],
  windowStart: '09:00',
  windowEnd: '17:00',
};

const iso = (d: Date) => d.toISOString();

describe('zone helpers', () => {
  it('reads wall-clock parts, midnight as hour 0', () => {
    // 2026-10-12 22:00Z = 2026-10-13 00:00 CEST (UTC+2)
    const p = getZonedParts(new Date('2026-10-12T22:00:00Z'), 'Europe/Amsterdam');
    expect(p).toMatchObject({ year: 2026, month: 10, day: 13, hour: 0, minute: 0, isoWeekday: 2 });
  });

  it('converts a wall-clock time back to the instant, either side of a DST change', () => {
    expect(iso(zonedTimeToUtc({ year: 2026, month: 10, day: 12, hour: 9 }, 'Europe/Amsterdam'))).toBe('2026-10-12T07:00:00.000Z');
    expect(iso(zonedTimeToUtc({ year: 2026, month: 10, day: 26, hour: 9 }, 'Europe/Amsterdam'))).toBe('2026-10-26T08:00:00.000Z');
    expect(iso(zonedTimeToUtc({ year: 2026, month: 10, day: 12, hour: 9 }, 'America/New_York'))).toBe('2026-10-12T13:00:00.000Z');
  });

  it('moves a wall-clock time inside the spring-forward gap past the gap', () => {
    // 2026-03-29 02:30 does not exist in Amsterdam (02:00 -> 03:00)
    expect(iso(zonedTimeToUtc({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, 'Europe/Amsterdam'))).toBe('2026-03-29T01:30:00.000Z');
  });

  it('knows how long a day is on a DST change', () => {
    // fall back: 25-hour day on 2026-10-25
    const start = startOfZonedDay(new Date('2026-10-25T12:00:00Z'), 'Europe/Amsterdam');
    const next = startOfNextZonedDay(new Date('2026-10-25T12:00:00Z'), 'Europe/Amsterdam');
    expect(iso(start)).toBe('2026-10-24T22:00:00.000Z');
    expect(iso(next)).toBe('2026-10-25T23:00:00.000Z');
  });

  it('validates time zones and HH:MM', () => {
    expect(isValidTimeZone('Europe/Amsterdam')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(parseHHMM('09:30')).toBe(570);
    expect(parseHHMM('24:00')).toBeNull();
    expect(parseHHMM('9')).toBeNull();
  });
});

describe('snapIntoWindow', () => {
  it('leaves an instant inside the window alone', () => {
    const at = new Date('2026-10-12T08:00:00Z'); // Mon 10:00 CEST
    expect(snapIntoWindow(at, AMS)).toEqual(at);
    expect(isWithinWindow(at, AMS)).toBe(true);
  });

  it('moves an early instant to the window start of the same day', () => {
    expect(iso(snapIntoWindow(new Date('2026-10-12T05:00:00Z'), AMS))).toBe('2026-10-12T07:00:00.000Z');
  });

  it('treats the window end as exclusive and moves on to the next sending day', () => {
    expect(iso(snapIntoWindow(new Date('2026-10-12T15:00:00Z'), AMS))).toBe('2026-10-13T07:00:00.000Z'); // 17:00 CEST exactly
    expect(isWithinWindow(new Date('2026-10-12T14:59:59Z'), AMS)).toBe(true);
  });

  it('skips the weekend', () => {
    expect(iso(snapIntoWindow(new Date('2026-10-16T16:00:00Z'), AMS))).toBe('2026-10-19T07:00:00.000Z'); // Fri evening
    expect(iso(snapIntoWindow(new Date('2026-10-17T10:00:00Z'), AMS))).toBe('2026-10-19T07:00:00.000Z'); // Saturday
  });

  it('uses the zone offset in force on the target day (fall-back)', () => {
    // Sunday 2026-10-25 20:00Z -> Monday 09:00 CET = 08:00Z (CEST ended)
    expect(iso(snapIntoWindow(new Date('2026-10-25T20:00:00Z'), AMS))).toBe('2026-10-26T08:00:00.000Z');
  });

  it('uses the zone offset in force on the target day (spring-forward)', () => {
    // Saturday 2026-03-28 evening -> Monday 2026-03-30 09:00 CEST = 07:00Z
    expect(iso(snapIntoWindow(new Date('2026-03-28T20:00:00Z'), AMS))).toBe('2026-03-30T07:00:00.000Z');
  });

  it('works in other time zones', () => {
    const ny: SendSchedule = { ...AMS, timezone: 'America/New_York' };
    expect(iso(snapIntoWindow(new Date('2026-10-12T12:00:00Z'), ny))).toBe('2026-10-12T13:00:00.000Z'); // 08:00 EDT -> 09:00 EDT
    expect(isWithinWindow(new Date('2026-10-12T14:00:00Z'), ny)).toBe(true);
    const tokyo: SendSchedule = { ...AMS, timezone: 'Asia/Tokyo' };
    expect(iso(snapIntoWindow(new Date('2026-10-12T10:00:00Z'), tokyo))).toBe('2026-10-13T00:00:00.000Z'); // 19:00 JST Mon -> Tue 09:00 JST
  });

  it('honours a custom set of send days, including Sunday', () => {
    const sundayOnly: SendSchedule = { ...AMS, sendDays: [7] };
    expect(iso(snapIntoWindow(new Date('2026-10-12T08:00:00Z'), sundayOnly))).toBe('2026-10-18T07:00:00.000Z');
  });

  it('treats an empty send-days list as every day', () => {
    const every: SendSchedule = { ...AMS, sendDays: [] };
    expect(isWithinWindow(new Date('2026-10-17T10:00:00Z'), every)).toBe(true);
  });

  it('treats an end at or before the start as the end of the day', () => {
    const late: SendSchedule = { ...AMS, windowStart: '18:00', windowEnd: '06:00' };
    expect(isWithinWindow(new Date('2026-10-12T21:00:00Z'), late)).toBe(true); // 23:00 CEST
    expect(isWithinWindow(new Date('2026-10-12T22:30:00Z'), late)).toBe(false); // 00:30 Tuesday is outside Monday's window... but Tuesday opens at 18:00
    expect(iso(snapIntoWindow(new Date('2026-10-12T22:30:00Z'), late))).toBe('2026-10-13T16:00:00.000Z');
  });

  it('returns the instant when no sending day is within reach', () => {
    const none: SendSchedule = { ...AMS, sendDays: [9] };
    const at = new Date('2026-10-12T08:00:00Z');
    expect(snapIntoWindow(at, none)).toEqual(at);
  });
});

describe('windowCloseOfDay / spreadSendTimes', () => {
  it('closes the window of the local day', () => {
    expect(iso(windowCloseOfDay(new Date('2026-10-12T08:00:00Z'), AMS))).toBe('2026-10-12T15:00:00.000Z');
  });

  it('spreads launches over the rest of the window, never sparser than the cap', () => {
    const from = new Date('2026-10-12T07:00:00Z'); // window open, 8 h left
    const times = spreadSendTimes(4, from, AMS, 8 * 3_600_000);
    expect(times.map(iso)).toEqual([
      '2026-10-12T07:00:00.000Z',
      '2026-10-12T09:00:00.000Z',
      '2026-10-12T11:00:00.000Z',
      '2026-10-12T13:00:00.000Z',
    ]);
    const capped = spreadSendTimes(4, from, AMS, 10 * 60_000);
    expect(capped.map(iso)).toEqual([
      '2026-10-12T07:00:00.000Z',
      '2026-10-12T07:10:00.000Z',
      '2026-10-12T07:20:00.000Z',
      '2026-10-12T07:30:00.000Z',
    ]);
  });

  it('starts at the next window when launched outside one, and snaps overflow into windows', () => {
    const times = spreadSendTimes(2, new Date('2026-10-12T20:00:00Z'), AMS, 24 * 3_600_000);
    expect(iso(times[0]!)).toBe('2026-10-13T07:00:00.000Z');
    expect(isWithinWindow(times[1]!, AMS)).toBe(true);
    expect(spreadSendTimes(0, new Date(), AMS, 1)).toEqual([]);
  });
});
