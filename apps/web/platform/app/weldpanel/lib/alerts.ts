/**
 * Alerts in the UI: the spec the live preview runs, the anomaly band the
 * checker uses (the same robust statistics as panel-api's `anomaly.ts`), and
 * which series of a report an alert watches.
 */

import type { PanelAlertCondition, PanelAnomalySensitivity, PanelCheckInterval } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import type { PanelDatePreset, PanelInterval, PanelTrendsSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';

/** Below this many baseline points the checker skips the anomaly check. */
export const MIN_BASELINE_POINTS = 7;
export const MAD_SCALE = 1.4826;
export const SENSITIVITY_K: Record<PanelAnomalySensitivity, number> = { low: 4, medium: 3, high: 2 };
/** The checker's baseline: the 28 intervals before the one checked. */
export const BASELINE_POINTS = 28;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface AnomalyBand {
  median: number;
  lower: number;
  upper: number;
}

/** median ± k·1.4826·MAD of the baseline, or null with fewer than 7 points. */
export function anomalyBand(baseline: readonly number[], sensitivity: PanelAnomalySensitivity): AnomalyBand | null {
  const points = baseline.filter((v) => Number.isFinite(v));
  if (points.length < MIN_BASELINE_POINTS) return null;
  const m = median(points);
  const mad = median(points.map((v) => Math.abs(v - m)));
  const spread = SENSITIVITY_K[sensitivity] * MAD_SCALE * mad;
  return { median: m, lower: m - spread, upper: m + spread };
}

/** The chart interval and period the preview shows for a check interval: enough points for a baseline. */
export const PREVIEW_RANGE: Record<PanelCheckInterval, { interval: PanelInterval; preset: PanelDatePreset }> = {
  hourly: { interval: 'hour', preset: '7d' },
  daily: { interval: 'day', preset: '90d' },
  weekly: { interval: 'week', preset: '12m' },
};

/**
 * The trends spec the preview runs: the watched spec at the check's interval
 * over a period long enough for a baseline, one series only, no comparison
 * and no breakdown (the checker reads one number per interval).
 */
export function previewSpec(spec: PanelTrendsSpec, seriesIndex: number, checkInterval: PanelCheckInterval): PanelTrendsSpec {
  const { interval, preset } = PREVIEW_RANGE[checkInterval];
  const series = spec.series[seriesIndex] ?? spec.series[0];
  const out: PanelTrendsSpec = { ...spec, series: series ? [series] : [], interval, dateRange: { preset }, compare: false };
  delete out.breakdown;
  delete out.breakdowns;
  delete out.formulas;
  delete out.formulaOnly;
  delete out.display;
  return out;
}

/** An inline single-event trends spec for an alert of its own. */
export function eventAlertSpec(projectId: string, event: string, math: 'total' | 'unique_users', timezone: string): PanelTrendsSpec {
  return {
    kind: 'trends',
    projectId,
    series: [{ event, math, filters: [] }],
    interval: 'day',
    dateRange: { preset: '30d' },
    filters: [],
    compare: false,
    timezone,
  };
}

/**
 * The values the preview judges: the last complete interval is the checked
 * one, the ones before it the baseline. The current (incomplete) interval is
 * dropped, as the checker never looks at it.
 */
export function splitForCheck(values: readonly number[]): { baseline: number[]; last: number | null } {
  const complete = values.slice(0, -1);
  if (complete.length === 0) return { baseline: [], last: null };
  return { baseline: complete.slice(-1 - BASELINE_POINTS, -1), last: complete[complete.length - 1] ?? null };
}

/** Horizontal lines for the preview: the threshold, or the anomaly band's edges. */
export function conditionGuides(condition: PanelAlertCondition, values: readonly number[]): { threshold: number | null; band: AnomalyBand | null } {
  if (condition.type === 'threshold') return { threshold: condition.value, band: null };
  if (condition.type === 'anomaly') return { threshold: null, band: anomalyBand(splitForCheck(values).baseline, condition.sensitivity) };
  return { threshold: null, band: null };
}
