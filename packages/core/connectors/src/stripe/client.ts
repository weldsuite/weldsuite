/**
 * Stripe API client for the `stripe` connector (accounting).
 *
 * Reads finalized invoices, the balance per currency, and paid payouts with
 * the balance transactions they settled. It never writes, except the webhook
 * endpoint of an API-key connection. Two ways in:
 *   - OAuth (Connect, Standard): the platform key plus `Stripe-Account`.
 *     Events arrive on the platform's Connect webhook.
 *   - API key: a restricted key the merchant pasted (needed for the platform's
 *     own account, which cannot connect to itself). We register a webhook
 *     endpoint on that account.
 *
 * The API version is pinned so payloads (e.g. `charge.invoice`) don't move
 * with the account's default version.
 *
 * @see https://docs.stripe.com/api
 */

import type { ConnectorSyncDef, ConnectorSyncSettingKey } from '../catalog';
import type { ConnectorListPage, ConnectorProviderClient, ConnectorWebhookCreated } from '../provider-client';
import {
  bindFetch,
  classifyStatus,
  ConnectorApiError,
  parseRetryAfter,
  runWithRetries,
  type ConnectorAttemptOutcome,
} from '../types';
import type { ConnectorWebhookTopic } from '../webhooks';

export const STRIPE_API_BASE = 'https://api.stripe.com/v1';
export const STRIPE_API_VERSION = '2024-06-20';

/** Invoice events that change what we import. */
export const STRIPE_INVOICE_EVENT_TYPES = [
  'invoice.finalized',
  'invoice.updated',
  'invoice.paid',
  'invoice.payment_succeeded',
  'invoice.voided',
  'invoice.marked_uncollectible',
] as const;

export const STRIPE_PAYOUT_EVENT_TYPES = ['payout.paid'] as const;

export interface StripeCredentials {
  /** Restricted (or secret) key the merchant pasted. */
  apiKey?: string | null;
  /** OAuth access token of the connected account (deprecated by Stripe; fallback only). */
  accessToken?: string | null;
  /** Connected account id (`acct_…`). */
  accountId?: string | null;
  /** Platform secret key, sent with `Stripe-Account` for OAuth connections. */
  platformSecretKey?: string | null;
  /** Only invoices / payouts created on or after this date (YYYY-MM-DD). */
  importStartDate?: string | null;
}

export type StripeAuthMode = 'api_key' | 'oauth';

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;
const INVOICES_PER_PAGE = 50;
const EVENTS_PER_PAGE = 50;
const PAYOUTS_PER_PAGE = 5;
/** Paid payouts can be created well before they land; re-read this far back on incremental runs. */
const PAYOUT_LOOKBACK_SECONDS = 14 * 24 * 60 * 60;

const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
const THREE_DECIMAL_CURRENCIES = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

/** Stripe amounts are integers in the currency's minor unit. */
export function stripeMinorUnits(currency: string | null | undefined): number {
  const code = (currency ?? '').toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

/** Minor-unit integer (or decimal string, e.g. `unit_amount_decimal`) → major-unit decimal string. */
export function stripeAmountToDecimal(amount: unknown, currency: string | null | undefined, places = 2): string {
  const raw = typeof amount === 'string' ? Number(amount) : amount;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return (0).toFixed(places);
  const value = raw / 10 ** stripeMinorUnits(currency);
  return value.toFixed(places);
}

function unixFromDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function isoFromUnix(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => asRecord(item) !== null) : [];
}

function idOf(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  const record = asRecord(value);
  return typeof record?.id === 'string' ? record.id : null;
}

interface StripeList {
  data: Array<Record<string, unknown>>;
  has_more: boolean;
}

function toList(value: unknown): StripeList {
  const record = asRecord(value);
  return { data: asRecords(record?.data), has_more: record?.has_more === true };
}

type SearchParams = Array<[string, string]>;

function describeStripeError(status: number, text: string): string {
  try {
    const json = JSON.parse(text) as { error?: { message?: unknown } };
    if (typeof json.error?.message === 'string' && json.error.message) return `Stripe: ${json.error.message}`;
  } catch {
    /* not JSON */
  }
  if (status === 401) return 'Stripe rejected the API key';
  if (status === 403) return 'The Stripe key is missing a permission this connector needs';
  return `Stripe request failed (${status})`;
}

