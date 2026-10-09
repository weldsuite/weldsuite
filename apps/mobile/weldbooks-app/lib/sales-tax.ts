/**
 * US sales tax, as the app shows it.
 *
 * books-api calculates sales tax on the server (the entity's engine: manual,
 * Stripe Tax or Avalara) and hands the result back as `taxBreakdown` rows per
 * jurisdiction, `taxWarnings` and error codes. Nothing here calculates tax; it
 * groups what the server sent, picks the words for its warnings and refusals,
 * and turns its error bodies into a message the user can act on.
 */

import { isApiError, isNetworkError } from '@weldsuite/api-client/client';

import { toNumber } from '@/lib/currency';
import type { Translations } from '@/lib/i18n/locales/en';
import type { TaxBreakdownRow, TaxJurisdictionLevel } from '@/types/accounting';

// ---------------------------------------------------------------------------
// Tax breakdown
// ---------------------------------------------------------------------------

const LEVEL_ORDER: Record<TaxJurisdictionLevel, number> = { state: 0, county: 1, city: 2, district: 3 };

/** A document's tax for one jurisdiction, summed over its lines. */
export interface JurisdictionTax {
  key: string;
  name: string;
  level: TaxJurisdictionLevel | null;
  stateCode: string | null;
  /** Percentage of the taxable part, e.g. 6.25. */
  rate: number;
  taxableAmount: number;
  taxAmount: number;
  exemptAmount: number;
  nonTaxableAmount: number;
  /** Why part of the sale was exempt (a certificate's reason, a product rule), without repeats. */
  exemptReasons: string[];
  kind: 'tax' | 'use';
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The rows of a breakdown grouped per jurisdiction (and rate, since a state can
 * tax two product classes differently), state first, then county, city and
 * district. Rows from a VAT or GST document come through as their own groups,
 * one per rate name.
 */
export function groupTaxBreakdown(rows: readonly TaxBreakdownRow[] | null | undefined): JurisdictionTax[] {
  const groups = new Map<string, JurisdictionTax>();

  for (const row of rows ?? []) {
    const kind = row.kind === 'use' ? 'use' : 'tax';
    const name = row.jurisdictionName || row.taxRateName || row.jurisdictionCode || '';
    const rate = toNumber(row.taxRate);
    const key = [kind, row.jurisdictionCode ?? name, row.jurisdictionLevel ?? '', rate].join('|');

    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        name,
        level: row.jurisdictionLevel ?? null,
        stateCode: row.stateCode ?? null,
        rate,
        taxableAmount: 0,
        taxAmount: 0,
        exemptAmount: 0,
        nonTaxableAmount: 0,
        exemptReasons: [],
        kind,
      };
      groups.set(key, group);
    }
    group.taxableAmount = money(group.taxableAmount + toNumber(row.taxableAmount));
    group.taxAmount = money(group.taxAmount + toNumber(row.taxAmount));
    group.exemptAmount = money(group.exemptAmount + toNumber(row.exemptAmount));
    group.nonTaxableAmount = money(group.nonTaxableAmount + toNumber(row.nonTaxableAmount));
    if (row.exemptReason && !group.exemptReasons.includes(row.exemptReason)) {
      group.exemptReasons.push(row.exemptReason);
    }
  }

  return [...groups.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'tax' ? -1 : 1;
    const level = (a.level ? LEVEL_ORDER[a.level] : 9) - (b.level ? LEVEL_ORDER[b.level] : 9);
    return level !== 0 ? level : a.name.localeCompare(b.name);
  });
}

/** True when any part of the sale was exempt (a customer's certificate or a product the state doesn't tax). */
export function hasExemptRows(rows: readonly TaxBreakdownRow[] | null | undefined): boolean {
  return (rows ?? []).some((row) => toNumber(row.exemptAmount) > 0 || Boolean(row.exemptReason));
}

/** The reasons parts of the sale were exempt, without repeats. */
export function exemptReasonsOf(rows: readonly TaxBreakdownRow[] | null | undefined): string[] {
  const reasons: string[] = [];
  for (const row of rows ?? []) {
    if (row.exemptReason && !reasons.includes(row.exemptReason)) reasons.push(row.exemptReason);
  }
  return reasons;
}

/** Sales tax charged to the customer (not use tax accrued on a purchase). */
export function chargedTaxTotal(rows: readonly TaxBreakdownRow[] | null | undefined): number {
  return money((rows ?? []).filter((row) => row.kind !== 'use').reduce((sum, row) => sum + toNumber(row.taxAmount), 0));
}

