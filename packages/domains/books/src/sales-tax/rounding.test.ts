import { describe, expect, it } from 'vitest';
import { allocateCents, fromCents, roundHalfUp, roundTaxCells, snap6, toCents } from './rounding';

describe('toCents / roundHalfUp', () => {
  it('rounds half-up at the half cent', () => {
    expect(toCents(0.005)).toBe(1);
    expect(toCents(0.004999)).toBe(0);
    expect(toCents(0.0049999)).toBe(0);
    expect(toCents(0.015)).toBe(2);
    expect(toCents(1.005)).toBe(101);
    expect(toCents(2.675)).toBe(268);
    expect(roundHalfUp(0.285)).toBe(0.29);
    expect(roundHalfUp(1.1449999)).toBe(1.14);
  });

  it('rounds the third decimal: five or more goes up', () => {
    expect(roundHalfUp(0.624)).toBe(0.62);
    expect(roundHalfUp(0.625)).toBe(0.63);
    expect(roundHalfUp(0.626)).toBe(0.63);
  });

  it('mirrors for credit memos (half away from zero)', () => {
    expect(toCents(-0.005)).toBe(-1);
    expect(toCents(-0.004)).toBe(0);
    expect(roundHalfUp(-0.625)).toBe(-0.63);
  });

  it('never returns negative zero', () => {
    expect(Object.is(toCents(-0.001), 0)).toBe(true);
    expect(Object.is(roundHalfUp(-0.001), 0)).toBe(true);
    expect(Object.is(fromCents(0), 0)).toBe(true);
  });

  it('survives binary floating point', () => {
    // 0.1 + 0.2 = 0.30000000000000004
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(8.875 * 0.1)).toBe(89);
    expect(snap6(1.6665000000000001)).toBe(1.6665);
  });
});

describe('allocateCents', () => {
  it('splits a total so the parts add up exactly (largest remainder)', () => {
    expect(allocateCents(1000, [5, 1.5, 0.75])).toEqual([690, 207, 103]);
    expect(allocateCents(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });

  it('shares equally when every weight is zero', () => {
    expect(allocateCents(3, [0, 0])).toEqual([2, 1]);
  });

  it('handles negative totals', () => {
    const parts = allocateCents(-100, [1, 1, 1]);
    expect(parts).toEqual([-34, -33, -33]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(-100);
  });

  it('allocates nothing for an empty list', () => {
    expect(allocateCents(10, [])).toEqual([]);
  });

  it('gives a zero total to everyone as zero', () => {
    expect(allocateCents(0, [3, 4])).toEqual([0, 0]);
  });
});

describe('roundTaxCells', () => {
  const cells = (rows: Array<[string, string, number]>) =>
    rows.map(([lineId, jurisdictionKey, unrounded]) => ({ lineId, jurisdictionKey, unrounded }));

  it('line + per_jurisdiction: every cell on its own', () => {
    const c = cells([
      ['a', 'state', 0.005],
      ['a', 'city', 0.005],
      ['b', 'state', 0.005],
    ]);
    expect(roundTaxCells(c, { level: 'line', scope: 'per_jurisdiction' })).toEqual([1, 1, 1]);
  });

  it('line + combined: one rounding per line, spread over its jurisdictions', () => {
    // Line a: 0.004 + 0.004 = 0.008 -> 1 cent in total; per jurisdiction would give 0 + 0.
    const c = cells([
      ['a', 'state', 0.004],
      ['a', 'city', 0.004],
      ['b', 'state', 0.004],
    ]);
    const out = roundTaxCells(c, { level: 'line', scope: 'combined' });
    expect(out[0] + out[1]).toBe(1);
    expect(out[2]).toBe(0);
  });

  it('invoice + per_jurisdiction: one rounding per jurisdiction, the remainder on the last line', () => {
    const c = cells([
      ['a', 'state', 0.005],
      ['b', 'state', 0.005],
      ['c', 'state', 0.005],
      ['a', 'city', 0.012],
      ['b', 'city', 0.012],
    ]);
    const out = roundTaxCells(c, { level: 'invoice', scope: 'per_jurisdiction' });
    // state: 0.015 -> 2 cents: 1, 1, 0.  city: 0.024 -> 2 cents: 1, 1.
    expect(out).toEqual([1, 1, 0, 1, 1]);
    expect(out[0] + out[1] + out[2]).toBe(2);
  });

  it('invoice + per_jurisdiction: the last line takes a negative difference too', () => {
    const c = cells([
      ['a', 'state', 0.006],
      ['b', 'state', 0.006],
      ['c', 'state', 0.006],
    ]);
    // 0.018 -> 2 cents; first two round to 1 each, the last takes 0.
    expect(roundTaxCells(c, { level: 'invoice', scope: 'per_jurisdiction' })).toEqual([1, 1, 0]);
    const d = cells([
      ['a', 'state', 0.0049],
      ['b', 'state', 0.0049],
    ]);
    // 0.0098 -> 1 cent: first 0, last 1.
    expect(roundTaxCells(d, { level: 'invoice', scope: 'per_jurisdiction' })).toEqual([0, 1]);
  });

  it('invoice + combined: one rounding for the whole document', () => {
    const c = cells([
      ['a', 'state', 0.004],
      ['a', 'city', 0.003],
      ['b', 'state', 0.004],
    ]);
    const out = roundTaxCells(c, { level: 'invoice', scope: 'combined' });
    // 0.011 -> 1 cent in total.
    expect(out.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('keeps the document total whatever the policy', () => {
    const c = cells([
      ['a', 'state', 1.6665],
      ['a', 'city', 0.49995],
      ['b', 'state', 1.6665],
      ['b', 'city', 0.49995],
    ]);
    const expected = toCents(1.6665 * 2) + toCents(0.49995 * 2);
    expect(roundTaxCells(c, { level: 'invoice', scope: 'per_jurisdiction' }).reduce((a, b) => a + b, 0)).toBe(expected);
    expect(roundTaxCells(c, { level: 'invoice', scope: 'combined' }).reduce((a, b) => a + b, 0)).toBe(
      toCents(1.6665 * 2 + 0.49995 * 2),
    );
  });

  it('returns an empty list for no cells', () => {
    expect(roundTaxCells([])).toEqual([]);
  });
});
