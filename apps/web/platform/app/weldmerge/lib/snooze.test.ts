import { describe, expect, it } from 'vitest';
import { snoozeUntilDate, snoozeUntilNextWeek, snoozeUntilTomorrow } from './snooze';

// Local-time constructors: the helpers work in the member's own time zone.
const local = (iso: string) => new Date(iso);

describe('snooze', () => {
  it('wakes tomorrow at 09:00', () => {
    const wake = new Date(snoozeUntilTomorrow(local('2026-11-05T15:30:00')));
    expect([wake.getDate(), wake.getMonth(), wake.getHours(), wake.getMinutes()]).toEqual([6, 10, 9, 0]);
  });

  it('rolls over the end of the month', () => {
    const wake = new Date(snoozeUntilTomorrow(local('2026-11-30T23:59:00')));
    expect([wake.getMonth(), wake.getDate()]).toEqual([11, 1]);
  });

  it('wakes next Monday at 09:00 from mid-week', () => {
    const wake = new Date(snoozeUntilNextWeek(local('2026-11-05T10:00:00'))); // a Thursday
    expect([wake.getDay(), wake.getDate(), wake.getHours()]).toEqual([1, 9, 9]);
  });

  it('wakes the Monday a week on when snoozed on a Monday, and from a Sunday', () => {
    expect(new Date(snoozeUntilNextWeek(local('2026-11-09T10:00:00'))).getDate()).toBe(16);
    expect(new Date(snoozeUntilNextWeek(local('2026-11-08T10:00:00'))).getDate()).toBe(9);
  });

  it('wakes a picked day at 09:00', () => {
    const wake = new Date(snoozeUntilDate(local('2026-12-24T00:00:00')));
    expect([wake.getMonth(), wake.getDate(), wake.getHours()]).toEqual([11, 24, 9]);
  });
});
