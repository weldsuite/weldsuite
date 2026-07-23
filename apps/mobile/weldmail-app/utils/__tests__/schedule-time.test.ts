import {
  MAX_SCHEDULE_DAYS,
  buildSendTimePresets,
  combineDateAndTime,
  formatClock,
  isWithinScheduleWindow,
  scheduleWindowBounds,
  stepTime,
} from '../schedule-time';

// A fixed "now" so preset maths is deterministic: Mon 2030-01-07, 10:30 local.
const NOW = new Date(2030, 0, 7, 10, 30, 0, 0);

describe('formatClock', () => {
  it('zero-pads to 24h HH:MM', () => {
    expect(formatClock(new Date(2030, 0, 7, 9, 5))).toBe('09:05');
    expect(formatClock(new Date(2030, 0, 7, 14, 0))).toBe('14:00');
    expect(formatClock(new Date(2030, 0, 7, 0, 0))).toBe('00:00');
  });
});

describe('isWithinScheduleWindow', () => {
  it('rejects now and the past (app-api SCHEDULE_IN_PAST)', () => {
    expect(isWithinScheduleWindow(NOW, NOW)).toBe(false);
    expect(isWithinScheduleWindow(new Date(NOW.getTime() - 1000), NOW)).toBe(false);
  });

  it('accepts anything strictly future within the window', () => {
    expect(isWithinScheduleWindow(new Date(NOW.getTime() + 1000), NOW)).toBe(true);
  });

  it('rejects beyond MAX_SCHEDULE_DAYS (app-api SCHEDULE_TOO_FAR)', () => {
    const { max } = scheduleWindowBounds(NOW);
    expect(isWithinScheduleWindow(max, NOW)).toBe(true);
    expect(isWithinScheduleWindow(new Date(max.getTime() + 1000), NOW)).toBe(false);
  });

  it('window is exactly 7 days wide', () => {
    const { min, max } = scheduleWindowBounds(NOW);
    expect((max.getTime() - min.getTime()) / (24 * 60 * 60 * 1000)).toBe(MAX_SCHEDULE_DAYS);
  });
});

describe('buildSendTimePresets', () => {
  it('offers the four quick options in order', () => {
    expect(buildSendTimePresets(NOW).map((p) => p.key)).toEqual([
      'in-1h',
      'in-2h',
      'tomorrow-am',
      'tomorrow-pm',
    ]);
  });

  it('computes relative presets from now', () => {
    const [oneHour, twoHours] = buildSendTimePresets(NOW);
    expect(oneHour.date).toEqual(new Date(2030, 0, 7, 11, 30));
    expect(oneHour.description).toBe('11:30');
    expect(twoHours.date).toEqual(new Date(2030, 0, 7, 12, 30));
  });

  it('pins tomorrow presets to 09:00 and 14:00 the next day', () => {
    const byKey = Object.fromEntries(buildSendTimePresets(NOW).map((p) => [p.key, p]));
    expect(byKey['tomorrow-am'].date).toEqual(new Date(2030, 0, 8, 9, 0, 0, 0));
    expect(byKey['tomorrow-pm'].date).toEqual(new Date(2030, 0, 8, 14, 0, 0, 0));
    expect(byKey['tomorrow-am'].description).toBe('Tomorrow, 09:00');
  });

  it('rolls the day over correctly late at night', () => {
    const lateNight = new Date(2030, 0, 7, 23, 30);
    const [oneHour] = buildSendTimePresets(lateNight);
    // +1h crosses midnight into the 8th.
    expect(oneHour.date).toEqual(new Date(2030, 0, 8, 0, 30));
  });

  it('every preset it returns is inside the schedule window', () => {
    for (const now of [NOW, new Date(2030, 0, 7, 23, 59), new Date(2030, 1, 28, 12, 0)]) {
      for (const preset of buildSendTimePresets(now)) {
        expect(isWithinScheduleWindow(preset.date, now)).toBe(true);
      }
    }
  });
});

describe('stepTime', () => {
  it('steps hours and wraps within the day without moving the date', () => {
    const base = new Date(2030, 0, 7, 23, 0);
    const up = stepTime(base, 'hour', 1);
    expect(up.getHours()).toBe(0);
    expect(up.getDate()).toBe(7); // day is owned by the calendar, not the stepper

    const down = stepTime(new Date(2030, 0, 7, 0, 0), 'hour', -1);
    expect(down.getHours()).toBe(23);
    expect(down.getDate()).toBe(7);
  });

  it('steps minutes by the interval and wraps at the hour', () => {
    expect(stepTime(new Date(2030, 0, 7, 9, 0), 'minute', 1).getMinutes()).toBe(5);
    expect(stepTime(new Date(2030, 0, 7, 9, 55), 'minute', 1).getMinutes()).toBe(0);
    expect(stepTime(new Date(2030, 0, 7, 9, 0), 'minute', -1).getMinutes()).toBe(55);
  });

  it('snaps an off-interval minute onto the grid', () => {
    expect(stepTime(new Date(2030, 0, 7, 9, 32), 'minute', 1).getMinutes()).toBe(35);
  });

  it('zeroes seconds and milliseconds so stored times are clean', () => {
    const stepped = stepTime(new Date(2030, 0, 7, 9, 0, 42, 500), 'minute', 1);
    expect(stepped.getSeconds()).toBe(0);
    expect(stepped.getMilliseconds()).toBe(0);
  });
});

describe('combineDateAndTime', () => {
  it('takes the day from the calendar and the clock from the time control', () => {
    const combined = combineDateAndTime(new Date(2030, 5, 20, 3, 3), new Date(2030, 0, 1, 17, 45));
    expect(combined).toEqual(new Date(2030, 5, 20, 17, 45, 0, 0));
  });
});
