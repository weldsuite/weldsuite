import { describe, it, expect } from 'vitest';
import { getNoteBucket, type NoteBucketId } from './note-buckets';

const BUCKETS: NoteBucketId[] = ['today', 'yesterday', 'this-week', 'this-month', 'this-year', 'older'];

describe('getNoteBucket', () => {
  // Monday 5 Oct 2026: yesterday (Sunday 4 Oct) is not in the current ISO week.
  const monday = new Date(2026, 9, 5, 12, 0, 0);
  // Friday 9 Oct 2026.
  const friday = new Date(2026, 9, 9, 12, 0, 0);

  it('puts a note from earlier today in "today"', () => {
    expect(getNoteBucket(new Date(2026, 9, 5, 0, 5), monday)).toBe('today');
  });

  it('puts yesterday in "yesterday" only, even when it is outside the current week', () => {
    const sunday = new Date(2026, 9, 4, 23, 30);
    expect(getNoteBucket(sunday, monday)).toBe('yesterday');
  });

  it('puts earlier days of the current week in "this-week"', () => {
    expect(getNoteBucket(new Date(2026, 9, 6), friday)).toBe('this-week');
  });

  it('puts earlier days of the month before this week in "this-month"', () => {
    expect(getNoteBucket(new Date(2026, 9, 2), friday)).toBe('this-month');
  });

  it('puts a day in the previous week of a different month in "this-year"', () => {
    // Today Thu 1 Oct: Sep 29 is in the same ISO week but not the same month.
    const thursday = new Date(2026, 9, 1, 12);
    expect(getNoteBucket(new Date(2026, 8, 29), thursday)).toBe('this-week');
    expect(getNoteBucket(new Date(2026, 8, 20), thursday)).toBe('this-year');
  });

  it('puts notes from a previous year in "older"', () => {
    expect(getNoteBucket(new Date(2025, 11, 31), friday)).toBe('older');
  });

  it('accepts ISO strings', () => {
    expect(getNoteBucket(new Date(2026, 9, 9, 8).toISOString(), friday)).toBe('today');
  });

  it('assigns every day of a year to exactly one bucket, across month and week boundaries', () => {
    for (const now of [monday, friday, new Date(2026, 0, 1, 9), new Date(2026, 2, 1, 9), new Date(2026, 11, 31, 9)]) {
      for (let offset = -400; offset <= 10; offset++) {
        const created = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 15);
        const bucket = getNoteBucket(created, now);
        expect(BUCKETS.filter((b) => b === bucket)).toHaveLength(1);
      }
    }
  });
});
