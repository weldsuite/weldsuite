import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { countdownTo, formatClock, liveSeconds } from './wallboard-format';

const t = en.helpdesk.reports;

describe('formatClock', () => {
  it('reads as a clock under an hour', () => {
    expect(formatClock(0, t)).toBe('0:00');
    expect(formatClock(45, t)).toBe('0:45');
    expect(formatClock(725, t)).toBe('12:05');
    expect(formatClock(3599, t)).toBe('59:59');
  });

  it('switches to hours and minutes from an hour on', () => {
    expect(formatClock(3600, t)).toBe('1h 0m');
    expect(formatClock(7500, t)).toBe('2h 5m');
  });

  it('shows a dash when there is no value', () => {
    expect(formatClock(null, t)).toBe('—');
    expect(formatClock(undefined, t)).toBe('—');
  });
});

describe('liveSeconds', () => {
  const generatedAt = '2026-11-09T10:00:00.000Z';
  const generated = Date.parse(generatedAt);

  it('adds the time since the numbers were generated', () => {
    expect(liveSeconds(120, generatedAt, generated + 30_000)).toBe(150);
  });

  it('keeps null as null', () => {
    expect(liveSeconds(null, generatedAt, generated + 30_000)).toBeNull();
  });

  it('does not go backwards when the browser clock is behind', () => {
    expect(liveSeconds(120, generatedAt, generated - 60_000)).toBe(120);
  });
});

describe('countdownTo', () => {
  const now = Date.parse('2026-11-09T10:00:00.000Z');

  it('counts down to a due time in the future', () => {
    expect(countdownTo('2026-11-09T10:05:00.000Z', now)).toEqual({ overdue: false, seconds: 300 });
  });

  it('counts up past a due time', () => {
    expect(countdownTo('2026-11-09T09:58:00.000Z', now)).toEqual({ overdue: true, seconds: 120 });
  });

  it('is due now at the exact moment', () => {
    expect(countdownTo('2026-11-09T10:00:00.000Z', now)).toEqual({ overdue: false, seconds: 0 });
  });
});
