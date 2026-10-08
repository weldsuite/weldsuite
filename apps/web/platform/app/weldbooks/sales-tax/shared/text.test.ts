import { describe, expect, it } from 'vitest';
import { daysUntil, dueCountdown, dueTone, fill, sameAmount, toCents } from './text';

const texts = {
  inDays: 'Due in {count} days',
  tomorrow: 'Due tomorrow',
  today: 'Due today',
  overdueOne: '1 day overdue',
  overdueMany: '{count} days overdue',
};

describe('fill', () => {
  it('replaces every placeholder', () => {
    expect(fill('{a} and {b} and {a}', { a: 'x', b: 2 })).toBe('x and 2 and x');
  });

  it('leaves a placeholder it has no value for', () => {
    expect(fill('Hello {name}', {})).toBe('Hello {name}');
  });
});

describe('dueCountdown', () => {
  it('counts down to the due date', () => {
    expect(dueCountdown(texts, 17)).toBe('Due in 17 days');
    expect(dueCountdown(texts, 2)).toBe('Due in 2 days');
    expect(dueCountdown(texts, 1)).toBe('Due tomorrow');
    expect(dueCountdown(texts, 0)).toBe('Due today');
  });

  it('counts the days past the due date', () => {
    expect(dueCountdown(texts, -1)).toBe('1 day overdue');
    expect(dueCountdown(texts, -12)).toBe('12 days overdue');
  });
});

describe('dueTone', () => {
  it('is overdue once past, soon within two weeks, later beyond', () => {
    expect(dueTone(-1)).toBe('overdue');
    expect(dueTone(0)).toBe('soon');
    expect(dueTone(14)).toBe('soon');
    expect(dueTone(15)).toBe('later');
  });
});

describe('daysUntil', () => {
  it('counts calendar days, whatever the time of day', () => {
    const noon = new Date(2026, 9, 8, 12, 30);
    const lateEvening = new Date(2026, 9, 8, 23, 59);
    expect(daysUntil('2026-10-25', noon)).toBe(17);
    expect(daysUntil('2026-10-25', lateEvening)).toBe(17);
    expect(daysUntil('2026-10-08', noon)).toBe(0);
    expect(daysUntil('2026-10-01', noon)).toBe(-7);
  });

  it('crosses a month and a year end', () => {
    expect(daysUntil('2027-01-02', new Date(2026, 11, 30))).toBe(3);
  });
});

describe('money in cents', () => {
  it('compares amounts in cents', () => {
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(sameAmount(0.1 + 0.2, 0.3)).toBe(true);
    expect(sameAmount(10, 10.01)).toBe(false);
  });
});
