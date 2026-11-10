import { describe, expect, it } from 'vitest';
import { planLimit, utcMonthRange } from './plan-limits';

const TABLE = { free: 100, starter: 1_000, business: null } as const;

describe('planLimit', () => {
  it('reads the plan slug from the table; null is unlimited', () => {
    expect(planLimit(TABLE, { slug: 'free', paid: false })).toBe(100);
    expect(planLimit(TABLE, { slug: 'starter', paid: true })).toBe(1_000);
    expect(planLimit(TABLE, { slug: 'business', paid: true })).toBeNull();
  });

  it('gives a plan the table does not list the free row, unless it is paid (then unlimited)', () => {
    expect(planLimit(TABLE, { slug: null, paid: false })).toBe(100);
    expect(planLimit(TABLE, { slug: 'custom-free', paid: false })).toBe(100);
    expect(planLimit(TABLE, { slug: 'custom-paid', paid: true })).toBeNull();
    expect(planLimit({ pro: 5 }, { slug: 'free', paid: false })).toBeNull();
  });

  it('does not read inherited object keys as plan slugs', () => {
    expect(planLimit(TABLE, { slug: 'constructor', paid: false })).toBe(100);
  });
});

describe('utcMonthRange', () => {
  it('is the UTC calendar month containing the moment, end exclusive', () => {
    const { start, end } = utcMonthRange(new Date('2026-12-31T23:59:59Z'));
    expect(start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(utcMonthRange(new Date('2026-11-09T12:00:00Z')).start.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });
});
