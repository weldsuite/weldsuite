/**
 * Risk rules — score, band, review interval and input checks of the RAID log's
 * risks (design: weldflow-project-control.md, "Data model").
 *
 * Pure functions, no database and no Hono context. flow-api's `/api/project-raid`
 * routes use them, and the Rust flow-domain mirrors them.
 *
 *   score = probability × impact, both whole numbers from 1 to 5
 *
 *   Band      Scores   Review every
 *   Low       1–4      90 days
 *   Medium    5–9      30 days
 *   High      10–16    14 days
 *   Critical  20–25    7 days
 */

import type { RiskBand } from '@weldsuite/app-api-client/schemas/project-control';

export type { RiskBand };

export const RATING_MIN = 1;
export const RATING_MAX = 5;
export const MAX_RISK_SCORE = RATING_MAX * RATING_MAX;

/**
 * The scores of each band. Two whole numbers from 1 to 5 multiply to 1, 2, 3,
 * 4, 5, 6, 8, 9, 10, 12, 15, 16, 20 or 25, so 17–19 cannot occur; the critical
 * range starts at 17 only so that no integer score falls between two bands.
 */
export const RISK_BAND_RANGES: Readonly<Record<RiskBand, { min: number; max: number }>> = {
  low: { min: 1, max: 4 },
  medium: { min: 5, max: 9 },
  high: { min: 10, max: 16 },
  critical: { min: 17, max: MAX_RISK_SCORE },
};

/** How often a risk of each band is reviewed, unless the risk sets its own interval. */
export const DEFAULT_REVIEW_INTERVAL_DAYS: Readonly<Record<RiskBand, number>> = {
  critical: 7,
  high: 14,
  medium: 30,
  low: 90,
};

const DAY_MS = 86_400_000;

/** A probability or impact: a whole number from 1 to 5. */
export function isRating(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= RATING_MIN && value <= RATING_MAX;
}

/** The 400 message for a bad probability or impact, or null when it is fine. */
export function ratingError(field: string, value: unknown): string | null {
  return isRating(value) ? null : `${field} must be a whole number from ${RATING_MIN} to ${RATING_MAX}`;
}

/** probability × impact. Both must be ratings (1–5), otherwise this throws a RangeError. */
export function riskScore(probability: number, impact: number): number {
  if (!isRating(probability) || !isRating(impact)) {
    throw new RangeError(`probability and impact must be whole numbers from ${RATING_MIN} to ${RATING_MAX}`);
  }
  return probability * impact;
}

/** The band of a score (1–25); anything else throws a RangeError. */
export function riskBand(score: number): RiskBand {
  if (!Number.isInteger(score) || score < 1 || score > MAX_RISK_SCORE) {
    throw new RangeError(`score must be a whole number from 1 to ${MAX_RISK_SCORE}`);
  }
  if (score <= RISK_BAND_RANGES.low.max) return 'low';
  if (score <= RISK_BAND_RANGES.medium.max) return 'medium';
  if (score <= RISK_BAND_RANGES.high.max) return 'high';
  return 'critical';
}

/** The review interval in days: the risk's own when it has one, else its band's default. */
export function reviewIntervalDays(band: RiskBand, override?: number | null): number {
  return override ?? DEFAULT_REVIEW_INTERVAL_DAYS[band];
}

/** The next review date: `from` plus the review interval. */
export function nextReviewAt(from: Date, band: RiskBand, override?: number | null): Date {
  return new Date(from.getTime() + reviewIntervalDays(band, override) * DAY_MS);
}

/** True when a score move puts a risk into the critical band from a lower one. */
export function movedIntoCritical(previousScore: number, nextScore: number): boolean {
  return riskBand(nextScore) === 'critical' && riskBand(previousScore) !== 'critical';
}

/**
 * The 400 message when only one of the residual probability and impact is set
 * (a null means "not assessed"), or null when both or neither are.
 */
export function residualPairError(
  residualProbability: number | null | undefined,
  residualImpact: number | null | undefined,
): string | null {
  const hasProbability = residualProbability !== null && residualProbability !== undefined;
  const hasImpact = residualImpact !== null && residualImpact !== undefined;
  return hasProbability === hasImpact ? null : 'residualProbability and residualImpact must be set together';
}

export interface MatrixCell {
  probability: number;
  impact: number;
  count: number;
}

/**
 * The 5×5 matrix as 25 cells, probability then impact ascending, with the
 * counts of the given groups filled in and every other cell at 0.
 */
export function buildRiskMatrix(counts: ReadonlyArray<MatrixCell>): MatrixCell[] {
  const cells: MatrixCell[] = [];
  for (let probability = RATING_MIN; probability <= RATING_MAX; probability++) {
    for (let impact = RATING_MIN; impact <= RATING_MAX; impact++) {
      const found = counts.find((cell) => cell.probability === probability && cell.impact === impact);
      cells.push({ probability, impact, count: found?.count ?? 0 });
    }
  }
  return cells;
}
