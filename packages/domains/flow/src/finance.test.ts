import { describe, expect, it } from 'vitest';
import {
  budgetShares,
  computeEvm,
  forecastAtCompletion,
  isoWeekKey,
  nextWeekStartMs,
  percentDone,
  percentOf,
  plannedFraction,
  ratio,
  roundMoney,
} from './finance';

const d = (s: string) => Date.parse(s);

describe('isoWeekKey', () => {
  it('numbers ISO weeks, including year borders', () => {
    expect(isoWeekKey(d('2026-11-02T08:00:00Z'))).toBe('2026-W45');
    expect(isoWeekKey(d('2026-01-01T00:00:00Z'))).toBe('2026-W01');
    expect(isoWeekKey(d('2027-01-01T00:00:00Z'))).toBe('2026-W53');
    expect(isoWeekKey(d('2024-12-30T00:00:00Z'))).toBe('2025-W01');
  });
  it('finds the next Monday', () => {
    expect(new Date(nextWeekStartMs(d('2026-11-04T10:00:00Z'))).toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(new Date(nextWeekStartMs(d('2026-11-02T00:00:00Z'))).toISOString()).toBe('2026-11-09T00:00:00.000Z');
  });
});

describe('budgetShares', () => {
  it('splits by hours', () => expect(budgetShares([10, 30])).toEqual([0.25, 0.75]));
  it('splits evenly with no hours', () => expect(budgetShares([0, 0])).toEqual([0.5, 0.5]));
  it('has none for no items', () => expect(budgetShares([])).toEqual([]));
});

describe('percentDone', () => {
  it('weights by estimate', () =>
    expect(percentDone([{ done: true, hours: 10 }, { done: false, hours: 30 }])).toBe(0.25));
  it('counts tasks without estimates', () =>
    expect(percentDone([{ done: true, hours: null }, { done: false, hours: null }])).toBe(0.5));
  it('is 0 with no tasks', () => expect(percentDone([])).toBe(0));
});

describe('plannedFraction', () => {
  it('runs linearly between the dates', () => {
    expect(plannedFraction(0, 100, 25)).toBe(0.25);
    expect(plannedFraction(0, 100, -5)).toBe(0);
    expect(plannedFraction(0, 100, 500)).toBe(1);
  });
  it('treats one date as both and none as unknown', () => {
    expect(plannedFraction(null, 100, 99)).toBe(0);
    expect(plannedFraction(null, 100, 100)).toBe(1);
    expect(plannedFraction(null, null, 1)).toBeNull();
  });
});

describe('computeEvm', () => {
  it('spreads the budget over the items', () => {
    const r = computeEvm({
      budget: 1000,
      items: [
        { id: 'a', plannedHours: 10, plannedStart: 0, plannedEnd: 100, percentDone: 0.5 },
        { id: 'b', plannedHours: 30, plannedStart: 0, plannedEnd: 200, percentDone: 0 },
      ],
      spanStart: 0,
      spanEnd: 200,
      now: 100,
    });
    expect(r.items.map((i) => i.budget)).toEqual([250, 750]);
    expect(r.plannedValue).toBe(250 + 375);
    expect(r.earnedValue).toBe(125);
  });
  it('uses the span for undated items and is zero without a budget', () => {
    const items = [{ id: null, plannedHours: 1, plannedStart: null, plannedEnd: null, percentDone: 1 }];
    expect(computeEvm({ budget: 100, items, spanStart: 0, spanEnd: 100, now: 50 }).plannedValue).toBe(50);
    expect(computeEvm({ budget: null, items, spanStart: 0, spanEnd: 100, now: 50 }).earnedValue).toBe(0);
  });
});

describe('forecastAtCompletion', () => {
  const base = { budget: 1000, actual: 500, committed: 0, cpi: 0.5, manual: null };
  it('divides the budget by CPI', () =>
    expect(forecastAtCompletion(base)).toEqual({ amount: 2000, source: 'cpi' }));
  it('prefers the manual forecast', () =>
    expect(forecastAtCompletion({ ...base, manual: 1500 })).toEqual({ amount: 1500, source: 'manual' }));
  it('falls back to the budget, not below spend and commitments', () => {
    expect(forecastAtCompletion({ ...base, cpi: null })).toEqual({ amount: 1000, source: 'budget' });
    expect(forecastAtCompletion({ ...base, cpi: 0, actual: 900, committed: 300 })).toEqual({ amount: 1200, source: 'budget' });
  });
  it('has none without a budget', () =>
    expect(forecastAtCompletion({ ...base, budget: null })).toEqual({ amount: null, source: null }));
});

describe('helpers', () => {
  it('rounds money and ratios', () => {
    expect(roundMoney(1.006)).toBe(1.01);
    expect(roundMoney(-2.346)).toBe(-2.35);
    expect(ratio(1, 0)).toBeNull();
    expect(percentOf(56, 100)).toBe(56);
    expect(percentOf(1, null)).toBeNull();
  });
});
