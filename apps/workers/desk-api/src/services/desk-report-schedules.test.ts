/**
 * When a scheduled report runs next (`nextReportRun`): daily, weekly and
 * monthly, in the schedule's own time zone, across the daylight saving
 * changes and month and year ends. Pure functions, no database.
 */

import { describe, expect, it } from 'vitest';
import { appBaseUrl, nextReportRun, overviewPeriodLabel, type ReportTiming } from './desk-report-schedules';

const timing = (overrides: Partial<ReportTiming>): ReportTiming => ({
  frequency: 'daily',
  dayOfWeek: null,
  dayOfMonth: null,
  hour: 8,
  timezone: 'UTC',
  ...overrides,
});

const next = (t: ReportTiming, after: string) => nextReportRun(t, new Date(after)).toISOString();

describe('nextReportRun: daily', () => {
  it('is today at the hour when that is still ahead, else tomorrow', () => {
    expect(next(timing({}), '2026-03-10T07:59:59Z')).toBe('2026-03-10T08:00:00.000Z');
    expect(next(timing({}), '2026-03-10T08:00:00Z')).toBe('2026-03-11T08:00:00.000Z');
    expect(next(timing({}), '2026-03-10T08:00:00.001Z')).toBe('2026-03-11T08:00:00.000Z');
  });

  it('reads the day and hour in the time zone, not in UTC', () => {
    // 22:00 UTC on 10 March is already 11 March, 09:00 in Amsterdam (CET): the 11th at 08:00 is 07:00 UTC.
    const amsterdam = timing({ timezone: 'Europe/Amsterdam' });
    expect(next(amsterdam, '2026-03-10T22:00:00Z')).toBe('2026-03-11T07:00:00.000Z');
    // 04:00 UTC is 05:00 in Amsterdam: still ahead of 08:00 the same day.
    expect(next(amsterdam, '2026-03-10T04:00:00Z')).toBe('2026-03-10T07:00:00.000Z');
    // New York is behind UTC: 02:00 UTC on 10 March is 22:00 on the 9th (EDT, UTC-4), so the next 08:00 is on the 10th.
    expect(next(timing({ timezone: 'America/New_York' }), '2026-03-10T02:00:00Z')).toBe('2026-03-10T12:00:00.000Z');
  });
});

describe('nextReportRun: daylight saving time', () => {
  const amsterdam = timing({ timezone: 'Europe/Amsterdam' });

  it('keeps 08:00 local when the clocks go forward (29 March 2026)', () => {
    // Day before the change: CET, 08:00 = 07:00 UTC.
    expect(next(amsterdam, '2026-03-27T10:00:00Z')).toBe('2026-03-28T07:00:00.000Z');
    // Day of the change: CEST, 08:00 = 06:00 UTC.
    expect(next(amsterdam, '2026-03-28T08:00:00Z')).toBe('2026-03-29T06:00:00.000Z');
    expect(next(amsterdam, '2026-03-29T06:00:00Z')).toBe('2026-03-30T06:00:00.000Z');
  });

  it('keeps 08:00 local when the clocks go back (25 October 2026)', () => {
    expect(next(amsterdam, '2026-10-24T10:00:00Z')).toBe('2026-10-25T07:00:00.000Z');
    expect(next(amsterdam, '2026-10-25T07:00:00Z')).toBe('2026-10-26T07:00:00.000Z');
  });

  it('runs a skipped hour at the moment the clock jumps', () => {
    // 02:00 does not exist on 29 March: the clock goes from 02:00 to 03:00 (01:00 UTC).
    expect(next(timing({ timezone: 'Europe/Amsterdam', hour: 2 }), '2026-03-28T12:00:00Z')).toBe('2026-03-29T01:00:00.000Z');
  });

  it('runs a repeated hour the first time it happens', () => {
    // 02:00 happens twice on 25 October (CEST 00:00 UTC, then CET 01:00 UTC).
    expect(next(timing({ timezone: 'Europe/Amsterdam', hour: 2 }), '2026-10-24T12:00:00Z')).toBe('2026-10-25T00:00:00.000Z');
    // Once the first has passed, the next run is the following day, not the repeat.
    expect(next(timing({ timezone: 'Europe/Amsterdam', hour: 2 }), '2026-10-25T00:00:00Z')).toBe('2026-10-26T01:00:00.000Z');
  });

  it('follows the United States change on another date (8 March 2026)', () => {
    const newYork = timing({ timezone: 'America/New_York' });
    expect(next(newYork, '2026-03-07T20:00:00Z')).toBe('2026-03-08T12:00:00.000Z');
    expect(next(newYork, '2026-03-08T12:00:00Z')).toBe('2026-03-09T12:00:00.000Z');
  });
});

