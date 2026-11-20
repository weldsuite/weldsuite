import type { ComparisonPoint } from '@weldsuite/ui/components/comparison-chart';

/** `YYYY-MM` keys as UTC dates, so no time zone moves them into the previous month. */
const monthDate = (key: string) => new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1));
const monthKey = (year: number, month: number) => {
  const date = new Date(Date.UTC(year, month - 1, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
};

const money = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR' });
const compactMoney = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', notation: 'compact', maximumFractionDigits: 1 });
const short = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' });
const shortYear = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const long = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** The formatters a WeldBooks card passes, in euros and British English. */
export const formatters = {
  formatTick: (key: string) => shortYear.format(monthDate(key)),
  formatAxisValue: (value: number) => compactMoney.format(value),
  formatValue: (value: number) => money.format(value),
  formatPeriod: (key: string) => long.format(monthDate(key)),
};

export const formatShortMonth = (key: string) => short.format(monthDate(key));
export const formatMoney = (value: number) => money.format(value);

/** A fixed wobble, so the lines read as booked rather than drawn. */
const wobble = (i: number) => 1 + 0.08 * Math.sin(i * 2.3);

/** Twelve months ending November 2026, each against the twelve before. */
export function lastTwelveMonths(base: number, growth = 1.03): ComparisonPoint[] {
  return Array.from({ length: 12 }, (_, i) => ({
    month: monthKey(2025, 12 + i),
    value: Math.round(base * growth ** (i + 12) * wobble(i + 12)),
    compareMonth: monthKey(2024, 12 + i),
    compareValue: Math.round(base * growth ** i * wobble(i)),
  }));
}

/** This year's running total up to November, against all of last year's. */
export function yearToDate(base: number): ComparisonPoint[] {
  let running = 0;
  let lastYear = 0;
  return Array.from({ length: 12 }, (_, i) => {
    lastYear += Math.round(base * 0.9 * wobble(i));
    const inRange = i < 11;
    if (inRange) running += Math.round(base * wobble(i + 5));
    return {
      month: monthKey(2026, i + 1),
      value: inRange ? running : undefined,
      compareMonth: monthKey(2025, i + 1),
      compareValue: lastYear,
    };
  });
}

/** Profit that dips below zero over the summer. */
export function lossMaking(): ComparisonPoint[] {
  return lastTwelveMonths(1).map((point, i) => ({
    ...point,
    value: Math.round(6_000 * Math.cos((i / 11) * Math.PI * 2) + 1_500),
    compareValue: Math.round(4_000 * Math.cos((i / 11) * Math.PI * 2) + 2_500),
  }));
}

/** Books with nothing booked: every month zero. */
export function nothingBooked(): ComparisonPoint[] {
  return lastTwelveMonths(1).map((point) => ({ ...point, value: 0, compareValue: 0 }));
}
