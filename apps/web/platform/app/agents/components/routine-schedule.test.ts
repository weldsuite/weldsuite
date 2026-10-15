import { describe, expect, it } from 'vitest';
import { describeCron, formatNextRun } from './routine-schedule';

const labels = {
  hourly: 'Every hour',
  daily: 'Every day at {time}',
  weekdays: 'Weekdays at {time}',
  weekly: 'Every {day} at {time}',
};

describe('describeCron', () => {
  it('names the common schedules', () => {
    expect(describeCron('0 7 * * 1-5', labels)).toBe('Weekdays at 07:00');
    expect(describeCron('30 8 * * *', labels)).toBe('Every day at 08:30');
    expect(describeCron('0 * * * *', labels)).toBe('Every hour');
    expect(describeCron('0 9 * * 1', labels, 'en-US')).toBe('Every Monday at 09:00');
  });

  it('leaves anything else as cron', () => {
    expect(describeCron('0 9 1 * *', labels)).toBe('0 9 1 * *');
    expect(describeCron('*/15 * * * *', labels)).toBe('*/15 * * * *');
    expect(describeCron(null, labels)).toBe('');
  });
});

describe('formatNextRun', () => {
  it('shows the time in the routine timezone', () => {
    expect(formatNextRun('2026-10-16T05:00:00Z', 'Europe/Amsterdam', 'en-GB')).toContain('07:00');
  });
});