/** Use tax accrued on a bill: owed to the state, not part of what the vendor is paid. */
export function accruedUseTaxTotal(rows: readonly TaxBreakdownRow[] | null | undefined): number {
  return money((rows ?? []).filter((row) => row.kind === 'use').reduce((sum, row) => sum + toNumber(row.taxAmount), 0));
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

/** `not_registered_in_state` or `tax_engine_unavailable: the provider timed out` → code and detail. */
export function parseTaxWarning(warning: string): { code: string; detail: string | null } {
  const index = warning.indexOf(':');
  if (index === -1) return { code: warning.trim(), detail: null };
  return { code: warning.slice(0, index).trim(), detail: warning.slice(index + 1).trim() || null };
}

/** The warning in words; an unknown code comes back as readable text rather than being dropped. */
export function taxWarningText(warning: string, texts: Translations['salesTax']['warnings']): string {
  const { code, detail } = parseTaxWarning(warning);
  const known = (texts as Record<string, string>)[code];
  if (known) return known;
  const readable = code.replaceAll('_', ' ');
  return detail ? `${readable}: ${detail}` : readable;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SalesTaxErrorCode =
  | 'ADDRESS_REQUIRED'
  | 'TAX_ENGINE_UNAVAILABLE'
  | 'TAX_RATES_NOT_CONFIGURED'
  | 'USE_TAX_ENGINE_UNSUPPORTED'
  | 'CREDIT_LINE_NOT_ON_ORIGINAL'
  | 'TAX_NOT_CALCULATED'
  | 'TAX_COMMIT_NOT_APPLICABLE';

const SALES_TAX_CODES: readonly string[] = [
  'ADDRESS_REQUIRED',
  'TAX_ENGINE_UNAVAILABLE',
  'TAX_RATES_NOT_CONFIGURED',
  'USE_TAX_ENGINE_UNSUPPORTED',
  'CREDIT_LINE_NOT_ON_ORIGINAL',
  'TAX_NOT_CALCULATED',
  'TAX_COMMIT_NOT_APPLICABLE',
];

/** The `{ error: { code } }` code of an API refusal, when it has one. */
export function apiErrorCode(err: unknown): string | null {
  if (!isApiError(err)) return null;
  const body = err.body as { error?: { code?: unknown } } | null | undefined;
  const code = body?.error?.code;
  return typeof code === 'string' ? code : null;
}

/** The sales tax code of a refusal (`ADDRESS_REQUIRED`, `TAX_ENGINE_UNAVAILABLE`, ...), or null for anything else. */
export function salesTaxErrorCode(err: unknown): SalesTaxErrorCode | null {
  const code = apiErrorCode(err);
  return code && SALES_TAX_CODES.includes(code) ? (code as SalesTaxErrorCode) : null;
}

/** True when the tax engine is down but the request itself was fine — trying again later can work. */
export function isRetryableTaxError(err: unknown): boolean {
  if (salesTaxErrorCode(err) !== 'TAX_ENGINE_UNAVAILABLE' || !isApiError(err)) return false;
  const body = err.body as { error?: { details?: { retryable?: unknown } } } | null | undefined;
  return body?.error?.details?.retryable === true || err.status === 503;
}

/**
 * A message for any failed request: the sales tax refusals in the user's own
 * words, "you're offline" for a request that never arrived, the server's text
 * otherwise, and `fallback` when there is nothing to say.
 */
export function describeApiError(err: unknown, t: Translations, fallback: string): string {
  switch (salesTaxErrorCode(err)) {
    case 'ADDRESS_REQUIRED':
      return t.salesTax.errors.addressRequired;
    case 'TAX_ENGINE_UNAVAILABLE':
      return isRetryableTaxError(err)
        ? t.salesTax.errors.engineUnavailableRetry
        : t.salesTax.errors.engineUnavailable;
    case 'TAX_RATES_NOT_CONFIGURED':
      return t.salesTax.errors.ratesNotConfigured;
    case 'USE_TAX_ENGINE_UNSUPPORTED':
      return t.salesTax.errors.useTaxUnsupported;
    case 'TAX_NOT_CALCULATED':
      return t.salesTax.errors.notCalculated;
    case 'CREDIT_LINE_NOT_ON_ORIGINAL':
      return t.salesTax.errors.creditLineNotOnOriginal;
    case 'TAX_COMMIT_NOT_APPLICABLE':
      return t.salesTax.errors.commitNotApplicable;
    case null:
      break;
  }
  if (isNetworkError(err)) return t.common.offlineError;
  return err instanceof Error && err.message ? err.message : fallback;
}
