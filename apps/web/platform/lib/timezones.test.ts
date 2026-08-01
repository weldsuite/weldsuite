import { describe, it, expect } from 'vitest';
import {
  getUtcOffset,
  getBrowserTimezone,
  instantToZonedWallClock,
  zonedWallClockToInstant,
  TIMEZONES,
} from './timezones';

describe('getUtcOffset', () => {
  it('returns GMT+00:00 for UTC', () => {
    expect(getUtcOffset('UTC')).toMatch(/GMT[+-]?(00|0):?(00)?/);
  });

  it('handles an unknown timezone gracefully', () => {
    expect(getUtcOffset('Mars/Olympus_Mons')).toBe('GMT');
  });

  it('returns a GMT-prefixed string for valid IANA zones', () => {
    expect(getUtcOffset('Europe/Amsterdam')).toMatch(/^GMT/);
    expect(getUtcOffset('America/New_York')).toMatch(/^GMT/);
  });
});

describe('zonedWallClockToInstant', () => {
  // The whole point: the same typed time means a different moment per zone.
  // `new Date('2026-08-05T14:30')` would apply the *browser's* offset instead.
  it('reads the wall clock in the given zone, not the browser zone', () => {
    // 14:30 in Amsterdam is CEST (UTC+2) in August.
    expect(zonedWallClockToInstant('2026-08-05T14:30', 'Europe/Amsterdam')?.toISOString()).toBe(
      '2026-08-05T12:30:00.000Z',
    );
    // The same wall clock in New York is EDT (UTC-4).
    expect(zonedWallClockToInstant('2026-08-05T14:30', 'America/New_York')?.toISOString()).toBe(
      '2026-08-05T18:30:00.000Z',
    );
    expect(zonedWallClockToInstant('2026-08-05T14:30', 'UTC')?.toISOString()).toBe(
      '2026-08-05T14:30:00.000Z',
    );
  });

  it('applies the offset in force on the date, not today', () => {
    // January is CET (UTC+1) in Amsterdam, not CEST.
    expect(zonedWallClockToInstant('2026-01-15T09:00', 'Europe/Amsterdam')?.toISOString()).toBe(
      '2026-01-15T08:00:00.000Z',
    );
  });

  it('accepts an optional seconds component', () => {
    expect(zonedWallClockToInstant('2026-08-05T14:30:45', 'UTC')?.toISOString()).toBe(
      '2026-08-05T14:30:45.000Z',
    );
  });

  // A time in the spring-forward gap does not exist; it must still resolve to a
  // real instant rather than NaN. 02:30 on 2026-03-29 is skipped in Amsterdam,
  // so it lands just past the transition (03:30 CEST).
  it('resolves a nonexistent spring-forward time to the instant after the gap', () => {
    const instant = zonedWallClockToInstant('2026-03-29T02:30', 'Europe/Amsterdam');
    expect(instant).not.toBeNull();
    expect(Number.isNaN(instant!.getTime())).toBe(false);
    expect(instant!.toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });

  // Fall-back days repeat an hour, so the wall clock maps to two instants. The
  // earlier one wins, and it must win in BOTH offset directions — resolving
  // from a single probe silently picks the later occurrence for zones east of
  // UTC, which is exactly the zone this feature was built for.
  it('takes the earlier instant for an ambiguous fall-back time', () => {
    // 02:30 on 2026-10-25 in Amsterdam is 00:30Z (CEST) then 01:30Z (CET).
    expect(zonedWallClockToInstant('2026-10-25T02:30', 'Europe/Amsterdam')?.toISOString()).toBe(
      '2026-10-25T00:30:00.000Z',
    );
    // 01:30 on 2026-11-01 in New York is 05:30Z (EDT) then 06:30Z (EST).
    expect(zonedWallClockToInstant('2026-11-01T01:30', 'America/New_York')?.toISOString()).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });

  it('returns null on a malformed value or unknown zone', () => {
    expect(zonedWallClockToInstant('not a time', 'UTC')).toBeNull();
    expect(zonedWallClockToInstant('2026-08-05T14:30', 'Mars/Olympus_Mons')).toBeNull();
  });
});

describe('instantToZonedWallClock', () => {
  it('renders the instant as the clock time a viewer in that zone reads', () => {
    expect(instantToZonedWallClock('2026-08-05T12:30:00.000Z', 'Europe/Amsterdam')).toBe(
      '2026-08-05T14:30',
    );
    expect(instantToZonedWallClock('2026-08-05T12:30:00.000Z', 'America/New_York')).toBe(
      '2026-08-05T08:30',
    );
    expect(instantToZonedWallClock('2026-08-05T12:30:00.000Z', 'UTC')).toBe('2026-08-05T12:30');
  });

  // Load an existing post into the editor, save it back unchanged: the instant
  // must survive the round trip or every edit would drift the schedule.
  it('round-trips with zonedWallClockToInstant', () => {
    for (const zone of ['UTC', 'Europe/Amsterdam', 'America/New_York', 'Asia/Kolkata']) {
      const original = '2026-08-05T12:30:00.000Z';
      const wallClock = instantToZonedWallClock(original, zone);
      expect(zonedWallClockToInstant(wallClock, zone)?.toISOString()).toBe(original);
    }
  });

  it('returns an empty string on an invalid instant or zone', () => {
    expect(instantToZonedWallClock('nonsense', 'UTC')).toBe('');
    expect(instantToZonedWallClock('2026-08-05T12:30:00.000Z', 'Mars/Olympus_Mons')).toBe('');
  });
});

describe('getBrowserTimezone', () => {
  it('returns a non-empty IANA-looking zone', () => {
    expect(getBrowserTimezone().length).toBeGreaterThan(0);
  });
});

describe('TIMEZONES list', () => {
  it('UTC is the first entry', () => {
    expect(TIMEZONES[0]?.id).toBe('UTC');
  });

  it('every entry has id + label', () => {
    for (const tz of TIMEZONES) {
      expect(tz.id.length).toBeGreaterThan(0);
      expect(tz.label).toContain(tz.id.replace(/_/g, ' '));
    }
  });

  it('contains common zones', () => {
    const ids = TIMEZONES.map((t) => t.id);
    expect(ids).toContain('Europe/Amsterdam');
    expect(ids).toContain('America/New_York');
  });
});
