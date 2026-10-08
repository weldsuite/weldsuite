/**
 * Stripe Financial Connections adapter (raw form-encoded fetch, no SDK).
 *
 * The account holder is a customer in the FC Stripe account, one per workspace
 * (found by `metadata[weldsuite_workspace]`). A connection is one FC session;
 * Stripe tracks status per account, so webhooks identify an account (`fca_`)
 * and the connection lists its account ids as index keys. Sync is
 * `GET /v1/financial_connections/transactions?transaction_refresh[after]=<id>`
 * per account: only transactions created or changed since that refresh come
 * back. Transactions already use the statement convention (negative = out).
 * A pending transaction changes status in place; `void` means it vanished.
 *
 * Not live-tested: the registration for live `transactions` access, the sign of
 * credit-card balances and per-issuer card coverage are open items in
 * docs/plans/weldbooks-us-research/bank-feeds.md.
 */

import { FeedProviderError, WebhookVerificationError } from '../errors';
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  defaultFetch,
  formEntries,
  queryString,
  requestJson,
  type FetchLike,
  type JsonRecord,
} from '../http';
import { accountFingerprint, connectionStatus, normalizeDate } from '../normalize';
import type {
  BankFeedProvider,
  ConnectionStatus,
  FeedAccount,
  FeedAccountType,
  FeedBalance,
  FeedConnection,
  FeedEvent,
  FeedTransaction,
  LinkSession,
  LinkSessionInput,
  ProviderCapabilities,
  ProviderSecrets,
  StoredConnection,
  SyncResult,
} from '../types';
import { verifyStripeSignature } from '../webhook';

export const STRIPE_FC_API_VERSION = '2025-11-17.clover';
export const STRIPE_FC_MAX_HISTORY_DAYS = 180;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_ACCOUNT = 200;

export interface StripeFcConfig {
  /** Secret key of the Stripe account FC is registered on. */
  secretKey: string;
  /** Pinned `Stripe-Version`. */
  apiVersion?: string;
  baseUrl?: string;
  /** Countries the picker offers banks in. Default `['US']`. */
  countries?: string[];
  fetch?: FetchLike;
}

export interface StripeFcCompletePayload {
  /** `financialConnectionsSession.id` from `collectFinancialConnectionsAccounts`. */
  sessionId: string;
  /** The stored connection, for `reauth` and `add_accounts` (the new accounts join it). */
  connection?: StoredConnection;
}

const CAPABILITIES: ProviderCapabilities = {
  regions: ['US'],
  changeCursor: true,
  webhooks: true,
  pendingTransactions: true,
  maxHistoryDays: STRIPE_FC_MAX_HISTORY_DAYS,
  onDemandRefresh: true,
  accountTypes: ['depository', 'credit', 'loan'],
};

interface FcCursor {
  refreshIds: Record<string, string>;
}

function readCursor(value: unknown): FcCursor {
  const refreshIds: Record<string, string> = {};
  for (const [id, refreshId] of Object.entries(asRecord(asRecord(value).refreshIds))) {
    const parsed = asString(refreshId);
    if (parsed) refreshIds[id] = parsed;
  }
  return { refreshIds };
}

function mapStripeError(status: number, body: JsonRecord): FeedProviderError | null {
  const error = asRecord(body.error);
  const code = asString(error.code);
  const message = `Stripe${code ? ` ${code}` : ''}${asString(error.message) ? `: ${asString(error.message)}` : ''}`;
  const extra = { status, code: code ?? undefined };
  switch (code) {
    case 'financial_connections_account_inactive':
      return new FeedProviderError('stripe_fc', 'reauth_required', message, extra);
    case 'financial_connections_account_refresh_too_soon':
    case 'rate_limit':
      return new FeedProviderError('stripe_fc', 'rate_limit', message, extra);
    default:
      return null;
  }
}

