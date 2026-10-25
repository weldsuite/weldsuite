import { describe, it, expect } from 'vitest';
import type { DeskOfficeHours } from '@weldsuite/db/schema/desk-widget-settings';
import { officeHoursAvailability } from './office-hours';

const WEEKDAYS_9_TO_5: DeskOfficeHours = {
  enabled: true,
  days: {
    mon: { start: '09:00', end: '17:00' },
    tue: { start: '09:00', end: '17:00' },
    wed: { start: '09:00', end: '17:00' },
    thu: { start: '09:00', end: '17:00' },
    fri: { start: '09:00', end: '17:00' },
  },
};
const AMS = 'Europe/Amsterdam';

describe('officeHoursAvailability', () => {
  it('is always open when office hours are off or missing', () => {
    expect(officeHoursAvailability(null, AMS)).toEqual({ isOpen: true, nextOpenAt: null });
    expect(officeHoursAvailability({ ...WEEKDAYS_9_TO_5, enabled: false }, AMS)).toEqual({
      isOpen: true,
      nextOpenAt: null,
    });
  });

  it('is open inside a window, in the widget timezone', () => {
    // Wed 2026-10-21 10:30 in Amsterdam (CEST, UTC+2)
    expect(officeHoursAvailability(WEEKDAYS_9_TO_5, AMS, new Date('2026-10-21T08:30:00Z')).isOpen).toBe(true);
  });

  it('treats the end time as exclusive', () => {
    const at = officeHoursAvailability(WEEKDAYS_9_TO_5, AMS, new Date('2026-10-21T15:00:00Z'));
    expect(at.isOpen).toBe(false);
    expect(at.nextOpenAt).toBe('2026-10-22T07:00:00.000Z');
  });

  it('points to later today before the day starts', () => {
    // Wed 07:45 Amsterdam
    expect(officeHoursAvailability(WEEKDAYS_9_TO_5, AMS, new Date('2026-10-21T05:45:30Z'))).toEqual({
      isOpen: false,
      nextOpenAt: '2026-10-21T07:00:00.000Z',
    });
  });

  it('skips the weekend to Monday morning', () => {
    // Sat 2026-10-24 12:00 Amsterdam (CEST) → Mon 2026-10-26 09:00 (CET after the switch, UTC+1)
    expect(officeHoursAvailability(WEEKDAYS_9_TO_5, AMS, new Date('2026-10-24T10:00:00Z'))).toEqual({
      isOpen: false,
      nextOpenAt: '2026-10-26T08:00:00.000Z',
    });
  });

  it('finds the same weekday next week when that is the only open day', () => {
    const mondays: DeskOfficeHours = { enabled: true, days: { mon: { start: '10:00', end: '12:00' } } };
    // Mon 2026-10-19 13:00 UTC
    expect(officeHoursAvailability(mondays, 'UTC', new Date('2026-10-19T13:00:00Z')).nextOpenAt).toBe(
      '2026-10-26T10:00:00.000Z',
    );
  });

  it('allows a window that runs to midnight', () => {
    const lateShift: DeskOfficeHours = { enabled: true, days: { wed: { start: '18:00', end: '24:00' } } };
    expect(officeHoursAvailability(lateShift, 'UTC', new Date('2026-10-21T23:59:00Z')).isOpen).toBe(true);
  });

  it('ignores malformed and empty windows', () => {
    const broken: DeskOfficeHours = {
      enabled: true,
      days: { mon: { start: '17:00', end: '09:00' }, tue: { start: 'nine', end: '17:00' }, wed: null },
    };
    expect(officeHoursAvailability(broken, 'UTC', new Date('2026-10-20T12:00:00Z'))).toEqual({
      isOpen: false,
      nextOpenAt: null,
    });
  });

  it('falls back to UTC for an unknown timezone', () => {
    expect(officeHoursAvailability(WEEKDAYS_9_TO_5, 'Mars/Olympus', new Date('2026-10-21T09:30:00Z')).isOpen).toBe(true);
    expect(officeHoursAvailability(WEEKDAYS_9_TO_5, 'Mars/Olympus', new Date('2026-10-21T08:30:00Z')).isOpen).toBe(false);
  });
});
