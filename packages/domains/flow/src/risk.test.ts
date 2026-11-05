import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_INTERVAL_DAYS,
  RISK_BAND_RANGES,
  buildRiskMatrix,
  isRating,
  movedIntoCritical,
  nextReviewAt,
  ratingError,
  residualPairError,
  reviewIntervalDays,
  riskBand,
  riskScore,
} from './risk';

describe('riskScore', () => {
  it('multiplies probability by impact', () => {
    expect(riskScore(1, 1)).toBe(1);
    expect(riskScore(2, 3)).toBe(6);
    expect(riskScore(5, 5)).toBe(25);
  });

  it('rejects anything but whole numbers from 1 to 5', () => {
    expect(() => riskScore(0, 3)).toThrow(RangeError);
    expect(() => riskScore(3, 6)).toThrow(RangeError);
    expect(() => riskScore(2.5, 2)).toThrow(RangeError);
    expect(() => riskScore(Number.NaN, 2)).toThrow(RangeError);
  });
});

describe('riskBand', () => {
  it('puts every possible score in its band', () => {
    const bands: Record<number, string> = {};
    for (let p = 1; p <= 5; p++) for (let i = 1; i <= 5; i++) bands[p * i] = riskBand(p * i);
    expect(bands).toEqual({
      1: 'low',
      2: 'low',
      3: 'low',
      4: 'low',
      5: 'medium',
      6: 'medium',
      8: 'medium',
      9: 'medium',
      10: 'high',
      12: 'high',
      15: 'high',
      16: 'high',
      20: 'critical',
      25: 'critical',
    });
  });

  it('keeps the band edges: 4 low, 5 medium, 9 medium, 10 high, 16 high, 20 critical', () => {
    expect(riskBand(4)).toBe('low');
    expect(riskBand(5)).toBe('medium');
    expect(riskBand(9)).toBe('medium');
    expect(riskBand(10)).toBe('high');
    expect(riskBand(16)).toBe('high');
    expect(riskBand(20)).toBe('critical');
  });

  it('leaves no integer score between two bands', () => {
    const bands = Object.values(RISK_BAND_RANGES);
    for (let score = 1; score <= 25; score++) {
      expect(bands.filter((range) => score >= range.min && score <= range.max)).toHaveLength(1);
    }
  });

  it('rejects scores outside 1-25', () => {
    expect(() => riskBand(0)).toThrow(RangeError);
    expect(() => riskBand(26)).toThrow(RangeError);
    expect(() => riskBand(7.5)).toThrow(RangeError);
  });
});

describe('review interval', () => {
  it('is 7, 14, 30 and 90 days for critical, high, medium and low', () => {
    expect(DEFAULT_REVIEW_INTERVAL_DAYS).toEqual({ critical: 7, high: 14, medium: 30, low: 90 });
  });

  it("uses the risk's own interval over the band's", () => {
    expect(reviewIntervalDays('high')).toBe(14);
    expect(reviewIntervalDays('high', null)).toBe(14);
    expect(reviewIntervalDays('high', 3)).toBe(3);
  });

  it('moves the next review by whole days', () => {
    const from = new Date('2026-11-03T09:00:00.000Z');
    expect(nextReviewAt(from, 'critical').toISOString()).toBe('2026-11-10T09:00:00.000Z');
    expect(nextReviewAt(from, 'low').toISOString()).toBe('2027-02-01T09:00:00.000Z');
    expect(nextReviewAt(from, 'medium', 2).toISOString()).toBe('2026-11-05T09:00:00.000Z');
  });
});

describe('movedIntoCritical', () => {
  it('is true only when a lower band becomes critical', () => {
    expect(movedIntoCritical(16, 20)).toBe(true);
    expect(movedIntoCritical(1, 25)).toBe(true);
    expect(movedIntoCritical(20, 25)).toBe(false);
    expect(movedIntoCritical(25, 20)).toBe(false);
    expect(movedIntoCritical(25, 16)).toBe(false);
    expect(movedIntoCritical(4, 9)).toBe(false);
  });
});

describe('validation', () => {
  it('accepts ratings 1 to 5 only', () => {
    expect([0, 1, 5, 6, 2.5, '3', null].map(isRating)).toEqual([false, true, true, false, false, false, false]);
    expect(ratingError('probability', 3)).toBeNull();
    expect(ratingError('impact', 6)).toBe('impact must be a whole number from 1 to 5');
  });

  it('wants the residual probability and impact together', () => {
    expect(residualPairError(null, null)).toBeNull();
    expect(residualPairError(undefined, undefined)).toBeNull();
    expect(residualPairError(2, 3)).toBeNull();
    expect(residualPairError(2, null)).toBe('residualProbability and residualImpact must be set together');
    expect(residualPairError(undefined, 3)).toBe('residualProbability and residualImpact must be set together');
  });
});

describe('buildRiskMatrix', () => {
  it('always returns 25 cells, probability then impact ascending', () => {
    const cells = buildRiskMatrix([{ probability: 3, impact: 4, count: 2 }]);
    expect(cells).toHaveLength(25);
    expect(cells[0]).toEqual({ probability: 1, impact: 1, count: 0 });
    expect(cells[1]).toEqual({ probability: 1, impact: 2, count: 0 });
    expect(cells[24]).toEqual({ probability: 5, impact: 5, count: 0 });
    expect(cells.find((cell) => cell.probability === 3 && cell.impact === 4)?.count).toBe(2);
    expect(cells.reduce((sum, cell) => sum + cell.count, 0)).toBe(2);
  });
});
