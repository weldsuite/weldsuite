import {
  dueDateFromToday,
  formatDueLabel,
  isOverdue,
  isThisWeek,
  isToday,
  isTomorrow,
  parseDate,
  parseDateInput,
  toDateInput,
} from '@/lib/dates';
import { en } from '@/lib/i18n/locales/en';

const NOW = new Date(2026, 7, 5, 9, 30); // 5 Aug 2026, 09:30 local

describe('day comparisons', () => {
  it('a task due today is not overdue until the day has passed', () => {
    expect(isOverdue(new Date(2026, 7, 5, 8), NOW)).toBe(false);
    expect(isOverdue(new Date(2026, 7, 4, 23, 59), NOW)).toBe(true);
  });

  it('knows today, tomorrow and this week', () => {
    expect(isToday(new Date(2026, 7, 5, 23), NOW)).toBe(true);
    expect(isTomorrow(new Date(2026, 7, 6, 1), NOW)).toBe(true);
    expect(isThisWeek(new Date(2026, 7, 9), NOW)).toBe(true);
    expect(isThisWeek(new Date(2026, 7, 12), NOW)).toBe(true);
    expect(isThisWeek(new Date(2026, 7, 13), NOW)).toBe(false);
    expect(isThisWeek(new Date(2026, 7, 5), NOW)).toBe(false);
  });
});

describe('due date presets', () => {
  it('are local noon, offset by whole days', () => {
    const tomorrow = dueDateFromToday(1, NOW);
    expect(toDateInput(tomorrow)).toBe('2026-08-06');
    expect(tomorrow.getHours()).toBe(12);
    expect(toDateInput(dueDateFromToday(7, NOW))).toBe('2026-08-12');
  });
});

describe('parseDateInput', () => {
  it('reads YYYY-MM-DD as local noon', () => {
    const result = parseDateInput('2026-08-05');
    expect(result.error).toBeUndefined();
    expect(result.date && toDateInput(result.date)).toBe('2026-08-05');
    expect(result.date?.getHours()).toBe(12);
  });

  it('treats empty input as no date', () => {
    expect(parseDateInput('  ')).toEqual({ date: null });
  });

  it('rejects other formats and impossible days', () => {
    expect(parseDateInput('05/08/2026').error).toBe('invalidDate');
    expect(parseDateInput('2026-13-01').error).toBe('invalidDate');
    expect(parseDateInput('2026-02-31').error).toBe('invalidDate');
    expect(parseDateInput('tomorrow').error).toBe('invalidDate');
  });
});

describe('parseDate and toDateInput', () => {
  it('returns null for empty or malformed values', () => {
    expect(parseDate(undefined)).toBeNull();
    expect(parseDate('nope')).toBeNull();
    expect(toDateInput(null)).toBe('');
  });

  it('round-trips a stored ISO timestamp', () => {
    const iso = dueDateFromToday(3, NOW).toISOString();
    expect(toDateInput(parseDate(iso))).toBe('2026-08-08');
  });
});

describe('formatDueLabel', () => {
  it('uses Today and Tomorrow, else a short date', () => {
    expect(formatDueLabel(new Date(2026, 7, 5, 12), en, 'en-GB', NOW)).toBe('Today');
    expect(formatDueLabel(new Date(2026, 7, 6, 12), en, 'en-GB', NOW)).toBe('Tomorrow');
    expect(formatDueLabel(new Date(2026, 7, 20, 12), en, 'en-GB', NOW)).toMatch(/20/);
  });
});
