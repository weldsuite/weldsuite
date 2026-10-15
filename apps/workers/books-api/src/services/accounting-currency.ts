/**
 * Multi-Currency Support for Accounting
 *
 * Historical-correct exchange rate lookups. Fetches daily ECB rates and persists them
 * into the `fx_rates` table so conversions at a given transaction date are reproducible
 * long after the live rate has moved.
 *
 * Ported from api-worker as part of the app-api consolidation — this is now the
 * canonical home for the currency service.
 */

import { and, desc, eq, lte } from 'drizzle-orm';
import { fxRates } from '@weldsuite/db/schema';
import { generateId } from '@weldsuite/worker-kit/id';

// Minimal structural type so this helper works with any Drizzle db instance.
type DbLike = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
};

let rateCache: { rates: Record<string, number>; fetchedAt: number } | null = null;
const CACHE_TTL = 3600000; // 1 hour

export async function getExchangeRates(): Promise<Record<string, number>> {
  if (rateCache && Date.now() - rateCache.fetchedAt < CACHE_TTL) {
    return rateCache.rates;
  }

  try {
    const response = await fetch(
      'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml',
    );

    if (!response.ok) {
      console.warn('[Currency] ECB API error, using fallback rates');
      return getFallbackRates();
    }

    const xml = await response.text();
    const rates = parseEcbXml(xml);
    rates['EUR'] = 1;

    rateCache = { rates, fetchedAt: Date.now() };
    return rates;
  } catch (err) {
    console.error('[Currency] Failed to fetch ECB rates:', err);
    return getFallbackRates();
  }
}

/**
 * Persist today's ECB rates into the `fx_rates` table.
 * Safe to call repeatedly — the unique index on (date, from, to, source) deduplicates.
 */
export async function persistDailyEcbRates(db: DbLike, date = new Date()): Promise<number> {
  const rates = await getExchangeRates();
  const isoDate = date.toISOString().slice(0, 10);
  const rows = Object.entries(rates)
    .filter(([code]) => code !== 'EUR')
    .map(([code, rate]) => ({
      id: generateId('fxr'),
      date: isoDate,
      fromCurrency: 'EUR',
      toCurrency: code,
      rate: rate.toString(),
      source: 'ecb' as const,
    }));

  if (rows.length === 0) return 0;

  await db.insert(fxRates).values(rows).onConflictDoNothing();

  return rows.length;
}

/**
 * Look up a historical rate from the fx_rates table (most recent on-or-before `atDate`).
 * Falls back to the live ECB rate if no persisted rate is available.
 */
export async function getExchangeRate(
  from: string,
  to: string,
  opts: { db?: DbLike; atDate?: Date } = {},
): Promise<number> {
  if (from === to) return 1;

  const fromCode = from.toUpperCase();
  const toCode = to.toUpperCase();

  if (opts.db && opts.atDate) {
    const historical = await lookupHistoricalRate(opts.db, fromCode, toCode, opts.atDate);
    if (historical !== null) return historical;
  }

  const rates = await getExchangeRates();
  const fromRate = rates[fromCode];
  const toRate = rates[toCode];

  if (!fromRate || !toRate) {
    throw new Error(`Exchange rate not available for ${from}/${to}`);
  }

  return toRate / fromRate;
}

async function lookupHistoricalRate(
  db: DbLike,
  from: string,
  to: string,
  atDate: Date,
): Promise<number | null> {
  const isoDate = atDate.toISOString().slice(0, 10);

  const pullLatest = (eurCounter: string) =>
    db
      .select({ rate: fxRates.rate })
      .from(fxRates)
      .where(and(eq(fxRates.fromCurrency, 'EUR'), eq(fxRates.toCurrency, eurCounter), lte(fxRates.date, isoDate)))
      .orderBy(desc(fxRates.date))
      .limit(1);

  if (from === 'EUR') {
    const row = await pullLatest(to);
    return row[0] ? Number(row[0].rate) : null;
  }

  if (to === 'EUR') {
    const row = await pullLatest(from);
    return row[0] ? 1 / Number(row[0].rate) : null;
  }

  const [fromRow, toRow] = await Promise.all([pullLatest(from), pullLatest(to)]);

  if (!fromRow[0] || !toRow[0]) return null;
  return Number(toRow[0].rate) / Number(fromRow[0].rate);
}

