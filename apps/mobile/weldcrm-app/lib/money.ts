/**
 * Money helpers for WeldCRM.
 *
 * Deals carry their own `currency` (the server defaults it to EUR), and a
 * workspace has one default currency in its settings. Totals only add up
 * amounts in the same currency; the rest are counted, never converted, so a
 * USD deal can't silently inflate a EUR figure.
 */

type NumericInput = number | string | null | undefined;

/** What a deal without a currency, and a workspace without a saved currency, is denominated in. */
export const DEFAULT_CURRENCY = 'EUR';

/** Currencies offered when a deal is entered on the phone; any ISO code already on a deal still shows. */
export const DEAL_CURRENCIES = [
  'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF',
  'CAD', 'AUD', 'NZD', 'JPY', 'CNY', 'INR', 'BRL', 'MXN', 'ZAR', 'AED',
] as const;

/** Parse an app-api decimal string ("1234.50") to a number, 0 when empty or malformed. */
export function toNumber(value: NumericInput): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** An upper-case ISO 4217 code `Intl` can format, or null for anything else. */
export function usableCurrency(currency: string | null | undefined): string | null {
  return currency && /^[A-Za-z]{3}$/.test(currency.trim()) ? currency.trim().toUpperCase() : null;
}

/** The currency a workspace-level figure is shown in. */
export function resolveCurrency(currency: string | null | undefined): string {
  return usableCurrency(currency) ?? DEFAULT_CURRENCY;
}

/**
 * "€1,234.50" for the given currency and locale. `compact` abbreviates large
 * figures for KPI tiles ("€1.2K"); small amounts stay exact. Never throws: an
 * unknown currency shows the bare number.
 */
export function formatMoney(
  amount: NumericInput,
  currency: string | null | undefined,
  locale: string,
  options: { compact?: boolean } = {},
): string {
  const value = toNumber(amount);
  const code = usableCurrency(currency);
  const compact = options.compact === true && Math.abs(value) >= 1_000;
  try {
    return new Intl.NumberFormat(locale, {
      ...(code ? { style: 'currency' as const, currency: code } : {}),
      ...(compact
        ? { notation: 'compact' as const, maximumFractionDigits: 1 }
        : { minimumFractionDigits: 0, maximumFractionDigits: 2 }),
    }).format(value);
  } catch {
    const prefix = code ? `${code} ` : '';
    return `${prefix}${value.toFixed(2)}`;
  }
}

/** "€" for EUR, "$" for USD; the code itself when the platform has no symbol. */
export function currencySymbol(currency: string | null | undefined, locale: string): string {
  const code = resolveCurrency(currency);
  try {
    const parts = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
    }).formatToParts(0);
    return parts.find((part) => part.type === 'currency')?.value ?? code;
  } catch {
    return code;
  }
}

export interface MoneyRow {
  amount?: NumericInput;
  currency?: string | null;
}

export interface CurrencyTotal {
  /** Sum of the rows denominated in `currency`. */
  total: number;
  /** How many rows were added up. */
  included: number;
  /** How many rows were left out because they are in another currency. */
  excluded: number;
}

/**
 * Add up the rows that are in `currency` (a row without a currency counts as
 * the workspace currency, like the server's default). Rows in other currencies
 * are only counted.
 */
export function sumInCurrency(rows: readonly MoneyRow[], currency: string): CurrencyTotal {
  const target = resolveCurrency(currency);
  let total = 0;
  let included = 0;
  let excluded = 0;
  for (const row of rows) {
    const rowCurrency = usableCurrency(row.currency);
    if (rowCurrency && rowCurrency !== target) {
      excluded += 1;
      continue;
    }
    total += toNumber(row.amount);
    included += 1;
  }
  return { total, included, excluded };
}