describe('nextReportRun: weekly', () => {
  // 2026-03-23 is a Monday.
  const monday = timing({ frequency: 'weekly', dayOfWeek: 1, hour: 9, timezone: 'Europe/Amsterdam' });

  it('is the next Monday at the hour, strictly after the given moment', () => {
    expect(next(monday, '2026-03-23T07:59:59Z')).toBe('2026-03-23T08:00:00.000Z');
    expect(next(monday, '2026-03-23T08:00:00Z')).toBe('2026-03-30T07:00:00.000Z');
    expect(next(monday, '2026-03-24T12:00:00Z')).toBe('2026-03-30T07:00:00.000Z');
  });

  it('counts Sunday as 0 and Saturday as 6', () => {
    expect(next(timing({ frequency: 'weekly', dayOfWeek: 0 }), '2026-03-23T00:00:00Z')).toBe('2026-03-29T08:00:00.000Z');
    expect(next(timing({ frequency: 'weekly', dayOfWeek: 6 }), '2026-03-23T00:00:00Z')).toBe('2026-03-28T08:00:00.000Z');
  });

  it('uses the weekday of the time zone, which can differ from the UTC one', () => {
    // 10:30 UTC on Sunday 22 March is still Sunday 23:30 in Auckland (NZDT, UTC+13): Monday 00:00 there is 11:00 UTC.
    const auckland = timing({ frequency: 'weekly', dayOfWeek: 1, hour: 0, timezone: 'Pacific/Auckland' });
    expect(next(auckland, '2026-03-22T10:30:00Z')).toBe('2026-03-22T11:00:00.000Z');
    expect(next(auckland, '2026-03-22T12:00:00Z')).toBe('2026-03-29T11:00:00.000Z');
  });
});

describe('nextReportRun: monthly', () => {
  it('is the day of the month at the hour', () => {
    const t = timing({ frequency: 'monthly', dayOfMonth: 15 });
    expect(next(t, '2026-03-10T00:00:00Z')).toBe('2026-03-15T08:00:00.000Z');
    expect(next(t, '2026-03-15T08:00:00Z')).toBe('2026-04-15T08:00:00.000Z');
  });

  it('reaches the 28th in February, and carries on past it', () => {
    const t = timing({ frequency: 'monthly', dayOfMonth: 28 });
    expect(next(t, '2026-01-31T12:00:00Z')).toBe('2026-02-28T08:00:00.000Z');
    expect(next(t, '2026-02-28T08:00:00Z')).toBe('2026-03-28T08:00:00.000Z');
    // A leap year changes nothing for the 28th.
    expect(next(t, '2028-02-10T00:00:00Z')).toBe('2028-02-28T08:00:00.000Z');
  });

  it('starts from the end of a month and rolls over the year', () => {
    const first = timing({ frequency: 'monthly', dayOfMonth: 1 });
    expect(next(first, '2026-01-31T23:00:00Z')).toBe('2026-02-01T08:00:00.000Z');
    expect(next(first, '2026-12-31T23:00:00Z')).toBe('2027-01-01T08:00:00.000Z');
  });

  it('reads the month day in the time zone', () => {
    // 03:00 UTC on 1 March is 19:00 on 28 February in Los Angeles: the 28th at 20:00 PST is 04:00 UTC on 1 March.
    const la = timing({ frequency: 'monthly', dayOfMonth: 28, hour: 20, timezone: 'America/Los_Angeles' });
    expect(next(la, '2026-03-01T03:00:00Z')).toBe('2026-03-01T04:00:00.000Z');
  });

  it('keeps the local hour across a daylight saving change in the month', () => {
    // The 28th of March is still CET, the 1st of April is CEST.
    const ams = (dayOfMonth: number) => timing({ frequency: 'monthly', dayOfMonth, timezone: 'Europe/Amsterdam' });
    expect(next(ams(28), '2026-03-01T00:00:00Z')).toBe('2026-03-28T07:00:00.000Z');
    expect(next(ams(1), '2026-03-02T00:00:00Z')).toBe('2026-04-01T06:00:00.000Z');
  });
});

describe('overviewPeriodLabel', () => {
  it('is one date for a single day and a range otherwise (the end is exclusive)', () => {
    expect(overviewPeriodLabel({ start: '2026-03-15', end: '2026-03-16' }, 'en')).toBe('Mar 15, 2026');
    expect(overviewPeriodLabel({ start: '2026-03-09', end: '2026-03-16' }, 'en')).toBe('Mar 9, 2026 to Mar 15, 2026');
    expect(overviewPeriodLabel({ start: '2026-03-09', end: '2026-03-16' }, 'nl')).toBe('9 mrt 2026 t/m 15 mrt 2026');
  });
});

describe('appBaseUrl', () => {
  it('is the configured URL, else the app of the environment', () => {
    expect(appBaseUrl({ PUBLIC_APP_URL: 'https://desk.example.test/', ENVIRONMENT: 'production' })).toBe('https://desk.example.test/');
    expect(appBaseUrl({ ENVIRONMENT: 'production' })).toBe('https://app.weldsuite.org');
    expect(appBaseUrl({ ENVIRONMENT: 'test' })).toBe('https://app-test.weldsuite.org');
    expect(appBaseUrl({ ENVIRONMENT: 'development' })).toBe('http://localhost:3000');
    expect(appBaseUrl({ ENVIRONMENT: 'weird' })).toBe('https://app.weldsuite.org');
  });
});