/**
 * Latest stored rate on or before `atDate`, as units of `to` per unit of `from`
 * (a document in `to` booked in base `from`: foreign units per base unit).
 * Looks for the pair itself, its inverse, then crosses over EUR (the cron
 * stores ECB rates against EUR). Null when nothing is stored: unlike
 * `getExchangeRate` this never falls back to the live feed or to made-up
 * rates, so a missing rate is visible to the caller.
 */
export async function lookupStoredRate(
  db: DbLike,
  from: string,
  to: string,
  atDate: Date,
): Promise<number | null> {
  const fromCode = from.toUpperCase();
  const toCode = to.toUpperCase();
  if (fromCode === toCode) return 1;
  const isoDate = atDate.toISOString().slice(0, 10);

  const latest = async (a: string, b: string): Promise<{ date: string; rate: number } | null> => {
    const rows = await db
      .select({ date: fxRates.date, rate: fxRates.rate })
      .from(fxRates)
      .where(and(eq(fxRates.fromCurrency, a), eq(fxRates.toCurrency, b), lte(fxRates.date, isoDate)))
      .orderBy(desc(fxRates.date))
      .limit(1);
    const row = rows[0];
    const rate = row ? Number(row.rate) : 0;
    return row && Number.isFinite(rate) && rate > 0 ? { date: String(row.date), rate } : null;
  };

  const [direct, inverse] = await Promise.all([latest(fromCode, toCode), latest(toCode, fromCode)]);
  if (direct && (!inverse || direct.date >= inverse.date)) return direct.rate;
  if (inverse) return 1 / inverse.rate;
  const crossed = await lookupHistoricalRate(db, fromCode, toCode, atDate);
  return crossed !== null && Number.isFinite(crossed) && crossed > 0 ? crossed : null;
}

const ECB_DAILY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const ECB_HISTORY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml';
const DAY_MS = 86_400_000;