function accountType(category: string | null, subcategory: string | null): FeedAccountType | null {
  if (category === 'cash') return 'depository';
  if (category === 'credit') return subcategory === 'mortgage' || subcategory === 'line_of_credit' ? 'loan' : 'credit';
  return null;
}

function accountStatus(raw: JsonRecord): ConnectionStatus {
  const status = asString(raw.status);
  if (status === 'disconnected') return 'disconnected';
  if (status === 'inactive') return 'reauth_required';
  return 'active';
}

/** FC reports balances as `{ usd: 12345 }` (minor units) keyed by lowercase currency. */
function fcBalance(raw: JsonRecord): FeedBalance | null {
  const accountId = asString(raw.id);
  const balance = asRecord(raw.balance);
  const current = asRecord(balance.current);
  const [currencyKey, minorValue] = Object.entries(current)[0] ?? [];
  const minor = asNumber(minorValue);
  if (!accountId || !currencyKey || minor === null) return null;
  const isCredit = asString(raw.category) === 'credit';
  const available = asNumber(asRecord(asRecord(balance.cash).available)[currencyKey]);
  const asOf = asNumber(balance.as_of);
  return {
    accountId,
    // Credit accounts report the amount owed; a ledger liability is negative.
    current: isCredit ? (minor === 0 ? 0 : -minor) : minor,
    available,
    limit: null,
    currency: currencyKey.toUpperCase(),
    asOf: asOf === null ? new Date().toISOString() : new Date(asOf * 1000).toISOString(),
  };
}

async function mapAccount(raw: JsonRecord): Promise<FeedAccount | null> {
  const providerAccountId = asString(raw.id);
  const subtype = asString(raw.subcategory);
  const type = accountType(asString(raw.category), subtype);
  if (!providerAccountId || !type) return null;
  const institutionName = asString(raw.institution_name);
  const institutionId = institutionName ? institutionName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : null;
  const mask = asString(raw.last4);
  const balance = fcBalance(raw);
  return {
    providerAccountId,
    name: asString(raw.display_name) ?? institutionName ?? 'Account',
    mask,
    type,
    subtype,
    currency: balance?.currency ?? 'USD',
    institutionId,
    institutionName,
    fingerprint: await accountFingerprint(institutionId, mask, subtype),
    status: accountStatus(raw),
    balance,
  };
}

export function mapStripeFcTransaction(raw: JsonRecord): { transaction?: FeedTransaction; removed?: string } {
  const id = asString(raw.id);
  if (!id) return {};
  const status = asString(raw.status);
  if (status === 'void') return { removed: id };
  const accountId = asString(raw.account);
  const amount = asNumber(raw.amount);
  const transitions = asRecord(raw.status_transitions);
  const when = asNumber(transitions.posted_at) ?? asNumber(raw.transacted_at);
  if (!accountId || amount === null || when === null) return {};
  return {
    transaction: {
      providerTransactionId: id,
      pendingTransactionId: null,
      accountId,
      date: normalizeDate(when),
      amountMinor: Math.trunc(amount),
      currency: (asString(raw.currency) ?? 'usd').toUpperCase(),
      description: asString(raw.description) ?? '',
      merchantName: null,
      checkNumber: null,
      category: null,
      pending: status === 'pending',
      raw,
    },
  };
}

