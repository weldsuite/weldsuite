/**
 * Anomaly bands for alerts: robust statistics, so one spike in the baseline
 * does not widen the band the way a standard deviation would.
 *
 *   band = median ± k · 1.4826 · MAD
 *
 * MAD is the median absolute deviation from the median; 1.4826 scales it to
 * a standard deviation for normally distributed data. k is 4, 3 or 2 for low,
 * medium and high sensitivity. Fewer than {@link MIN_BASELINE_POINTS} points:
 * no band (the check is skipped, never guessed).
 */

import type { PanelAnomalySensitivity } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';

export const MIN_BASELINE_POINTS = 7;

/** The scale that makes a MAD comparable to a standard deviation. */
export const MAD_SCALE = 1.4826;

export const SENSITIVITY_K: Record<PanelAnomalySensitivity, number> = { low: 4, medium: 3, high: 2 };

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Median absolute deviation from the median. */
export function medianAbsoluteDeviation(values: readonly number[]): number {
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

export interface AnomalyBand {
  median: number;
  /** The scaled MAD (k · 1.4826 · MAD). */
  spread: number;
  lower: number;
  upper: number;
}

/** The band for a baseline, or null when it has too few finite points. */
export function anomalyBand(baseline: readonly number[], sensitivity: PanelAnomalySensitivity): AnomalyBand | null {
  const points = baseline.filter((v) => Number.isFinite(v));
  if (points.length < MIN_BASELINE_POINTS) return null;
  const m = median(points);
  const spread = SENSITIVITY_K[sensitivity] * MAD_SCALE * medianAbsoluteDeviation(points);
  return { median: m, spread, lower: m - spread, upper: m + spread };
}

/** Whether `value` is outside the band, and which edge it crossed. */
export function outsideBand(value: number, band: AnomalyBand): { outside: boolean; bound: number } {
  if (value > band.upper) return { outside: true, bound: band.upper };
  if (value < band.lower) return { outside: true, bound: band.lower };
  return { outside: false, bound: value >= band.median ? band.upper : band.lower };
}
