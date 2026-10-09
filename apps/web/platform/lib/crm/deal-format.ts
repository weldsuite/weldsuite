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
