/**
 * Small formatting helpers of the sales tax setup screens: rates, due days,
 * dates relative to today.
 */
import type { SetupTexts } from './setup-texts';

/**
 * A rate or percentage as the user reads it: "6.25", "8", "0.5". The API
 * sends numeric strings with four decimals ("6.2500") or plain numbers.
 */
export function formatPercent(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(n)) return String(value);
  return String(Math.round(n * 10000) / 10000);
}

/** "6.25%". */
export function formatRatePercent(value: string | number | null | undefined): string {
  const text = formatPercent(value);
  return text === '' ? '' : `${text}%`;
}

/** "Day 20 of the next month" or "Last day of the next month" (31 stands for the last day). */
export function dueDayText(
  dueDay: number,
  t: SetupTexts['dueDay'],
  format: (template: string, values: Record<string, unknown>) => string,
): string {
  return dueDay >= 31 ? t.last : format(t.day, { day: dueDay });
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. Negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export type RatePeriod = 'upcoming' | 'inForce' | 'ended';

/** Where a dated rate (or rule) stands on `today`. */
export function periodOf(range: { effectiveFrom: string; effectiveTo: string | null }, today: string): RatePeriod {
  if (range.effectiveFrom > today) return 'upcoming';
  if (range.effectiveTo && range.effectiveTo < today) return 'ended';
  return 'inForce';
}
