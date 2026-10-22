/**
 * Dashboard trend figures. A trend is only shown when there is a real
 * period-over-period percentage; a missing, non-numeric or zero-history value
 * shows nothing rather than a made-up "+0%".
 */

export interface Trend {
  /** "+12%" or "-4%". */
  label: string;
  isPositive: boolean;
}

export function formatTrend(change: number | null | undefined): Trend | null {
  if (change === null || change === undefined || !Number.isFinite(change)) return null;
  const rounded = Math.round(change);
  return { label: `${rounded > 0 ? '+' : ''}${rounded}%`, isPositive: rounded >= 0 };
}