export class StripeClient implements ConnectorProviderClient {
  readonly accountId: string | null;
  readonly mode: StripeAuthMode;
  private readonly bearer: string;
  private readonly sendAccountHeader: boolean;
  private readonly importStart: number | null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(creds: StripeCredentials, options?: { fetchImpl?: typeof fetch; timeoutMs?: number }) {
    const apiKey = creds.apiKey?.trim() || '';
    const accessToken = creds.accessToken?.trim() || '';
    const platformKey = creds.platformSecretKey?.trim() || '';
    this.accountId = creds.accountId?.trim() || null;
    this.mode = apiKey ? 'api_key' : 'oauth';
    // OAuth: platform key + Stripe-Account is Stripe's supported path; the
    // connected account's own access token is deprecated and only a fallback.
    const usePlatformKey = !apiKey && Boolean(platformKey && this.accountId);
    this.sendAccountHeader = usePlatformKey;
    if (apiKey) this.bearer = apiKey;
    else if (usePlatformKey) this.bearer = platformKey;
    else this.bearer = accessToken;
    this.importStart = unixFromDate(creds.importStartDate);
    this.fetchImpl = bindFetch(options?.fetchImpl);
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get storeUrl(): string {
    return this.accountId ?? 'stripe';
  }

  private async request<T = Record<string, unknown>>(
    path: string,
    init?: { method?: 'GET' | 'POST' | 'DELETE'; params?: SearchParams },
  ): Promise<T> {
    if (!this.bearer) {
      throw new ConnectorApiError({ message: 'Stripe is not connected (no API key)', status: 401, kind: 'auth' });
    }
    const method = init?.method ?? 'GET';
    const url = new URL(`${STRIPE_API_BASE}/${path.replace(/^\//, '')}`);
    const form = new URLSearchParams();
    for (const [key, value] of init?.params ?? []) {
      if (method === 'GET') url.searchParams.append(key, value);
      else form.append(key, value);
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.bearer}`,
      'Stripe-Version': STRIPE_API_VERSION,
      Accept: 'application/json',
    };
    if (this.sendAccountHeader && this.accountId) headers['Stripe-Account'] = this.accountId;
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';

    return runWithRetries<T>({
      maxRetries: MAX_RETRIES,
      timeoutMs: this.timeoutMs,
      unreachableMessage: 'Could not reach Stripe',
      failureMessage: 'Stripe request failed',
      attemptOnce: async (signal): Promise<ConnectorAttemptOutcome<T>> => {
        const response = await this.fetchImpl(url.toString(), {
          method,
          headers,
          body: method === 'POST' ? form.toString() : undefined,
          signal,
        });
        const text = await response.text();
        if (!response.ok) {
          return {
            ok: false,
            error: new ConnectorApiError({
              message: describeStripeError(response.status, text),
              status: response.status,
              kind: classifyStatus(response.status),
              body: text.slice(0, 500),
              retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
            }),
          };
        }
        return { ok: true, value: (text ? JSON.parse(text) : {}) as T };
      },
    });
  }

  async test(): Promise<{ ok: true; storeUrl: string; accountName?: string } | { ok: false; message: string }> {
    try {
      const account = await this.request('account');
      const id = idOf(account);
      const settings = asRecord(asRecord(account.settings)?.dashboard);
      const profile = asRecord(account.business_profile);
      const name =
        (typeof settings?.display_name === 'string' && settings.display_name)
        || (typeof profile?.name === 'string' && profile.name)
        || undefined;
      return { ok: true, storeUrl: id ?? this.storeUrl, accountName: name };
    } catch (err) {
      // Restricted keys often lack the Account permission; any readable resource proves the key works.
      if (err instanceof ConnectorApiError && err.status === 403 && this.mode === 'api_key') {
        try {
          await this.request('balance');
          return { ok: true, storeUrl: this.accountId ?? `key_${this.bearer.slice(-4)}` };
        } catch (inner) {
          return { ok: false, message: inner instanceof Error ? inner.message : 'Could not reach Stripe' };
        }
      }
      return { ok: false, message: err instanceof Error ? err.message : 'Could not reach Stripe' };
    }
  }

  // ------------------------------------------------------------------ invoices

  /** Full invoice: every line, tax rates resolved, `updated_at` stamped for the watermark. */
  private async completeInvoice(invoice: Record<string, unknown>, modifiedAt: string | null): Promise<Record<string, unknown>> {
    const lines = toList(invoice.lines);
    let allLines = lines.data;
    if (lines.has_more && typeof invoice.id === 'string') {
      allLines = await this.listAll(`invoices/${invoice.id}/lines`, []);
    }
    const created = typeof invoice.created === 'number' ? invoice.created : null;
    return {
      ...invoice,
      lines: { object: 'list', data: allLines, has_more: false },
      updated_at: modifiedAt ?? isoFromUnix(invoice.created),
      // Out-of-range invoices still travel (an empty page would end the scan); the mapper skips them.
      _weld_skip: this.importStart !== null && created !== null && created < this.importStart,
    };
  }

  private async listAll(path: string, params: SearchParams): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let startingAfter: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const page = toList(
        await this.request(path, {
          params: [...params, ['limit', '100'], ...(startingAfter ? [['starting_after', startingAfter] as [string, string]] : [])],
        }),
      );
      out.push(...page.data);
      const last = page.data.at(-1);
      if (!page.has_more || !last || typeof last.id !== 'string') break;
      startingAfter = last.id;
    }
    return out;
  }

  async getInvoice(id: string, modifiedAt: string | null = null): Promise<Record<string, unknown> | null> {
    try {
      const invoice = await this.request(`invoices/${encodeURIComponent(id)}`, {
        params: [['expand[]', 'total_tax_amounts.tax_rate']],
      });
      return this.completeInvoice(invoice, modifiedAt);
    } catch (err) {
      if (err instanceof ConnectorApiError && err.status === 404) return null;
      throw err;
    }
  }

  private async listInvoices(cursor: string | null): Promise<ConnectorListPage> {
    const params: SearchParams = [
      ['limit', String(INVOICES_PER_PAGE)],
      ['expand[]', 'data.total_tax_amounts.tax_rate'],
    ];
    if (this.importStart !== null) params.push(['created[gte]', String(this.importStart)]);
    if (cursor) params.push(['starting_after', cursor]);
    const page = toList(await this.request('invoices', { params }));
    const items = await Promise.all(page.data.map((invoice) => this.completeInvoice(invoice, null)));
    const last = page.data.at(-1);
    return { items, done: !page.has_more, nextCursor: page.has_more && last ? idOf(last) : null };
  }

  private async listEvents(types: readonly string[], since: number, cursor: string | null, limit: number) {
    const params: SearchParams = [['limit', String(limit)], ['created[gt]', String(since)]];
    for (const type of types) params.push(['types[]', type]);
    if (cursor) params.push(['starting_after', cursor]);
    return toList(await this.request('events', { params }));
  }

  /** Invoices touched by an event since the watermark, re-read so lines and status are current. */
  private async listChangedInvoices(cursor: string | null, since: string): Promise<ConnectorListPage> {
    const sinceUnix = unixFromDate(since) ?? 0;
    const events = await this.listEvents(STRIPE_INVOICE_EVENT_TYPES, sinceUnix, cursor, EVENTS_PER_PAGE);
    const newest = new Map<string, string | null>();
    for (const event of events.data) {
      const invoiceId = idOf(asRecord(asRecord(event.data)?.object));
      if (invoiceId && !newest.has(invoiceId)) newest.set(invoiceId, isoFromUnix(event.created));
    }
    const fetched = await Promise.all([...newest].map(([id, at]) => this.getInvoice(id, at)));
    const last = events.data.at(-1);
    return {
      items: fetched.filter((item): item is Record<string, unknown> => item !== null),
      done: !events.has_more,
      nextCursor: events.has_more && last ? idOf(last) : null,
    };
  }

  // ------------------------------------------------------------------ balance

  private async listBalances(): Promise<ConnectorListPage> {
    const balance = await this.request('balance');
    const byCurrency = new Map<string, { available: number; pending: number }>();
    for (const bucket of ['available', 'pending'] as const) {
      for (const row of asRecords(balance[bucket])) {
        const currency = typeof row.currency === 'string' ? row.currency.toUpperCase() : null;
        if (!currency) continue;
        const entry = byCurrency.get(currency) ?? { available: 0, pending: 0 };
        entry[bucket] += typeof row.amount === 'number' ? row.amount : 0;
        byCurrency.set(currency, entry);
      }
    }
    const items = [...byCurrency].map(([currency, amounts]) => ({
      id: stripeBalanceAccountId(currency),
      object: 'stripe_balance',
      currency,
      available: amounts.available,
      pending: amounts.pending,
      account_id: this.accountId,
    }));
    return { items, done: true, nextCursor: null };
  }

  /** One payout and every line it settled: gross, fee, and the payout itself. */
  async payoutLines(payout: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
    const payoutId = idOf(payout);
    if (!payoutId) return [];
    const currency = typeof payout.currency === 'string' ? payout.currency.toUpperCase() : 'EUR';
    const updatedAt = isoFromUnix(payout.created);
    const base = {
      object: 'stripe_line',
      payout_id: payoutId,
      payout_arrival_date: isoFromUnix(payout.arrival_date),
      balance_account: stripeBalanceAccountId(currency),
      updated_at: updatedAt,
    };

    // Only automatic payouts can list the transactions they settled.
    const transactions = payout.automatic === true
      ? await this.listAll('balance_transactions', [['payout', payoutId], ['expand[]', 'data.source']])
      : [];

    const lines = transactions.flatMap((txn) => transactionLines(txn, base, currency));
    if (!lines.some((line) => line.line === 'payout')) lines.push(payoutOwnLine(payout, payoutId, base, currency));
    return lines;
  }

  private payoutLowerBound(modifiedAfter: string | undefined): number | null {
    const since = unixFromDate(modifiedAfter);
    const incremental = since === null ? null : since - PAYOUT_LOOKBACK_SECONDS;
    if (incremental === null) return this.importStart;
    if (this.importStart === null) return incremental;
    return Math.max(incremental, this.importStart);
  }

  private async listPayoutLines(cursor: string | null, modifiedAfter: string | undefined): Promise<ConnectorListPage> {
    const params: SearchParams = [['limit', String(PAYOUTS_PER_PAGE)], ['status', 'paid']];
    const lower = this.payoutLowerBound(modifiedAfter);
    if (lower !== null) params.push(['created[gte]', String(lower)]);
    if (cursor) params.push(['starting_after', cursor]);
    const page = toList(await this.request('payouts', { params }));
    const items: Array<Record<string, unknown>> = [];
    for (const payout of page.data) items.push(...(await this.payoutLines(payout)));
    const last = page.data.at(-1);
    return { items, done: !page.has_more, nextCursor: page.has_more && last ? idOf(last) : null };
  }

  async getPayout(id: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.request(`payouts/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err instanceof ConnectorApiError && err.status === 404) return null;
      throw err;
    }
  }

  // ------------------------------------------------------------------ connector surface

  async listSync(
    sync: ConnectorSyncDef,
    options: { page: number; cursor: string | null; limit: number; modifiedAfter?: string },
  ): Promise<ConnectorListPage> {
    switch (sync.syncName) {
      case 'stripe-invoices':
        return options.modifiedAfter
          ? this.listChangedInvoices(options.cursor, options.modifiedAfter)
          : this.listInvoices(options.cursor);
      case 'stripe-balances':
        return this.listBalances();
      case 'stripe-balance-transactions':
        return this.listPayoutLines(options.cursor, options.modifiedAfter);
      default:
        return { items: [], done: true, nextCursor: null };
    }
  }

  /** Webhook payloads can be truncated (invoice lines) or a parent object (payout): re-read them. */
  async hydrateWebhookRecords(sync: ConnectorSyncDef, record: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
    const id = idOf(record);
    if (!id) return [];
    if (sync.syncName === 'stripe-invoices') {
      const invoice = await this.getInvoice(id, new Date().toISOString());
      return invoice ? [invoice] : [];
    }
    if (sync.syncName === 'stripe-balance-transactions') {
      const payout = await this.getPayout(id);
      if (payout?.status !== 'paid') return [];
      const created = typeof payout.created === 'number' ? payout.created : null;
      if (this.importStart !== null && created !== null && created < this.importStart) return [];
      return this.payoutLines(payout);
    }
    return [record];
  }

  async hasUpdatesSince(resource: ConnectorSyncSettingKey, since?: string): Promise<boolean> {
    if (resource === 'bankAccounts') return !since;
    if (resource !== 'invoices' && resource !== 'bankTransactions') return false;
    if (!since) return true;
    const types = resource === 'invoices' ? STRIPE_INVOICE_EVENT_TYPES : STRIPE_PAYOUT_EVENT_TYPES;
    const sinceUnix = unixFromDate(since);
    if (sinceUnix === null) return true;
    const events = await this.listEvents(types, sinceUnix, null, 1);
    return events.data.length > 0;
  }

  /** Stripe has no cheap totals; the daily reconcile fingerprint stays flat. */
  countResource(_resource: ConnectorSyncSettingKey): Promise<number> {
    return Promise.resolve(0);
  }

  /** API-key connections only: OAuth accounts report through the platform's Connect webhook. */
  async registerWebhooks(args: {
    deliveryUrl: string;
    secret: string;
    topics: ConnectorWebhookTopic[];
  }): Promise<ConnectorWebhookCreated[]> {
    if (this.mode !== 'api_key') return [];
    const events = [...new Set(args.topics.map((topic) => topic.topic))];
    const params: SearchParams = [
      ['url', args.deliveryUrl],
      ['api_version', STRIPE_API_VERSION],
      ['description', 'WeldSuite (WeldBooks import)'],
    ];
    for (const event of events) params.push(['enabled_events[]', event]);
    const created = await this.request('webhook_endpoints', { method: 'POST', params });
    return [
      {
        id: idOf(created) ?? '',
        topic: events.join(','),
        deliveryUrl: typeof created.url === 'string' ? created.url : args.deliveryUrl,
        secret: typeof created.secret === 'string' ? created.secret : undefined,
      },
    ];
  }

  async deleteWebhook(id: string): Promise<void> {
    if (this.mode !== 'api_key') return;
    await this.request(`webhook_endpoints/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /** Stripe's hosted invoice PDF. The link is public (it is what customers get), so no auth header. */
  async downloadInvoicePdf(url: string): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
    if (!/^https:\/\/([a-z0-9-]+\.)*stripe\.com\//i.test(url)) return null;
    const response = await this.fetchImpl(url, { redirect: 'follow' });
    if (!response.ok) return null;
    return {
      bytes: await response.arrayBuffer(),
      contentType: response.headers.get('content-type') || 'application/pdf',
    };
  }
}

type LineBase = Record<string, unknown>;

/** A balance transaction as one gross line (or the payout line), plus its fee as a line of its own. */
function transactionLines(txn: Record<string, unknown>, base: LineBase, payoutCurrency: string): Array<Record<string, unknown>> {
  const type = typeof txn.type === 'string' ? txn.type : 'adjustment';
  const currency = typeof txn.currency === 'string' ? txn.currency.toUpperCase() : payoutCurrency;
  const source = asRecord(txn.source);
  const charge = source?.object === 'charge' ? source : null;
  const billing = asRecord(charge?.billing_details);
  const shared = {
    ...base,
    balance_transaction_id: txn.id,
    currency,
    created: isoFromUnix(txn.created),
    available_on: isoFromUnix(txn.available_on),
    source_id: idOf(txn.source),
  };
  const gross = {
    ...shared,
    id: txn.id,
    line: type === 'payout' ? 'payout' : 'gross',
    type,
    reporting_category: txn.reporting_category ?? null,
    amount: txn.amount,
    description: txn.description ?? null,
    charge_id: charge ? idOf(charge) : null,
    invoice_id: charge ? idOf(charge.invoice) : null,
    customer_name: typeof billing?.name === 'string' ? billing.name : null,
  };
  const fee = typeof txn.fee === 'number' ? txn.fee : 0;
  if (fee === 0 || type === 'payout') return [gross];
  return [
    gross,
    {
      ...shared,
      id: `${String(txn.id)}_fee`,
      line: 'fee',
      type: 'stripe_fee',
      amount: -fee,
      description: 'Stripe fee ' + (idOf(txn.source) ?? String(txn.id)),
      fee_details: txn.fee_details ?? null,
    },
  ];
}

/** The payout itself, when its transaction was not in the list (manual payouts). */
function payoutOwnLine(payout: Record<string, unknown>, payoutId: string, base: LineBase, currency: string): Record<string, unknown> {
  return {
    ...base,
    id: idOf(payout.balance_transaction) ?? payoutId,
    line: 'payout',
    balance_transaction_id: idOf(payout.balance_transaction),
    type: 'payout',
    amount: -(typeof payout.amount === 'number' ? payout.amount : 0),
    currency,
    created: isoFromUnix(payout.created),
    available_on: isoFromUnix(payout.arrival_date),
    description: typeof payout.statement_descriptor === 'string' ? payout.statement_descriptor : `Stripe payout ${payoutId}`,
    source_id: payoutId,
  };
}

/** External id of the bank account that stands for the Stripe balance in one currency. */
export function stripeBalanceAccountId(currency: string): string {
  return `balance_${currency.toUpperCase()}`;
}

export function createStripeClient(
  creds: StripeCredentials,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): StripeClient {
  return new StripeClient(creds, options);
}
