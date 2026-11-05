/**
 * Risk helpers of the RAID screens: score and band, the 5x5 matrix cells, the
 * summary tiles and the score trend.
 *
 * The score rules mirror `@weldsuite/flow-domain/risk` (flow-api and the Rust
 * flow-domain own them; the platform does not depend on that package). Keep the
 * bands in step: score = probability x impact, 1-4 low, 5-9 medium, 10-16 high,
 * 17-25 critical (two ratings from 1 to 5 never multiply to 17-19).
 */

import { differenceInCalendarDays } from 'date-fns';
import type { RaidAssessment, RaidItem, RaidMatrix, RiskBand } from '@weldsuite/app-api-client/domains/project-control';

export const RATING_MIN = 1;
export const RATING_MAX = 5;
export const RATINGS = [1, 2, 3, 4, 5] as const;
export const RISK_BANDS: readonly RiskBand[] = ['low', 'medium', 'high', 'critical'];
export const MAX_RISK_SCORE = RATING_MAX * RATING_MAX;

/** The scores of each band (see the file header). */
export const RISK_BAND_RANGES: Readonly<Record<RiskBand, { min: number; max: number }>> = {
  low: { min: 1, max: 4 },
  medium: { min: 5, max: 9 },
  high: { min: 10, max: 16 },
  critical: { min: 17, max: MAX_RISK_SCORE },
};

/** How often a risk of each band is reviewed, unless it sets its own interval. */
export const DEFAULT_REVIEW_INTERVAL_DAYS: Readonly<Record<RiskBand, number>> = {
  critical: 7,
  high: 14,
  medium: 30,
  low: 90,
};

/**
 * The built-in categories (stored by key, labelled per locale). The workspace
 * hides some and adds its own (`useRiskCategories`); `riskCategoryOptions` in
 * `copy.ts` builds what the form offers. A stored value outside the list is
 * shown as typed.
 */
export { RISK_CATEGORIES } from '@weldsuite/app-api-client/schemas/project-control';

export function riskScore(probability: number, impact: number): number {
  return probability * impact;
}

/** The band of a score from 1 to 25. */
export function riskBand(score: number): RiskBand {
  if (score <= RISK_BAND_RANGES.low.max) return 'low';
  if (score <= RISK_BAND_RANGES.medium.max) return 'medium';
  if (score <= RISK_BAND_RANGES.high.max) return 'high';
  return 'critical';
}

/** The review interval in days: the risk's own, else its band's default. */
export function reviewIntervalDays(band: RiskBand, override?: number | null): number {
  return override ?? DEFAULT_REVIEW_INTERVAL_DAYS[band];
}

// ── Items ───────────────────────────────────────────────────────────────────

export function isOpenItem(item: Pick<RaidItem, 'closedAt'>): boolean {
  return item.closedAt === null;
}

export interface MatrixCellRef {
  probability: number;
  impact: number;
}

/**
 * The matrix cell of a risk: where it is now, or after mitigation. A risk with
 * no after-mitigation rating stays in its current cell, as `/matrix` counts it.
 */
export function riskCell(
  risk: Pick<RaidItem, 'probability' | 'impact' | 'residualProbability' | 'residualImpact'>,
  residual: boolean,
): MatrixCellRef | null {
  const probability = residual ? (risk.residualProbability ?? risk.probability) : risk.probability;
  const impact = residual ? (risk.residualImpact ?? risk.impact) : risk.impact;
  return probability === null || impact === null ? null : { probability, impact };
}

export function sameCell(a: MatrixCellRef | null, b: MatrixCellRef | null): boolean {
  return a !== null && b !== null && a.probability === b.probability && a.impact === b.impact;
}

/** The risks in the selected matrix cell; every risk while no cell is selected. */
export function filterRisksByCell<T extends Pick<RaidItem, 'probability' | 'impact' | 'residualProbability' | 'residualImpact'>>(
  risks: readonly T[],
  cell: MatrixCellRef | null,
  residual: boolean,
): T[] {
  if (!cell) return [...risks];
  return risks.filter((risk) => sameCell(riskCell(risk, residual), cell));
}

/** Highest score first, then the earliest review, then the oldest number. */
export function sortRisks<T extends Pick<RaidItem, 'score' | 'dueAt' | 'number'>>(risks: readonly T[]): T[] {
  return [...risks].sort((a, b) => {
    const byScore = (b.score ?? 0) - (a.score ?? 0);
    if (byScore !== 0) return byScore;
    if (a.dueAt !== b.dueAt) {
      if (a.dueAt === null) return 1;
      if (b.dueAt === null) return -1;
      const byDue = new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
      if (byDue !== 0) return byDue;
    }
    return a.number - b.number;
  });
}

/** The count of one matrix cell (0 when the matrix has not loaded). */
export function matrixCount(matrix: Pick<RaidMatrix, 'cells'> | undefined, cell: MatrixCellRef): number {
  return matrix?.cells.find((c) => c.probability === cell.probability && c.impact === cell.impact)?.count ?? 0;
}

// ── Dates ───────────────────────────────────────────────────────────────────

export type DueStatus =
  | { kind: 'none' }
  | { kind: 'overdue'; days: number }
  | { kind: 'today' }
  | { kind: 'tomorrow' }
  | { kind: 'in'; days: number };

