import { describe, expect, it } from 'vitest';
import { MAX_SCHEDULE_DAYS, checkScheduleTime, latestScheduleDate } from './schedule-limit';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 9, 4, 12, 0, 0);

describe('checkScheduleTime', () => {
  it('accepts a time inside the window', () => {
    expect(checkScheduleTime(new Date(now + 60_000), now)).toBe('ok');
    expect(checkScheduleTime(new Date(now + 7 * DAY), now)).toBe('ok');
  });

  it('rejects a time that is not in the future', () => {
    expect(checkScheduleTime(new Date(now), now)).toBe('past');
    expect(checkScheduleTime(new Date(now - 1), now)).toBe('past');
  });

  it('rejects a time past the window, where setTimeout would overflow and fire immediately', () => {
    expect(checkScheduleTime(new Date(now + (MAX_SCHEDULE_DAYS + 1) * DAY), now)).toBe('too-far');
    expect(checkScheduleTime(new Date(now + 40 * DAY), now)).toBe('too-far');
  });

  it('accepts exactly the last allowed instant', () => {
    expect(checkScheduleTime(new Date(now + MAX_SCHEDULE_DAYS * DAY), now)).toBe('ok');
  });

  it('keeps the whole window under the 32-bit setTimeout limit', () => {
    expect(MAX_SCHEDULE_DAYS * DAY).toBeLessThan(2 ** 31);
  });
});

describe('latestScheduleDate', () => {
  it('is the end of the window', () => {
    expect(latestScheduleDate(now).getTime()).toBe(now + MAX_SCHEDULE_DAYS * DAY);
  });
});
