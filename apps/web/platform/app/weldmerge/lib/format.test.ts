import { describe, expect, it } from 'vitest';
import { cycleState, fill, formatDateRange, initials, relativeTime } from './format';

describe('fill', () => {
  it('replaces placeholders and leaves unknown ones', () => {
    expect(fill('{a} of {b} and {c}', { a: 1, b: 'x' })).toBe('1 of x and {c}');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-11-05T12:00:00.000Z');

  it('says just now under a minute and for the future', () => {
    expect(relativeTime('2026-11-05T11:59:30.000Z', 'en', 'just now', now)).toBe('just now');
    expect(relativeTime('2026-11-05T12:05:00.000Z', 'en', 'just now', now)).toBe('just now');
  });

  it('uses the largest unit that fits', () => {
    expect(relativeTime('2026-11-05T11:00:00.000Z', 'en', 'just now', now)).toContain('1');
    expect(relativeTime('2026-11-03T12:00:00.000Z', 'en', 'just now', now)).toContain('2');
  });

  it('returns an empty string for an invalid date', () => {
    expect(relativeTime('nope', 'en', 'just now', now)).toBe('');
  });
});

describe('cycleState', () => {
  it('compares a cycle with today', () => {
    expect(cycleState('2026-11-10', '2026-11-20', '2026-11-05')).toBe('upcoming');
    expect(cycleState('2026-11-01', '2026-11-20', '2026-11-05')).toBe('current');
    expect(cycleState('2026-10-01', '2026-10-14', '2026-11-05')).toBe('past');
    expect(cycleState('2026-11-05', '2026-11-05', '2026-11-05')).toBe('current');
  });
});

describe('formatDateRange and initials', () => {
  it('formats both ends in the given locale', () => {
    expect(formatDateRange('2026-11-03', '2026-11-16', 'en')).toBe('Nov 3 – Nov 16');
  });

  it('takes the first and last initial', () => {
    expect(initials('Sanne de Vries')).toBe('SV');
    expect(initials('octocat')).toBe('O');
    expect(initials('  ')).toBe('?');
  });
});