/** Where a due date stands against today, in calendar days. */
export function dueStatus(dueAt: string | null, now: Date): DueStatus {
  if (!dueAt) return { kind: 'none' };
  const days = differenceInCalendarDays(new Date(dueAt), now);
  if (days < 0) return { kind: 'overdue', days: -days };
  if (days === 0) return { kind: 'today' };
  if (days === 1) return { kind: 'tomorrow' };
  return { kind: 'in', days };
}

export function isOverdue(dueAt: string | null, now: Date): boolean {
  return dueStatus(dueAt, now).kind === 'overdue';
}

export type ReviewInterval = { unit: 'week' | 'twoWeeks' | 'month' | 'quarter' } | { unit: 'days'; days: number };

/** The review interval as the screens word it ("every 2 weeks"). */
export function reviewIntervalLabel(days: number): ReviewInterval {
  switch (days) {
    case 7:
      return { unit: 'week' };
    case 14:
      return { unit: 'twoWeeks' };
    case 30:
      return { unit: 'month' };
    case 90:
      return { unit: 'quarter' };
    default:
      return { unit: 'days', days };
  }
}

// ── Summary tiles ───────────────────────────────────────────────────────────

export interface RiskStats {
  open: number;
  critical: number;
  high: number;
  reviewsOverdue: number;
  tasksDone: number;
  tasksTotal: number;
  /** Whole percent of linked tasks that are done; null when no task is linked. */
  tasksPercent: number | null;
}

/** The tiles above the register, from the open risks. */
export function riskStats(openRisks: readonly RaidItem[], now: Date): RiskStats {
  let critical = 0;
  let high = 0;
  let reviewsOverdue = 0;
  let tasksDone = 0;
  let tasksTotal = 0;
  for (const risk of openRisks) {
    if (risk.band === 'critical') critical += 1;
    if (risk.band === 'high') high += 1;
    if (isOverdue(risk.dueAt, now)) reviewsOverdue += 1;
    tasksDone += risk.taskProgress.done;
    tasksTotal += risk.taskProgress.total;
  }
  return {
    open: openRisks.length,
    critical,
    high,
    reviewsOverdue,
    tasksDone,
    tasksTotal,
    tasksPercent: tasksTotal === 0 ? null : Math.round((tasksDone / tasksTotal) * 100),
  };
}

// ── Score over time ─────────────────────────────────────────────────────────

export type Trend = 'up' | 'down' | 'flat' | 'none';

/** Rising, falling or stable: the newest assessment against the one before it. `assessments` newest first. */
export function trendOf(assessments: readonly Pick<RaidAssessment, 'score'>[]): Trend {
  if (assessments.length < 2) return 'none';
  const [latest, previous] = assessments;
  if (latest.score > previous.score) return 'up';
  if (latest.score < previous.score) return 'down';
  return 'flat';
}

export interface TrendPoint {
  x: number;
  y: number;
  score: number;
  band: RiskBand;
  assessedAt: string;
}

export interface TrendChart {
  points: TrendPoint[];
  /** The `points` attribute of the polyline. */
  polyline: string;
  /** Where the band backgrounds change, as y offsets from the top of the plot. */
  bands: { band: RiskBand; y: number; height: number }[];
  plot: { top: number; bottom: number; left: number; right: number };
}

const TREND_PLOT = { top: 14, bottom: 84, left: 16, right: 224 } as const;
/** Boundaries between bands on the score axis, halfway between the scores a band can hold. */
const BAND_BOUNDARIES: Readonly<Record<RiskBand, { from: number; to: number }>> = {
  low: { from: 0, to: 4.5 },
  medium: { from: 4.5, to: 9.5 },
  high: { from: 9.5, to: 18 },
  critical: { from: 18, to: MAX_RISK_SCORE },
};

function scoreToY(score: number): number {
  const { top, bottom } = TREND_PLOT;
  return bottom - (score / MAX_RISK_SCORE) * (bottom - top);
}

/** The last `limit` assessments laid out oldest to newest in the 240 x 120 chart. `assessments` newest first. */
export function buildTrendChart(
  assessments: readonly Pick<RaidAssessment, 'score' | 'band' | 'assessedAt'>[],
  limit = 8,
): TrendChart {
  const recent = assessments.slice(0, limit).reverse();
  const { left, right } = TREND_PLOT;
  const step = recent.length > 1 ? (right - left) / (recent.length - 1) : 0;
  const points = recent.map((assessment, index) => ({
    x: recent.length > 1 ? left + step * index : (left + right) / 2,
    y: scoreToY(assessment.score),
    score: assessment.score,
    band: assessment.band,
    assessedAt: assessment.assessedAt,
  }));
  const bands = RISK_BANDS.map((band) => {
    const { from, to } = BAND_BOUNDARIES[band];
    return { band, y: scoreToY(to), height: scoreToY(from) - scoreToY(to) };
  });
  return {
    points,
    polyline: points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '),
    bands,
    plot: TREND_PLOT,
  };
}

/** Which chart points get a date label: all of a short series, else the ends and the middle. */
export function trendLabelIndexes(count: number): number[] {
  if (count <= 4) return Array.from({ length: count }, (_, index) => index);
  return [0, Math.floor((count - 1) / 2), count - 1];
}
