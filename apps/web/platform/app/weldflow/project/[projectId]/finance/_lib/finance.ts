/**
 * Finance screen helpers: money and percent formatting, and the S-curve points
 * built from the weekly snapshots plus the current figures.
 */

import type { FinanceSnapshot, ProjectFinance } from '@weldsuite/app-api-client/domains/project-finance';

const DAY_MS = 86_400_000;

/** A money amount (a decimal string) in the project's currency; an en dash when there is none. */
export function formatMoney(
  value: string | null | undefined,
  currency: string | null,
  intlLocale: string,
  fractionDigits = 0,
): string {
  if (value === null || value === undefined || value === '') return '–';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '–';
  const options = { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits };
  try {
    return new Intl.NumberFormat(intlLocale, { style: 'currency', currency: currency ?? 'EUR', ...options }).format(amount);
  } catch {
    return new Intl.NumberFormat(intlLocale, options).format(amount);
  }
}

/** `+€1.200` or `−€300`: a variance with its sign. */
export function formatSigned(
  value: string | null | undefined,
  currency: string | null,
  intlLocale: string,
): string {
  if (value === null || value === undefined) return '–';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '–';
  if (amount === 0) return formatMoney('0', currency, intlLocale);
  return `${amount > 0 ? '+' : ''}${formatMoney(value, currency, intlLocale)}`;
}

/** A ratio such as the CPI, two decimals in the user's locale. */
export function formatRatio(value: number | null, intlLocale: string): string {
  if (value === null) return '–';
  return new Intl.NumberFormat(intlLocale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

/** A percentage with at most one decimal (`56`, `5,6`). */
export function formatPercent(value: number | null, intlLocale: string): string {
  if (value === null) return '–';
  return new Intl.NumberFormat(intlLocale, { maximumFractionDigits: 1 }).format(value);
}

/** Monday 00:00 UTC of an ISO week key (`2026-W45`), in epoch ms; null when it is not one. */
export function weekStartMs(week: string): number | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!match) return null;
  const year = Number(match[1]);
  const number = Number(match[2]);
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Weekday = (new Date(jan4).getUTCDay() + 6) % 7;
  return jan4 - jan4Weekday * DAY_MS + (number - 1) * 7 * DAY_MS;
}

export interface CurvePoint {
  /** Epoch ms. */
  t: number;
  planned?: number | null;
  earned?: number | null;
  actual?: number | null;
  forecast?: number | null;
}

export interface Curve {
  points: CurvePoint[];
  /** The budget line: the amount, or 100 when only percentages are shown. */
  budget: number | null;
  /** The forecast at completion on the same scale. */
  forecast: number | null;
  today: number;
  /** True: the values are percentages of the budget. */
  percent: boolean;
}

const toNumber = (value: string | null): number | null => (value === null ? null : Number(value));

/**
 * The curve points: one per weekly snapshot, the current figures as the last
 * point, and a dashed forecast from today to the project's end. A caller
 * without finance rights gets the same curve in percent of the budget.
 */
export function buildCurve(
  snapshots: readonly FinanceSnapshot[],
  finance: ProjectFinance,
  endMs: number | null,
  now: number,
): Curve {
  const percent = !finance.canSeeAmounts;
  const points: CurvePoint[] = [];
  for (const snapshot of snapshots) {
    const t = weekStartMs(snapshot.week);
    if (t === null || t >= now) continue;
    points.push(
      percent
        ? { t, planned: snapshot.percent.planned, earned: snapshot.percent.earned, actual: snapshot.percent.spent }
        : {
            t,
            planned: toNumber(snapshot.plannedValue),
            earned: toNumber(snapshot.earnedValue),
            actual: toNumber(snapshot.actualCost),
          },
    );
  }
  points.sort((a, b) => a.t - b.t);

  const figures = finance.figures;
  const current: CurvePoint = percent
    ? { t: now, planned: finance.percent.planned, earned: finance.percent.earned, actual: finance.percent.spent }
    : {
        t: now,
        planned: toNumber(figures.plannedValue),
        earned: toNumber(figures.earnedValue),
        actual: toNumber(figures.actual),
      };
  const forecast = percent ? finance.percent.forecast : toNumber(figures.forecast);
  if (forecast !== null && endMs !== null && endMs > now) {
    current.forecast = current.actual ?? null;
    points.push(current, { t: endMs, forecast });
  } else {
    points.push(current);
  }
  return { points, budget: percent ? (finance.percent.spent === null ? null : 100) : toNumber(figures.budget), forecast, today: now, percent };
}