export class StripeFcProvider implements BankFeedProvider {
  readonly id = 'stripe_fc';
  readonly capabilities: ProviderCapabilities;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly config: StripeFcConfig) {
    this.baseUrl = config.baseUrl ?? 'https://api.stripe.com';
    this.fetchImpl = config.fetch ?? defaultFetch();
    this.capabilities = { ...CAPABILITIES, regions: config.countries ?? CAPABILITIES.regions };
  }

  private call(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, unknown> = {},
    extraHeaders: Record<string, string> = {},
  ): Promise<JsonRecord> {
    const entries = formEntries(params);
    return requestJson(`${this.baseUrl}${path}${method === 'GET' ? queryString(entries) : ''}`, {
      provider: 'stripe_fc',
      fetchImpl: this.fetchImpl,
      method,
      headers: {
        Authorization: `Basic ${btoa(`${this.config.secretKey}:`)}`,
        'Stripe-Version': this.config.apiVersion ?? STRIPE_FC_API_VERSION,
        ...extraHeaders,
      },
      form: method === 'POST' ? entries : undefined,
      mapError: mapStripeError,
    });
  }

  /** The workspace's account holder in the FC Stripe account: find by metadata, else create. */
  private async accountHolder(workspaceId: string, known: unknown): Promise<string> {
    const knownId = asString(known);
    if (knownId) return knownId;
    const found = await this.call('GET', '/v1/customers/search', {
      query: `metadata['weldsuite_workspace']:'${workspaceId.replace(/'/g, '')}'`,
      limit: 1,
    });
    const existing = asString(asRecord(asArray(found.data)[0]).id);
    if (existing) return existing;
    const created = await this.call(
      'POST',
      '/v1/customers',
      { description: `WeldSuite workspace ${workspaceId}`, metadata: { weldsuite_workspace: workspaceId } },
      { 'Idempotency-Key': `weldsuite-bank-feeds-customer-${workspaceId}` },
    );
    const id = asString(created.id);
    if (!id) throw new FeedProviderError('stripe_fc', 'permanent', 'Stripe returned no customer id');
    return id;
  }

  async createLinkSession(input: LinkSessionInput): Promise<LinkSession> {
    const customer = await this.accountHolder(input.workspaceId, input.connection?.credentials.accountHolderId);
    const session = await this.call('POST', '/v1/financial_connections/sessions', {
      account_holder: { type: 'customer', customer },
      permissions: ['transactions', 'balances'],
      prefetch: ['transactions', 'balances'],
      filters: { countries: this.config.countries ?? ['US'] },
      return_url: input.redirectUrl,
    });
    const clientSecret = asString(session.client_secret);
    if (!clientSecret) throw new FeedProviderError('stripe_fc', 'permanent', 'Stripe returned no client secret');
    return { kind: 'stripe_fc', clientSecret, sessionId: asString(session.id) ?? undefined };
  }

  private async sessionAccounts(sessionId: string, session: JsonRecord): Promise<JsonRecord[]> {
    const first = asRecord(session.accounts);
    const accounts = asArray(first.data).map(asRecord);
    if (first.has_more !== true) return accounts;
    let startingAfter = asString(accounts[accounts.length - 1]?.id);
    for (let page = 0; page < MAX_PAGES_PER_ACCOUNT && startingAfter; page += 1) {
      const next = await this.call('GET', '/v1/financial_connections/accounts', {
        session: sessionId,
        limit: PAGE_SIZE,
        starting_after: startingAfter,
      });
      const data = asArray(next.data).map(asRecord);
      accounts.push(...data);
      if (next.has_more !== true) break;
      startingAfter = asString(data[data.length - 1]?.id);
    }
    return accounts;
  }

  async completeLink(payload: unknown): Promise<{ connection: FeedConnection; accounts: FeedAccount[] }> {
    const input = asRecord(payload) as unknown as StripeFcCompletePayload;
    const sessionId = asString(input.sessionId);
    if (!sessionId) throw new FeedProviderError('stripe_fc', 'permanent', 'Stripe Financial Connections session id missing');

    const session = await this.call('GET', `/v1/financial_connections/sessions/${encodeURIComponent(sessionId)}`);
    const rawAccounts = await this.sessionAccounts(sessionId, session);

    const accounts: FeedAccount[] = [];
    for (const raw of rawAccounts) {
      const mapped = await mapAccount(raw);
      if (!mapped) continue;
      accounts.push(mapped);
      const permissions = asArray(raw.permissions).map(asString);
      const subscribed = asArray(raw.subscriptions).map(asString);
      if (permissions.includes('transactions') && !subscribed.includes('transactions')) {
        // Daily background refresh; a failed subscribe only costs the daily refresh, not the link.
        await this.call('POST', `/v1/financial_connections/accounts/${encodeURIComponent(mapped.providerAccountId)}/subscribe`, {
          features: ['transactions'],
        }).catch(() => undefined);
      }
    }

    const existing = input.connection;
    const existingIds = existing ? stringList(existing.metadata.accountIds) : [];
    const accountIds = [...new Set([...existingIds, ...accounts.map((a) => a.providerAccountId)])];
    const customer = asString(asRecord(session.account_holder).customer) ?? asString(existing?.credentials.accountHolderId);

    return {
      connection: {
        provider: 'stripe_fc',
        providerConnectionId: existing?.providerConnectionId ?? sessionId,
        indexKeys: accountIds,
        institutionId: accounts[0]?.institutionId ?? null,
        institutionName: accounts[0]?.institutionName ?? null,
        status: connectionStatus(accounts.map((a) => a.status ?? 'active')),
        credentials: { accountHolderId: customer },
        cursor: existing?.cursor ?? null,
        metadata: { accountIds },
      },
      accounts,
    };
  }

  private accountIdsOf(connection: StoredConnection): string[] {
    return connection.accountIds ?? stringList(connection.metadata.accountIds);
  }

  async listAccounts(connection: StoredConnection): Promise<FeedAccount[]> {
    const accounts: FeedAccount[] = [];
    for (const id of stringList(connection.metadata.accountIds)) {
      const mapped = await mapAccount(await this.call('GET', `/v1/financial_connections/accounts/${encodeURIComponent(id)}`));
      if (mapped) accounts.push(mapped);
    }
    return accounts;
  }

  async syncTransactions(connection: StoredConnection, cursor: unknown): Promise<SyncResult> {
    const previous = readCursor(cursor);
    const next: FcCursor = { refreshIds: { ...previous.refreshIds } };
    const upserts: FeedTransaction[] = [];
    const removals: string[] = [];
    const accountStatuses: Record<string, ConnectionStatus> = {};

    for (const accountId of this.accountIdsOf(connection)) {
      let account: JsonRecord;
      try {
        account = await this.call('GET', `/v1/financial_connections/accounts/${encodeURIComponent(accountId)}`);
      } catch (err) {
        if (err instanceof FeedProviderError && (err.kind === 'reauth_required' || err.kind === 'revoked')) {
          accountStatuses[accountId] = err.kind === 'revoked' ? 'disconnected' : 'reauth_required';
          continue;
        }
        throw err;
      }

      const status = accountStatus(account);
      accountStatuses[accountId] = status;
      if (status !== 'active') continue;

      const refresh = asRecord(account.transaction_refresh);
      const refreshId = asString(refresh.id);
      const refreshStatus = asString(refresh.status);
      // Nothing refreshed yet (prefetch still running): the refreshed_transactions webhook follows.
      if (!refreshId || refreshStatus === 'pending') continue;
      if (refreshStatus === 'succeeded' && previous.refreshIds[accountId] === refreshId) continue;

      let startingAfter: string | null = null;
      for (let page = 0; page < MAX_PAGES_PER_ACCOUNT; page += 1) {
        const response = await this.call('GET', '/v1/financial_connections/transactions', {
          account: accountId,
          limit: PAGE_SIZE,
          starting_after: startingAfter ?? undefined,
          transaction_refresh: previous.refreshIds[accountId] ? { after: previous.refreshIds[accountId] } : undefined,
        });
        const data = asArray(response.data).map(asRecord);
        for (const raw of data) {
          const mapped = mapStripeFcTransaction(raw);
          if (mapped.transaction) upserts.push(mapped.transaction);
          if (mapped.removed) removals.push(mapped.removed);
        }
        if (response.has_more !== true || data.length === 0) break;
        startingAfter = asString(data[data.length - 1]?.id);
        if (!startingAfter) break;
      }
      if (refreshStatus === 'succeeded') next.refreshIds[accountId] = refreshId;
    }

    return { upserts, removals, nextCursor: next, hasMore: false, accountStatuses };
  }

  async getBalances(connection: StoredConnection): Promise<FeedBalance[]> {
    const balances: FeedBalance[] = [];
    for (const id of this.accountIdsOf(connection)) {
      try {
        const balance = fcBalance(await this.call('GET', `/v1/financial_connections/accounts/${encodeURIComponent(id)}`));
        if (balance) balances.push(balance);
      } catch (err) {
        if (err instanceof FeedProviderError && (err.kind === 'reauth_required' || err.kind === 'revoked')) continue;
        throw err;
      }
    }
    return balances;
  }

  async refresh(connection: StoredConnection): Promise<void> {
    for (const id of this.accountIdsOf(connection)) {
      try {
        await this.call('POST', `/v1/financial_connections/accounts/${encodeURIComponent(id)}/refresh`, {
          features: ['transactions', 'balance'],
        });
      } catch (err) {
        // Refreshes are rate limited per account (next_refresh_available_at); the daily one still runs.
        if (err instanceof FeedProviderError && err.kind !== 'auth' && err.kind !== 'transient') continue;
        throw err;
      }
    }
  }

  async disconnect(connection: StoredConnection): Promise<void> {
    for (const id of this.accountIdsOf(connection)) {
      try {
        await this.call('POST', `/v1/financial_connections/accounts/${encodeURIComponent(id)}/disconnect`);
      } catch (err) {
        // Already disconnected or gone on Stripe's side.
        if (err instanceof FeedProviderError && (err.kind === 'permanent' || err.kind === 'reauth_required' || err.kind === 'revoked')) continue;
        throw err;
      }
    }
  }

  async parseWebhook(request: Request, secrets: ProviderSecrets): Promise<FeedEvent[]> {
    const payload = await request.text();
    if (!secrets.webhookSecret) throw new WebhookVerificationError('Stripe Financial Connections webhook secret not configured');
    const valid = await verifyStripeSignature({
      payload,
      header: request.headers.get('Stripe-Signature'),
      secret: secrets.webhookSecret,
      now: secrets.now,
    });
    if (!valid) throw new WebhookVerificationError('Invalid Stripe signature');

    let event: JsonRecord;
    try {
      event = asRecord(JSON.parse(payload));
    } catch {
      return [];
    }
    return stripeFcEventsFromWebhook(event);
  }
}

