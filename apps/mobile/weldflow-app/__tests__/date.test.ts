import { isTaskOverdue } from '@/lib/date';

// 22 Oct 2026, mid-afternoon local time.
const NOW = new Date(2026, 9, 22, 15, 30);

describe('isTaskOverdue', () => {
  it('is not overdue on its due day, all day long', () => {
    expect(isTaskOverdue('2026-10-22', 'todo', NOW)).toBe(false);
    expect(isTaskOverdue('2026-10-22', 'todo', new Date(2026, 9, 22, 23, 59))).toBe(false);
    expect(isTaskOverdue(new Date(2026, 9, 22).toISOString(), 'todo', NOW)).toBe(false);
  });

  it('is overdue once the due day has passed', () => {
    expect(isTaskOverdue(new Date(2026, 9, 21).toISOString(), 'todo', NOW)).toBe(true);
    expect(isTaskOverdue(new Date(2026, 9, 21).toISOString(), 'todo', new Date(2026, 9, 22, 0, 1))).toBe(true);
  });

  it('is not overdue when due later', () => {
    expect(isTaskOverdue(new Date(2026, 9, 23).toISOString(), 'in_progress', NOW)).toBe(false);
  });

  it('never marks finished or undated tasks', () => {
    expect(isTaskOverdue(new Date(2026, 9, 1).toISOString(), 'done', NOW)).toBe(false);
    expect(isTaskOverdue(new Date(2026, 9, 1).toISOString(), 'cancelled', NOW)).toBe(false);
    expect(isTaskOverdue(null, 'todo', NOW)).toBe(false);
    expect(isTaskOverdue('not a date', 'todo', NOW)).toBe(false);
  });
});