/** One day of ECB reference rates (units per EUR), the latest on or before `atDate`; null when the feed can't say. */
async function fetchEcbRatesOn(atDate: Date): Promise<{ date: string; rates: Record<string, number> } | null> {
  const isoDate = atDate.toISOString().slice(0, 10);
  const daysAgo = Math.floor((Date.now() - atDate.getTime()) / DAY_MS);
  if (daysAgo > 90) return null;
  try {
    const response = await fetch(daysAgo <= 4 ? ECB_DAILY_URL : ECB_HISTORY_URL, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const xml = await response.text();
    const days = [...xml.matchAll(/<Cube time=['"](\d{4}-\d{2}-\d{2})['"]>([\s\S]*?)<\/Cube>/g)]
      .map((m) => ({ date: m[1], rates: parseEcbXml(m[2]) }))
      .filter((d) => d.date <= isoDate && Object.keys(d.rates).length > 0)
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    const day = days[0];
    if (!day) return null;
    day.rates['EUR'] = 1;
    return day;
  } catch {
    return null;
  }
}

/**
 * The ECB reference rate for a pair on a date (units of `to` per unit of
 * `from`), from the daily file or its 90-day history, stored in fx_rates so
 * the booking can be reproduced. Null when the feed is unreachable or has no
 * rate for the date (older than 90 days, unsupported currency).
 */
export async function fetchFeedRate(db: DbLike | undefined, from: string, to: string, atDate: Date): Promise<number | null> {
  const day = await fetchEcbRatesOn(atDate);
  if (!day) return null;
  const fromRate = day.rates[from.toUpperCase()];
  const toRate = day.rates[to.toUpperCase()];
  if (!fromRate || !toRate) return null;
  if (db) {
    const rows = Object.entries(day.rates)
      .filter(([code]) => code !== 'EUR')
      .map(([code, rate]) => ({
        id: generateId('fxr'),
        date: day.date,
        fromCurrency: 'EUR',
        toCurrency: code,
        rate: rate.toString(),
        source: 'ecb' as const,
      }));
    try {
      await db.insert(fxRates).values(rows).onConflictDoNothing();
    } catch (err) {
      console.warn('[Currency] could not store ECB rates:', err);
    }
  }
  return toRate / fromRate;
}

export async function convertCurrency(
  amount: number,
  from: string,
  to: string,
  opts: { db?: DbLike; atDate?: Date } = {},
): Promise<{ convertedAmount: number; exchangeRate: number }> {
  const exchangeRate = await getExchangeRate(from, to, opts);
  return {
    convertedAmount: Math.round(amount * exchangeRate * 100) / 100,
    exchangeRate,
  };
}

export function toBaseCurrency(amount: number, exchangeRate: number): number {
  if (exchangeRate === 0 || exchangeRate === 1) return amount;
  return Math.round((amount / exchangeRate) * 100) / 100;
}

/**
 * Realized FX gain/loss on a payment whose rate differs from the invoice rate.
 * Positive = gain, negative = loss. Caller should post the absolute value to the
 * `realized_fx_gain` or `realized_fx_loss` system account accordingly.
 */
export function calculateFxGainLoss(
  paymentAmountForeign: number,
  paymentExchangeRate: number,
  invoiceExchangeRate: number,
): number {
  const paymentBase = toBaseCurrency(paymentAmountForeign, paymentExchangeRate);
  const expectedBase = toBaseCurrency(paymentAmountForeign, invoiceExchangeRate);
  return Math.round((paymentBase - expectedBase) * 100) / 100;
}

function parseEcbXml(xml: string): Record<string, number> {
  const rates: Record<string, number> = {};
  const cubePattern = /<Cube currency='([A-Z]{3})' rate='([\d.]+)'\/>/g;
  let match;
  while ((match = cubePattern.exec(xml)) !== null) {
    rates[match[1]] = Number.parseFloat(match[2]);
  }
  return rates;
}

function getFallbackRates(): Record<string, number> {
  return {
    EUR: 1,
    USD: 1.08, GBP: 0.86, CHF: 0.96, JPY: 162.5, CAD: 1.47, AUD: 1.66,
    SEK: 11.2, NOK: 11.5, DKK: 7.46, PLN: 4.31, CZK: 25.2, HUF: 395,
    TRY: 35.0, CNY: 7.85, INR: 90.0, BRL: 6.3,
  };
}

export const SUPPORTED_CURRENCIES = [
  { code: 'EUR', name: 'Euro', symbol: '€' },
  { code: 'USD', name: 'US Dollar', symbol: '$' },
  { code: 'GBP', name: 'British Pound', symbol: '£' },
  { code: 'CHF', name: 'Swiss Franc', symbol: 'CHF' },
  { code: 'SEK', name: 'Swedish Krona', symbol: 'kr' },
  { code: 'NOK', name: 'Norwegian Krone', symbol: 'kr' },
  { code: 'DKK', name: 'Danish Krone', symbol: 'kr' },
  { code: 'PLN', name: 'Polish Zloty', symbol: 'zł' },
  { code: 'CZK', name: 'Czech Koruna', symbol: 'Kč' },
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'CA$' },
  { code: 'AUD', name: 'Australian Dollar', symbol: 'A$' },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥' },
  { code: 'CNY', name: 'Chinese Yuan', symbol: '¥' },
  { code: 'INR', name: 'INR', symbol: '₹' },
  { code: 'BRL', name: 'Brazilian Real', symbol: 'R$' },
] as const;

const INR_LOCALIZED_NAME: Record<string, string> = {
  en: 'Indian Rupee',
  nl: 'Indiase Roepie',
};

const BRL_LOCALIZED_NAME: Record<string, string> = {
  en: 'Brazilian Real',
  nl: 'Braziliaanse real',
  pt: 'Real brasileiro',
};

/** Localized currency list for API clients. INR and BRL names come from i18n catalogs. */
export function getSupportedCurrencies(locale = 'en') {
  const lang = locale.slice(0, 2).toLowerCase();
  return SUPPORTED_CURRENCIES.map((c) => {
    if (c.code === 'INR') return { ...c, name: INR_LOCALIZED_NAME[lang] ?? INR_LOCALIZED_NAME.en };
    if (c.code === 'BRL') return { ...c, name: BRL_LOCALIZED_NAME[lang] ?? BRL_LOCALIZED_NAME.en };
    return { ...c };
  });
}