function stringList(value: unknown): string[] {
  return asArray(value).filter((v): v is string => typeof v === 'string');
}

/** A Stripe event to feed events; only `financial_connections.account.*` matters. */
export function stripeFcEventsFromWebhook(event: JsonRecord): FeedEvent[] {
  const type = asString(event.type);
  const account = asRecord(asRecord(event.data).object);
  const accountId = asString(account.id);
  if (!type || !accountId || !type.startsWith('financial_connections.account.')) return [];
  const base = { providerConnectionId: accountId, accountIds: [accountId] };

  switch (type) {
    case 'financial_connections.account.refreshed_transactions':
      return asString(asRecord(account.transaction_refresh).status) === 'succeeded' ? [{ type: 'sync_available', ...base }] : [];
    // A relink makes the account active again; the next sync reads the status back.
    case 'financial_connections.account.reactivated':
      return [{ type: 'sync_available', ...base }];
    case 'financial_connections.account.deactivated':
      return [{ type: 'reauth_required', ...base }];
    case 'financial_connections.account.disconnected':
      return [{ type: 'disconnected', ...base }];
    case 'financial_connections.account.upcoming_deactivation':
      return [{ type: 'expiring', ...base }];
    default:
      return [];
  }
}

export function createStripeFcProvider(config: StripeFcConfig): StripeFcProvider {
  return new StripeFcProvider(config);
}
