/**
 * The exchange rate a foreign-currency document is booked at.
 *
 * Convention everywhere (journal lines, invoices, bills, payments): foreign
 * units per base unit. A USD invoice on a EUR entity with 1 EUR = 1.08 USD
 * carries 1.08, and 108.00 USD books as 100.00 EUR.
 *
 * A rate comes from, in order: the one the user typed on the document, a rate
 * stored in `fx_rates` on or before the document date, the ECB feed (which is
 * stored too, so the booking can be reproduced). When none exists the posting
 * is refused: booking a USD document at 1.000000 puts the wrong amount in the
 * ledger, so there is no silent fallback.
 */

import type { Database } from '@weldsuite/worker-kit/db';
import { fetchFeedRate, lookupStoredRate } from './accounting-currency';
import { PostingError } from './accounting-posting';

export type RateSource = 'same_currency' | 'override' | 'stored' | 'feed';

export interface ResolvedRate {
  /** Foreign units per base unit, as stored (6 decimals). */
  rate: string;
  source: RateSource;
}

export class MissingExchangeRateError extends PostingError {
  constructor(
    readonly currency: string,
    readonly baseCurrency: string,
    date: Date,
  ) {
    super(
      `No exchange rate found for ${currency} against ${baseCurrency} on ${date.toISOString().slice(0, 10)}. ` +
        `Add the rate under FX rates, or enter an exchange rate on the document, and try again.`,
    );
    this.name = 'MissingExchangeRateError';
  }
}

/** A usable rate: a finite number above zero. */
export function parseRate(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The column format (numeric(12,6)). */
export function formatRate(rate: number): string {
  return rate.toFixed(6);
}

export function isForeignCurrency(baseCurrency: string, currency: string | null | undefined): boolean {
  return Boolean(currency) && currency!.toUpperCase() !== baseCurrency.toUpperCase();
}

/**
 * The rate for `currency` against the entity's base on `date`, or null when
 * none can be found. `override` (a rate the user typed) wins.
 */
export async function resolveRate(
  db: Database,
  args: {
    baseCurrency: string;
    currency: string;
    date: Date;
    override?: string | number | null;
    /** Ask the ECB feed when nothing is stored (default). */
    useFeed?: boolean;
  },
): Promise<ResolvedRate | null> {
  if (!isForeignCurrency(args.baseCurrency, args.currency)) return { rate: '1.000000', source: 'same_currency' };

  const typed = parseRate(args.override);
  if (typed) return { rate: formatRate(typed), source: 'override' };

  const stored = await lookupStoredRate(db, args.baseCurrency, args.currency, args.date);
  if (stored) return { rate: formatRate(stored), source: 'stored' };

  if (args.useFeed !== false) {
    const fed = await fetchFeedRate(db, args.baseCurrency, args.currency, args.date);
    if (fed) return { rate: formatRate(fed), source: 'feed' };
  }
  return null;
}

/**
 * What a draft stores while it is edited: 1 for a base-currency document, the
 * typed or looked-up rate for a foreign one, null when there is none yet (the
 * document can be saved, not posted).
 */
export async function draftRate(
  db: Database,
  args: { baseCurrency: string; currency: string; date: Date; override?: string | number | null },
): Promise<string | null> {
  const resolved = await resolveRate(db, args);
  return resolved?.rate ?? null;
}

/**
 * The rate a document posts at. A stored rate that is a real one stays (it
 * was typed, or looked up for the document date when it was saved); a missing
 * or default 1 on a foreign document is looked up now. Throws when there is
 * none: nothing is ever posted at 1 for a foreign currency.
 */
export async function requireBookingRate(
  db: Database,
  args: { baseCurrency: string; currency: string | null | undefined; date: Date; stored: string | null | undefined },
): Promise<string> {
  if (!args.currency || !isForeignCurrency(args.baseCurrency, args.currency)) return '1.000000';
  const stored = parseRate(args.stored);
  // 1 is the column default, the value of a document nobody resolved a rate for.
  if (stored && stored !== 1) return formatRate(stored);
  const resolved = await resolveRate(db, {
    baseCurrency: args.baseCurrency,
    currency: args.currency,
    date: args.date,
  });
  if (!resolved) throw new MissingExchangeRateError(args.currency, args.baseCurrency, args.date);
  return resolved.rate;
}

/** The base currency of an entity row (EUR when somehow unset). */
export function baseCurrencyOf(entity: { baseCurrency: string | null }): string {
  return entity.baseCurrency || 'EUR';
}
