import { describe, expect, it } from 'vitest';
import { isCompletion, nextOccurrenceDate } from './recurrence';

const iso = (date: Date) => date.toISOString();
const long = new Date('2025-01-01T00:00:00.000Z');

describe('nextOccurrenceDate', () => {
  it('adds one step for each frequency', () => {
    const due = new Date('2031-03-10T09:00:00.000Z');
    expect(iso(nextOccurrenceDate(due, { frequency: 'daily' }, long))).toBe('2031-03-11T09:00:00.000Z');
    expect(iso(nextOccurrenceDate(due, { frequency: 'weekly' }, long))).toBe('2031-03-17T09:00:00.000Z');
    expect(iso(nextOccurrenceDate(due, { frequency: 'biweekly' }, long))).toBe('2031-03-24T09:00:00.000Z');
    expect(iso(nextOccurrenceDate(due, { frequency: 'monthly' }, long))).toBe('2031-04-10T09:00:00.000Z');
    expect(iso(nextOccurrenceDate(due, { frequency: 'yearly' }, long))).toBe('2032-03-10T09:00:00.000Z');
  });

  it('supports custom intervals in days, weeks, months and years', () => {
    const due = new Date('2031-03-10T00:00:00.000Z');
    expect(iso(nextOccurrenceDate(due, { frequency: 'custom', interval: 3, unit: 'days' }, long))).toBe(
      '2031-03-13T00:00:00.000Z',
    );
    expect(iso(nextOccurrenceDate(due, { frequency: 'custom', interval: 2, unit: 'weeks' }, long))).toBe(
      '2031-03-24T00:00:00.000Z',
    );
    expect(iso(nextOccurrenceDate(due, { frequency: 'custom', interval: 2, unit: 'months' }, long))).toBe(
      '2031-05-10T00:00:00.000Z',
    );
    expect(iso(nextOccurrenceDate(due, { frequency: 'custom', interval: 1, unit: 'years' }, long))).toBe(
      '2032-03-10T00:00:00.000Z',
    );
  });

  it('clamps a month-end day instead of spilling into the next month', () => {
    expect(iso(nextOccurrenceDate(new Date('2031-01-31T00:00:00.000Z'), { frequency: 'monthly' }, long))).toBe(
      '2031-02-28T00:00:00.000Z',
    );
    expect(iso(nextOccurrenceDate(new Date('2032-01-31T00:00:00.000Z'), { frequency: 'monthly' }, long))).toBe(
      '2032-02-29T00:00:00.000Z',
    );
    expect(iso(nextOccurrenceDate(new Date('2031-03-31T00:00:00.000Z'), { frequency: 'monthly' }, long))).toBe(
      '2031-04-30T00:00:00.000Z',
    );
    expect(iso(nextOccurrenceDate(new Date('2032-02-29T00:00:00.000Z'), { frequency: 'yearly' }, long))).toBe(
      '2033-02-28T00:00:00.000Z',
    );
  });

  it('does not drift: a skipped month still lands on the anchor day afterwards', () => {
    // Anchor Jan 31, "now" is in March: Feb 28 is already past, so the next is Mar 31 (not Mar 28).
    const now = new Date('2031-03-05T00:00:00.000Z');
    expect(iso(nextOccurrenceDate(new Date('2031-01-31T00:00:00.000Z'), { frequency: 'monthly' }, now))).toBe(
      '2031-03-31T00:00:00.000Z',
    );
  });

  it('rolls an overdue task forward until the next due date is in the future', () => {
    const now = new Date('2031-03-20T12:00:00.000Z');
    // Weekly from Mar 1: Mar 8, 15 are past, Mar 22 is next.
    expect(iso(nextOccurrenceDate(new Date('2031-03-01T00:00:00.000Z'), { frequency: 'weekly' }, now))).toBe(
      '2031-03-22T00:00:00.000Z',
    );
    // Daily, a week overdue: tomorrow.
    expect(iso(nextOccurrenceDate(new Date('2031-03-13T00:00:00.000Z'), { frequency: 'daily' }, now))).toBe(
      '2031-03-21T00:00:00.000Z',
    );
  });

  it('counts from now when the task had no due date', () => {
    const now = new Date('2031-03-20T12:00:00.000Z');
    expect(iso(nextOccurrenceDate(null, { frequency: 'weekly' }, now))).toBe('2031-03-27T12:00:00.000Z');
  });
});

describe('isCompletion', () => {
  it('is true only when the status lands on done from something else', () => {
    expect(isCompletion('todo', 'done')).toBe(true);
    expect(isCompletion('in_progress', 'done')).toBe(true);
    expect(isCompletion('done', 'done')).toBe(false);
    expect(isCompletion('todo', 'in_progress')).toBe(false);
    expect(isCompletion('done', 'todo')).toBe(false);
    expect(isCompletion(undefined, undefined)).toBe(false);
  });
});
