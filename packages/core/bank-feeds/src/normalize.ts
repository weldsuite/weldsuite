/**
 * Normalization rules the package owns, so WeldBooks never sees provider
 * quirks: amounts, dates, fingerprints, status roll-up, the date-range re-pull
 * window and pending matching (docs/plans/weldbooks-us.md section 9).
 */

import type { ConnectionStatus } from './types';
import { utf8 } from './http';

// ── Amounts ────────────────────────────────────────────────────────────────

const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

export function currencyExponent(currency: string): number {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

/** A decimal amount as given by the provider (12.34 or "12.34") to signed minor units. */
export function decimalToMinor(amount: number | string, currency: string): number {
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(value)) throw new Error(`Invalid amount: ${String(amount)}`);
  const minor = Math.round(value * 10 ** currencyExponent(currency));
  return minor === 0 ? 0 : minor;
}

/** Plaid sends decimals with outflows positive; the feed uses the statement convention, so negate. */
export function plaidAmountToMinor(amount: number | string, currency: string): number {
  const minor = decimalToMinor(amount, currency);
  return minor === 0 ? 0 : -minor;
}

/** Signed minor units to the decimal string stored in `numeric(18,2)` columns. */
export function minorToDecimalString(minor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  const negative = minor < 0;
  const digits = String(Math.abs(Math.trunc(minor))).padStart(exponent + 1, '0');
  const whole = exponent === 0 ? digits : digits.slice(0, -exponent);
  const fraction = exponent === 0 ? '' : `.${digits.slice(-exponent)}`;
  return `${negative && minor !== 0 ? '-' : ''}${whole}${fraction}`;
}

// ── Dates ──────────────────────────────────────────────────────────────────

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A calendar date (`YYYY-MM-DD`) without time-zone conversion: date strings
 * and ISO timestamps keep the date they carry; unix seconds (Stripe FC) and
 * `Date`s use their UTC calendar date.
 */
export function normalizeDate(input: string | number | Date): string {
  if (typeof input === 'string') {
    if (DATE_ONLY.test(input)) return input;
    if (/^\d{4}-\d{2}-\d{2}[T ]/.test(input)) return input.slice(0, 10);
    const asNumber = Number(input);
    if (Number.isFinite(asNumber)) return normalizeDate(asNumber);
    throw new Error(`Invalid date: ${input}`);
  }
  if (typeof input === 'number') return new Date(input * 1000).toISOString().slice(0, 10);
  return input.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const ms = new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime();
  return Math.round(ms / 86_400_000);
}

// ── Fingerprints ───────────────────────────────────────────────────────────

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === 'string' ? utf8(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function slug(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Institution + mask + subtype, or the provider's persistent account id, so a relink reattaches. */
export function accountFingerprint(
  institutionId: string | null | undefined,
  mask: string | null | undefined,
  subtype: string | null | undefined,
): Promise<string> {
  return sha256Hex(`acct|${slug(institutionId)}|${(mask ?? '').trim()}|${slug(subtype)}`);
}

export function persistentAccountFingerprint(persistentId: string): Promise<string> {
  return sha256Hex(`acct-persistent|${persistentId}`);
}

/** An IBAN identifies the account across providers, so the fingerprint ignores institution ids. */
export function normalizeIban(iban: string): string {
  return iban.replace(/\s+/g, '').toUpperCase();
}

export function ibanFingerprint(iban: string): Promise<string> {
  return sha256Hex(`acct-iban|${normalizeIban(iban)}`);
}

/** Lowercase, punctuation stripped, whitespace collapsed. */
export function normalizeDescription(description: string | null | undefined): string {
  return (description ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * SHA-256 hex (64 chars, fits `bank_transactions.fingerprint`) of date, amount
 * and normalized description. `occurrence` numbers identical lines on the same
 * day (two $5.00 coffees), so legitimate twins stay distinct.
 */
export function transactionFingerprint(
  date: string,
  amountMinor: number,
  normalizedDescription: string,
  occurrence = 0,
): Promise<string> {
  return sha256Hex(`txn|${date}|${amountMinor}|${normalizedDescription}|${occurrence}`);
}

// ── Status ─────────────────────────────────────────────────────────────────

/**
 * One connection status from per-account statuses (Stripe FC tracks status per
 * account). Accounts that ended for good (revoked, disconnected) do not count
 * while any other account still syncs; among live accounts the one needing
 * action wins.
 */
export function connectionStatus(statuses: ConnectionStatus[]): ConnectionStatus {
  if (statuses.length === 0) return 'active';
  const live = statuses.filter((s) => s !== 'revoked' && s !== 'disconnected');
  if (live.length === 0) return statuses.includes('revoked') ? 'revoked' : 'disconnected';
  for (const s of ['reauth_required', 'error', 'expiring'] as const) {
    if (live.includes(s)) return s;
  }
  return 'active';
}

// ── Date-range providers ───────────────────────────────────────────────────

/** Date-range providers re-pull this many days back, because dates and amounts move when a transaction posts. */
export const DEFAULT_REPULL_DAYS = 8;
export const PENDING_MATCH_WINDOW_DAYS = 10;
export const PENDING_VOID_AFTER_DAYS = 14;

/**
 * The date range a date-range provider pulls: from a few days before the last
 * successful sync (7 to 10 days) up to today, never further back than the
 * history the provider allows.
 */
export function rePullWindow(args: {
  /** The `to` date of the last successful pull, null on the first sync. */
  lastThrough: string | null;
  today: string;
  historyDays: number;
  overlapDays?: number;
}): { from: string; to: string } {
  const earliest = addDays(args.today, -args.historyDays);
  if (!args.lastThrough) return { from: earliest, to: args.today };
  const from = addDays(args.lastThrough, -(args.overlapDays ?? DEFAULT_REPULL_DAYS));
  return { from: from < earliest ? earliest : from, to: args.today };
}

export interface PendingCandidate {
  id: string;
  accountId: string;
  /** YYYY-MM-DD */
  date: string;
  amountMinor: number;
  description: string | null;
}

function tokens(normalized: string): Set<string> {
  return new Set(normalized.split(' ').filter((t) => t.length > 1));
}

function descriptionSimilarity(a: string, b: string): number {
  const na = normalizeDescription(a);
  const nb = normalizeDescription(b);
  if (!na || !nb) return 0.5;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const ta = tokens(na);
  const tb = tokens(nb);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

/**
 * The pending row a posted transaction replaces, for providers that give no
 * link between them: same account, same amount, within a 10-day window and a
 * similar description. Null when nothing fits.
 */
export function matchPendingToPosted(
  posted: { accountId: string; date: string; amountMinor: number; description: string },
  candidates: PendingCandidate[],
  windowDays = PENDING_MATCH_WINDOW_DAYS,
): PendingCandidate | null {
  let best: { candidate: PendingCandidate; score: number; distance: number } | null = null;
  for (const candidate of candidates) {
    if (candidate.accountId !== posted.accountId || candidate.amountMinor !== posted.amountMinor) continue;
    const distance = Math.abs(daysBetween(candidate.date, posted.date));
    if (distance > windowDays) continue;
    const score = descriptionSimilarity(candidate.description ?? '', posted.description);
    if (score < 0.34) continue;
    if (!best || score > best.score || (score === best.score && distance < best.distance)) {
      best = { candidate, score, distance };
    }
  }
  return best?.candidate ?? null;
}

/** An unmatched pending row older than 14 days is voided. */
export function shouldVoidPending(pendingDate: string, today: string): boolean {
  return daysBetween(pendingDate, today) > PENDING_VOID_AFTER_DAYS;
}
