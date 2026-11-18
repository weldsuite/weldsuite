/**
 * The anomaly band: median ± k·1.4826·MAD, k by sensitivity, no band below
 * seven baseline points, and robust to one spike in the baseline.
 */

import { describe, expect, it } from 'vitest';
import { MAD_SCALE, MIN_BASELINE_POINTS, anomalyBand, median, medianAbsoluteDeviation, outsideBand } from './anomaly';

describe('median and MAD', () => {
  it('takes the middle value, or the mean of the two middle ones', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
  });

  it('measures spread around the median', () => {
    // |x - 3| = 2, 1, 0, 1, 2 → median 1
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 5])).toBe(1);
    expect(medianAbsoluteDeviation([7, 7, 7])).toBe(0);
  });
});

describe('anomalyBand', () => {
  const baseline = [100, 102, 98, 101, 99, 103, 97, 100, 100, 101];

  it('is median ± k·1.4826·MAD, k = 4, 3, 2 for low, medium, high', () => {
    const mad = medianAbsoluteDeviation(baseline);
    const m = median(baseline);
    for (const [sensitivity, k] of [['low', 4], ['medium', 3], ['high', 2]] as const) {
      const band = anomalyBand(baseline, sensitivity)!;
      expect(band.median).toBe(m);
      expect(band.spread).toBeCloseTo(k * MAD_SCALE * mad, 10);
      expect(band.lower).toBeCloseTo(m - k * MAD_SCALE * mad, 10);
      expect(band.upper).toBeCloseTo(m + k * MAD_SCALE * mad, 10);
    }
  });

  it('is skipped below seven points (non-finite ones do not count)', () => {
    expect(MIN_BASELINE_POINTS).toBe(7);
    expect(anomalyBand([1, 2, 3, 4, 5, 6], 'medium')).toBeNull();
    expect(anomalyBand([1, 2, 3, 4, 5, 6, Number.NaN], 'medium')).toBeNull();
    expect(anomalyBand([1, 2, 3, 4, 5, 6, 7], 'medium')).not.toBeNull();
  });

  it('is not widened by one spike in the baseline', () => {
    const spiky = [...baseline.slice(0, 9), 5000];
    expect(anomalyBand(spiky, 'medium')!.upper).toBeLessThan(110);
  });

  it('says which edge a value crossed', () => {
    const band = anomalyBand(baseline, 'high')!;
    expect(outsideBand(150, band)).toEqual({ outside: true, bound: band.upper });
    expect(outsideBand(50, band)).toEqual({ outside: true, bound: band.lower });
    expect(outsideBand(100, band).outside).toBe(false);
  });

  it('fires on any move away from a flat baseline (MAD 0)', () => {
    const band = anomalyBand([0, 0, 0, 0, 0, 0, 0], 'low')!;
    expect(outsideBand(1, band).outside).toBe(true);
    expect(outsideBand(0, band).outside).toBe(false);
  });
});
