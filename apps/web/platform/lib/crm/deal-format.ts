/**
 * Shared deal (opportunity) formatting: money in the deal's own currency and
 * one close-date format, so the kanban card, the create dialog, the Company
 * pipeline tab and the deal panel never disagree (TASK-671 / TASK-949).
 */

import { ISO_4217_CURRENCY_CODES } from '@weldsuite/core-api-client/schemas/opportunities';

/**
 * Currency a deal carries when it has none of its own. Matches the server
 * default (`crm_opportunities.currency` / `createOpportunity`), which is what
 * the deal panel already showed while the card and dialog hardcoded `$`.
 */
export const DEFAULT_DEAL_CURRENCY = 'EUR';

/** The currency to display for a deal: its own code, else `fallback`. */
export function resolveDealCurrency(
  currency: string | null | undefined,
  fallback: string = DEFAULT_DEAL_CURRENCY,
): string {
  const code = currency?.trim().toUpperCase();
  return code && /^[A-Z]{3}$/.test(code) ? code : fallback;
}

export interface FormatDealMoneyOptions {
  /** Fraction digits to show. Default 0 for whole-unit display on cards. */
  fractionDigits?: number;
  /** Use compact notation (1.2M) for amounts >= 1,000,000. */
  compactMillions?: boolean;
}

/** Intl currency formatting that survives an unknown code instead of throwing. */
export function formatDealMoney(
  amount: number,
  currency: string | null | undefined,
  { fractionDigits = 0, compactMillions = false }: FormatDealMoneyOptions = {},
): string {
  const code = resolveDealCurrency(currency);
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
      notation: compactMillions && Math.abs(amount) >= 1_000_000 ? 'compact' : 'standard',
    }).format(amount);
  } catch {
    return `${code} ${amount.toFixed(fractionDigits)}`;
  }
}

/** An amount in a deal's own currency (`currency` empty = the caller's fallback). */
export interface DealAmount {
  amount: number;
  currency?: string | null;
}

/**
 * Sum amounts per currency, in first-seen order. Adding euros to dollars into
 * one number and labelling it with a single symbol is wrong, so totals stay
 * split by currency.
 */
export function sumByCurrency(
  items: readonly DealAmount[],
  fallbackCurrency: string = DEFAULT_DEAL_CURRENCY,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const item of items) {
    const code = resolveDealCurrency(item.currency, fallbackCurrency);
    totals.set(code, (totals.get(code) ?? 0) + item.amount);
  }
  return totals;
}

/**
 * The currency most of `items` carry (ties go to the one seen first), or
 * `fallback` when there are none. Used to give an empty total ("Won €0") the
 * same currency as the totals around it instead of a hard-coded default.
 */
export function dominantCurrency(
  items: readonly { currency?: string | null }[],
  fallback: string = DEFAULT_DEAL_CURRENCY,
): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const code = resolveDealCurrency(item.currency, fallback);
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  let best = fallback;
  let bestCount = 0;
  for (const [code, count] of counts) {
    if (count > bestCount) {
      best = code;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Format per-currency totals as one string ("€1,200 + $500"). With nothing to
 * add it shows a zero in `emptyCurrency`.
 */
export function formatCurrencyTotals(
  totals: ReadonlyMap<string, number>,
  emptyCurrency: string = DEFAULT_DEAL_CURRENCY,
  options?: FormatDealMoneyOptions,
): string {
  if (totals.size === 0) return formatDealMoney(0, emptyCurrency, options);
  return [...totals.entries()].map(([code, sum]) => formatDealMoney(sum, code, options)).join(' + ');
}

/**
 * `sumByCurrency` + `formatCurrencyTotals`: the total value of a set of deals.
 * A deal without a currency counts as `DEFAULT_DEAL_CURRENCY`, the same as on
 * its card; `emptyCurrency` only decides which zero an empty set shows.
 */
export function formatDealTotals(
  deals: readonly DealAmount[],
  { emptyCurrency, ...options }: FormatDealMoneyOptions & { emptyCurrency?: string } = {},
): string {
  return formatCurrencyTotals(sumByCurrency(deals), emptyCurrency, options);
}

/** Just the currency symbol (`€`, `$`, ...) for input adornments. */
export function dealCurrencySymbol(currency: string | null | undefined): string {
  const code = resolveDealCurrency(currency);
  try {
    const part = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
    })
      .formatToParts(0)
      .find((p) => p.type === 'currency');
    return part?.value ?? code;
  } catch {
    return code;
  }
}

/** Close-date format shared by the card, panel and Company pipeline tab. */
export function formatDealDate(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : null;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Local `YYYY-MM-DD` of a stored timestamp, for a native date input. */
export function toDateInputValue(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Local midnight of a `YYYY-MM-DD` input value as ISO: the same instant the
 * create-deal date picker stores, so both show the same calendar day.
 */
export function fromDateInputValue(value: string): string | null {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day).toISOString();
}

export interface CurrencyOption {
  value: string;
  /** `EUR - Euro` (falls back to the bare code where Intl has no name). */
  label: string;
}

/** ISO 4217 options for a currency picker, labelled with the English currency name. */
export function getCurrencyOptions(): CurrencyOption[] {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(['en'], { type: 'currency' });
  } catch {
    names = null;
  }
  return ISO_4217_CURRENCY_CODES.map((code) => {
    const name = names?.of(code);
    return { value: code, label: name && name !== code ? `${code} - ${name}` : code };
  });
}
