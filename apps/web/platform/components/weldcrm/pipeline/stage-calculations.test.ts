import { describe, it, expect } from 'vitest';
import {
  computeStageCalculation,
  normalizeStageCalculations,
  type CalculationStage,
} from './stage-calculations';

const context = { defaultCurrency: 'EUR' };

const usd = (value: number) => ({ value, currency: 'USD' });
const eur = (value: number) => ({ value, currency: 'EUR' });

const stage = (id: string, deals: CalculationStage['deals'], probability = 50): CalculationStage => ({
  id,
  probability,
  deals,
});

describe('computeStageCalculation', () => {
  it("is computed from the stage's current deals, so it follows an edit or a move", () => {
    const before = stage('s1', [usd(5300)]);
    expect(computeStageCalculation({ type: 'total' }, before, [before], context)).toMatch(/5.?300/);

    // A deal moves in: the same saved setting now shows the new total.
    const after = stage('s1', [usd(5300), usd(800)]);
    expect(computeStageCalculation({ type: 'total' }, after, [after], context)).toMatch(/6.?100/);
  });

  it("uses the deals' currency, not the pipeline default", () => {
    const s = stage('s1', [usd(5300)]);
    const text = computeStageCalculation({ type: 'total' }, s, [s], context);
    expect(text).toContain('$');
    expect(text).not.toContain('€');
  });

  it("shows an empty stage's zero in the currency of the pipeline's other deals", () => {
    const empty = stage('s2', []);
    const filled = stage('s1', [usd(5300)]);
    const text = computeStageCalculation({ type: 'total' }, empty, [filled, empty], context);
    expect(text).toContain('$');
    expect(text).not.toContain('€');
  });

  it('falls back to the pipeline default currency when there are no deals at all', () => {
    const empty = stage('s1', []);
    expect(computeStageCalculation({ type: 'total' }, empty, [empty], { defaultCurrency: 'GBP' })).toContain('£');
  });

  it('does not add different currencies into one wrong number', () => {
    const s = stage('s1', [usd(100), eur(200)]);
    const text = computeStageCalculation({ type: 'total' }, s, [s], context);
    expect(text).toContain('$');
    expect(text).toContain('€');
    expect(text).toContain(' + ');
  });

  it('averages and weights per currency', () => {
    const s = stage('s1', [usd(100), usd(300)], 50);
    expect(computeStageCalculation({ type: 'average' }, s, [s], context)).toMatch(/200/);
    expect(computeStageCalculation({ type: 'weighted' }, s, [s], context)).toMatch(/200/);
    expect(computeStageCalculation({ type: 'average' }, stage('s2', []), [s], context)).toMatch(/\$.?0|0.?\$/);
  });

  it("shows the stage's probability as the win rate", () => {
    const s = stage('s1', [usd(1)], 75);
    expect(computeStageCalculation({ type: 'winRate' }, s, [s], context)).toBe('75%');
  });

  it("shares the pipeline's value between stages", () => {
    const a = stage('a', [usd(300)]);
    const b = stage('b', [usd(100)]);
    expect(computeStageCalculation({ type: 'distribution' }, a, [a, b], context)).toBe('75.0%');
    expect(computeStageCalculation({ type: 'distribution' }, b, [a, b], context)).toBe('25.0%');
  });

  it('shares deals, not mixed-currency amounts, when the pipeline has several currencies', () => {
    const a = stage('a', [usd(1_000_000), usd(1)]);
    const b = stage('b', [eur(5)]);
    expect(computeStageCalculation({ type: 'distribution' }, a, [a, b], context)).toBe('66.7%');
  });

  it('is 0% of nothing, not NaN', () => {
    const empty = stage('s1', []);
    expect(computeStageCalculation({ type: 'distribution' }, empty, [empty], context)).toBe('0.0%');
  });

  it('shows the formula text of a custom calculation', () => {
    const s = stage('s1', [usd(1)]);
    expect(computeStageCalculation({ type: 'custom', value: 'total_value * 0.9' }, s, [s], context)).toBe(
      'total_value * 0.9',
    );
    expect(computeStageCalculation({ type: 'custom' }, s, [s], context)).toBe('-');
    expect(computeStageCalculation({ type: 'nonsense' }, s, [s], context)).toBe('-');
  });
});

describe('normalizeStageCalculations', () => {
  it('drops the stale stored text of computed calculations and keeps a custom formula', () => {
    expect(
      normalizeStageCalculations({
        s1: { type: 'total', value: '€0' },
        s2: { type: 'winRate', value: '50%' },
        s3: { type: 'custom', value: 'count / 2' },
      }),
    ).toEqual({
      s1: { type: 'total' },
      s2: { type: 'winRate' },
      s3: { type: 'custom', value: 'count / 2' },
    });
  });

  it('tolerates settings that were never saved', () => {
    expect(normalizeStageCalculations(undefined)).toEqual({});
  });
});
