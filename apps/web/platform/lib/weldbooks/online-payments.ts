/**
 * What a Mollie payment connection and an invoice's online payments say
 * (phase 4b, Rust only): the method names, whether customers can pay online,
 * the last payment state, a refund or chargeback, the return from Mollie
 * Connect and the money account of the provider. Pure functions, so the
 * screens and the tests share one reading.
 */

import type { EmailHistoryEntry } from '@/lib/api/domains/weldbooks-sales';
import type { PaymentConnection } from '@/lib/api/domains/weldbooks-payments';

/** The bank account type of the "Mollie" money account. */
export const PAYMENT_PROVIDER_ACCOUNT_TYPE = 'payment_provider';

/** Whether a bank account is a payment provider's money account, not a regular bank account. */
export function isPaymentProviderAccount(account: { accountType?: string | null } | null | undefined): boolean {
  return account?.accountType === PAYMENT_PROVIDER_ACCOUNT_TYPE;
}

/** The method ids this build has a name for; any other falls back to Mollie's own description. */
export const KNOWN_METHODS = [
  'ideal',
  'bancontact',
  'creditcard',
  'banktransfer',
  'paypal',
  'applepay',
  'eps',
  'giropay',
  'kbc',
  'belfius',
  'przelewy24',
  'sofort',
  'directdebit',
  'in3',
  'klarna',
  'twint',
  'trustly',
  'blik',
  'wero',
] as const;

const KNOWN: ReadonlySet<string> = new Set(KNOWN_METHODS);

/** `ideal` to "iDEAL": the name from `names` when known, else `fallback` (Mollie's description), else the id. */
export function methodLabel(id: string, names: Readonly<Record<string, string>>, fallback?: string | null): string {
  if (KNOWN.has(id) && names[id]) return names[id];
  return fallback?.trim() || id;
}

/** "iDEAL, Bancontact and Card". */
export function methodList(ids: readonly string[], names: Readonly<Record<string, string>>, and: string): string {
  const labels = ids.map((id) => methodLabel(id, names));
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} ${and} ${labels.at(-1)}`;
}

/** Customers can pay online: the connection works and at least one method is on. */
export function canPayOnline(connection: Pick<PaymentConnection, 'status' | 'methods'> | null | undefined): boolean {
  return connection?.status === 'active' && connection.methods.length > 0;
}

export type PaymentStatus = 'paid' | 'failed' | 'expired' | 'canceled' | 'pending' | 'authorized';

/** The online payment entries of an invoice's history, oldest first. */
export function paymentEntries(history: readonly EmailHistoryEntry[] | null | undefined): EmailHistoryEntry[] {
  return (history ?? []).filter(
    (entry) => entry.type === 'payment_started' || entry.type === 'payment_status' || entry.type === 'payment_reversed',
  );
}

export interface LastOnlinePayment {
  /** The last status the payment provider reported, or `started` when only the start is known. */
  status: PaymentStatus | 'started';
  method: string | null;
  at: string;
}

/** The last online payment state: the last `payment_status` entry, else the last start. Null when no payment began. */
export function lastOnlinePayment(history: readonly EmailHistoryEntry[] | null | undefined): LastOnlinePayment | null {
  const entries = paymentEntries(history);
  const status = entries.filter((entry) => entry.type === 'payment_status').at(-1);
  if (status?.status) return { status: status.status, method: status.method ?? null, at: status.at };
  const started = entries.filter((entry) => entry.type === 'payment_started').at(-1);
  return started ? { status: 'started', method: null, at: started.at } : null;
}

export interface OnlineReversal {
  kind: 'refund' | 'chargeback';
  amount: string;
  at: string;
}

/** The last refund or chargeback, or null. */
export function lastReversal(history: readonly EmailHistoryEntry[] | null | undefined): OnlineReversal | null {
  const entry = paymentEntries(history)
    .filter((candidate) => candidate.type === 'payment_reversed')
    .at(-1);
  if (!entry) return null;
  return { kind: entry.kind === 'chargeback' ? 'chargeback' : 'refund', amount: String(entry.amount ?? '0'), at: entry.at };
}

/**
 * The Mollie Connect address to send the browser to, or null when it is not a
 * plain `https:` address (parsed, never matched as text).
 */
export function safeAuthorizeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Sends the browser to Mollie (a full navigation: the person signs in there). Kept apart so tests can watch it. */
export function redirectBrowser(url: string): void {
  globalThis.location.assign(url);
}

export type MollieReturn = { result: 'connected' } | { result: 'error'; reason: string | null };

/** What Mollie Connect sent the person back with: `?mollie=connected` or `?mollie=error&reason=...`. Null when it is not a return. */
export function parseMollieReturn(search: string): MollieReturn | null {
  const params = new URLSearchParams(search);
  const value = params.get('mollie');
  if (value === 'connected') return { result: 'connected' };
  if (value === 'error') return { result: 'error', reason: params.get('reason')?.trim() || null };
  return null;
}

/** The address with the Mollie return params removed (`?tab=weldbooks` stays). */
export function withoutMollieReturn(pathname: string, search: string, hash = ''): string {
  const params = new URLSearchParams(search);
  params.delete('mollie');
  params.delete('reason');
  const rest = params.toString();
  const query = rest ? `?${rest}` : '';
  return `${pathname}${query}${hash}`;
}
