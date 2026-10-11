import { fromCents, toCents } from '@weldsuite/app-api-client/schemas/partners';

/**
 * Format a USD-style amount for display. Contract amounts are decimal strings
 * ("199.50") or integer cents; both end up in the same Intl currency format.
 */
export function formatCents(cents: number, currency = 'USD', locale?: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}

export function formatMoneyString(amount: string, currency = 'USD', locale?: string): string {
  try {
    return formatCents(toCents(amount), currency, locale);
  } catch {
    // Not a clean decimal (should not happen) — show it as received.
    return amount;
  }
}

/** A per-credit price keeps its decimals ("0.004"): cents-rounding would show $0.00. */
export function formatUnitPrice(price: string, currency = 'USD', locale?: string): string {
  const value = Number(price);
  if (!Number.isFinite(value)) return price;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
}

/** Cents → the plain "199.50" string used in request bodies. */
export const centsToAmount = fromCents;

/** Drops trailing zeros and a dangling decimal point ("12.50" → "12.5", "12.00" → "12"). */
function trimTrailingZeros(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '0') end--;
  if (end > 0 && value[end - 1] === '.') end--;
  return value.slice(0, end);
}

export function formatPercentBps(bps: number): string {
  const percent = bps / 100;
  return Number.isInteger(percent) ? String(percent) : trimTrailingZeros(percent.toFixed(2));
}
