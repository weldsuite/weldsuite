import { describe, expect, it } from 'vitest';
import {
  DUE_SOON_DAYS,
  countStatuses,
  daysBetween,
  deadlineHref,
  deadlineStatus,
  groupByMonth,
  type DeadlineLike,
} from './deadline-status';

const TODAY = '2026-03-10';
const item = (dueDate: string, extra: Partial<DeadlineLike> = {}): DeadlineLike => ({ completed: false, dueDate, ...extra });

describe('daysBetween', () => {
  it('counts whole calendar days, forward and back', () => {
    expect(daysBetween('2026-03-10', '2026-03-24')).toBe(14);
    expect(daysBetween('2026-03-10', '2026-03-09')).toBe(-1);
    expect(daysBetween('2026-03-10', '2026-03-10')).toBe(0);
  });

  it('is not thrown off by a daylight saving change', () => {
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
    expect(daysBetween('2026-10-31', '2026-11-02')).toBe(2);
  });

  it('crosses a leap day', () => {
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
  });
});

describe('deadlineStatus', () => {
  it('is done when marked or filed, however late', () => {
    expect(deadlineStatus(item('2026-01-15', { completed: true }), TODAY)).toBe('done');
    expect(deadlineStatus(item('2026-12-15', { completed: true }), TODAY)).toBe('done');
  });

  it('is overdue the day after the due date', () => {
    expect(deadlineStatus(item('2026-03-09'), TODAY)).toBe('overdue');
    expect(deadlineStatus(item('2025-04-15'), TODAY)).toBe('overdue');
  });

  it('is due soon from today through the next two weeks', () => {
    expect(deadlineStatus(item('2026-03-10'), TODAY)).toBe('dueSoon');
    expect(deadlineStatus(item('2026-03-24'), TODAY)).toBe('dueSoon');
    expect(DUE_SOON_DAYS).toBe(14);
  });

  it('is upcoming beyond that', () => {
    expect(deadlineStatus(item('2026-03-25'), TODAY)).toBe('upcoming');
    expect(deadlineStatus(item('2027-01-31'), TODAY)).toBe('upcoming');
  });

  it('never calls an informational item overdue or due soon', () => {
    expect(deadlineStatus(item('2026-01-31', { informational: true }), TODAY)).toBe('informational');
    expect(deadlineStatus(item('2026-03-11', { informational: true }), TODAY)).toBe('informational');
    expect(deadlineStatus(item('2026-01-31', { informational: true, completed: true }), TODAY)).toBe('done');
  });
});

describe('groupByMonth', () => {
  it('groups by due month, earliest first, and orders a month by date then title', () => {
    const groups = groupByMonth([
      { dueDate: '2026-04-15', title: 'B' },
      { dueDate: '2026-01-31', title: 'Z' },
      { dueDate: '2026-04-15', title: 'A' },
      { dueDate: '2026-01-15', title: 'M' },
      { dueDate: '2026-12-01', title: 'Q' },
    ]);
    expect(groups.map((group) => group.month)).toEqual(['2026-01', '2026-04', '2026-12']);
    expect(groups[0]?.items.map((entry) => entry.title)).toEqual(['M', 'Z']);
    expect(groups[1]?.items.map((entry) => entry.title)).toEqual(['A', 'B']);
  });

  it('is empty for no deadlines', () => {
    expect(groupByMonth([])).toEqual([]);
  });
});

describe('countStatuses', () => {
  it('counts each state and leaves informational items out', () => {
    const counts = countStatuses(
      [
        item('2026-01-15'),
        item('2026-02-15'),
        item('2026-03-12'),
        item('2026-03-20'),
        item('2026-06-15'),
        item('2026-01-01', { completed: true }),
        item('2026-02-01', { informational: true }),
      ],
      TODAY,
    );
    expect(counts).toEqual({ overdue: 2, dueSoon: 2, upcoming: 1, done: 1 });
  });
});

describe('deadlineHref', () => {
  it('sends sales tax deadlines to the returns and 1099s to the 1099 screen', () => {
    expect(deadlineHref({ kind: 'sales_tax', form: 'sales_tax' })).toBe('/weldbooks/sales-tax/returns');
    expect(deadlineHref({ kind: 'information_return', form: '1099_nec' })).toBe('/weldbooks/form-1099');
    expect(deadlineHref({ kind: 'information_return', form: '1099_misc' })).toBe('/weldbooks/form-1099');
  });

  it('has no screen for the rest', () => {
    expect(deadlineHref({ kind: 'information_return', form: '945' })).toBeNull();
    expect(deadlineHref({ kind: 'income_tax_return', form: 'f1120s' })).toBeNull();
    expect(deadlineHref({ kind: 'payroll', form: '941' })).toBeNull();
  });
});
