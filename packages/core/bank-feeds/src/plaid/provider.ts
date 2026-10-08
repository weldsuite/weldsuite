/**
 * Plaid adapter (raw fetch; the SDK drags in axios).
 *
 * Connection = Plaid Item. Sync is `/transactions/sync`: a server-side change
 * cursor with added / modified / removed. Plaid sends decimals with outflows
 * positive, so amounts are negated into the statement convention, and a posted
 * transaction arrives under a new id linked through `pending_transaction_id`.
 */

import { FeedProviderError } from '../errors';
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  defaultFetch,
  requestJson,
  type FetchLike,
  type JsonRecord,
} from '../http';
import {
  accountFingerprint,
  decimalToMinor,
  normalizeDate,
  persistentAccountFingerprint,
  plaidAmountToMinor,
} from '../normalize';
import type {
  BankFeedProvider,
  FeedAccount,
  FeedAccountType,
  FeedBalance,
  FeedConnection,
  FeedEvent,
  FeedTransaction,
  KeyCache,
  LinkSession,
  LinkSessionInput,
  ProviderCapabilities,
  ProviderSecrets,
  StoredConnection,
  SyncResult,
} from '../types';
import { createPlaidKeyResolver, verifyPlaidWebhook } from '../webhook';

export const PLAID_BASE_URLS = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
} as const;

export const PLAID_MAX_HISTORY_DAYS = 730;
const PLAID_PAGE_SIZE = 500;

export interface PlaidConfig {
  clientId: string;
  secret: string;
  env: 'sandbox' | 'production';
  /** Overrides the environment's base URL (tests, proxies). */
  baseUrl?: string;
  /** Public URL Plaid posts webhooks to (`<webhook worker>/webhooks/bank-feeds/plaid`). */
  webhookUrl?: string;
  /** Countries Link offers banks in. Default `['US']`. */
  countryCodes?: string[];
  clientName?: string;
  language?: string;
  /**
   * OAuth redirect URI, which must be registered in the Plaid dashboard (an unregistered one
   * fails the link). Needed for OAuth banks such as Chase; omitted from the link token when unset.
   */
  redirectUri?: string;
  /**
   * Read balances with `/accounts/balance/get` (real time, billed per request)
   * instead of `/accounts/get` (cached from the last update, included with
   * Transactions). Default false.
   */
  realtimeBalance?: boolean;
  keyCache?: KeyCache;
  fetch?: FetchLike;
}

export interface PlaidCompletePayload {
  /** From Link's onSuccess. Absent in update mode (reauth), where the Item already exists. */
  publicToken?: string;
  /** From Link's onSuccess metadata, saves a lookup. */
  institution?: { institutionId?: string | null; name?: string | null };
  /** The stored connection, for `reauth` and `add_accounts`. */
  connection?: StoredConnection;
}

const CAPABILITIES: ProviderCapabilities = {
  regions: ['US'],
  changeCursor: true,
  webhooks: true,
  pendingTransactions: true,
  maxHistoryDays: PLAID_MAX_HISTORY_DAYS,
  onDemandRefresh: true,
  accountTypes: ['depository', 'credit', 'loan'],
};

function accessTokenOf(connection: StoredConnection | undefined): string {
  const token = connection ? asString(connection.credentials.accessToken) : null;
  if (!token) throw new FeedProviderError('plaid', 'permanent', 'Plaid connection has no access token');
  return token;
}

function mapPlaidError(status: number, body: JsonRecord): FeedProviderError | null {
  const code = asString(body.error_code);
  if (!code) return null;
  const message = `Plaid ${code}${asString(body.error_message) ? `: ${asString(body.error_message)}` : ''}`;
  const extra = { status, code };
  switch (code) {
    case 'ITEM_LOGIN_REQUIRED':
    case 'ITEM_LOCKED':
    case 'INVALID_CREDENTIALS':
    case 'INVALID_MFA':
    case 'ITEM_NO_VERIFICATION':
      return new FeedProviderError('plaid', 'reauth_required', message, extra);
    case 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION':
      return new FeedProviderError('plaid', 'mutation_during_pagination', message, extra);
    case 'ITEM_NOT_FOUND':
    case 'ACCESS_NOT_GRANTED':
    case 'USER_PERMISSION_REVOKED':
      return new FeedProviderError('plaid', 'revoked', message, extra);
    case 'RATE_LIMIT_EXCEEDED':
    case 'TRANSACTIONS_LIMIT':
      return new FeedProviderError('plaid', 'rate_limit', message, extra);
    case 'INVALID_API_KEYS':
    case 'INVALID_CLIENT_ID':
    case 'INVALID_SECRET':
    case 'UNAUTHORIZED_ENVIRONMENT':
      return new FeedProviderError('plaid', 'auth', message, extra);
    case 'PRODUCT_NOT_READY':
    case 'INTERNAL_SERVER_ERROR':
    case 'PLANNED_MAINTENANCE':
    case 'INSTITUTION_DOWN':
    case 'INSTITUTION_NOT_RESPONDING':
      return new FeedProviderError('plaid', 'transient', message, extra);
    default:
      return null;
  }
}

function subtypeOf(value: unknown): string | null {
  const raw = asString(value);
  return raw ? raw.trim().toLowerCase().replace(/[\s-]+/g, '_') : null;
}

function accountTypeOf(value: unknown): FeedAccountType | null {
  const raw = asString(value);
  return raw === 'depository' || raw === 'credit' || raw === 'loan' ? raw : null;
}

export function plaidBalance(account: JsonRecord, type: FeedAccountType, currency: string, asOf: string): FeedBalance | null {
  const balances = asRecord(account.balances);
  const current = asNumber(balances.current);
  const accountId = asString(account.account_id);
  if (current === null || !accountId) return null;
  const available = asNumber(balances.available);
  const limit = asNumber(balances.limit);
  const minor = decimalToMinor(current, currency);
  return {
    accountId,
    // A card's current balance is what is owed; the feed signs it like a ledger liability.
    current: type === 'credit' || type === 'loan' ? (minor === 0 ? 0 : -minor) : minor,
    available: available === null ? null : decimalToMinor(available, currency),
    limit: limit === null ? null : decimalToMinor(limit, currency),
    currency,
    asOf,
  };
}

async function mapAccount(
  raw: JsonRecord,
  institution: { id: string | null; name: string | null },
  asOf: string,
): Promise<FeedAccount | null> {
  const providerAccountId = asString(raw.account_id);
  const type = accountTypeOf(raw.type);
  if (!providerAccountId || !type) return null;
  const subtype = subtypeOf(raw.subtype);
  const mask = asString(raw.mask);
  const balances = asRecord(raw.balances);
  const currency = asString(balances.iso_currency_code) ?? asString(balances.unofficial_currency_code) ?? 'USD';
  const persistent = asString(raw.persistent_account_id);
  return {
    providerAccountId,
    name: asString(raw.name) ?? asString(raw.official_name) ?? 'Account',
    mask,
    type,
    subtype,
    currency,
    institutionId: institution.id,
    institutionName: institution.name,
    fingerprint: persistent
      ? await persistentAccountFingerprint(persistent)
      : await accountFingerprint(institution.id ?? institution.name, mask, subtype),
    balance: plaidBalance(raw, type, currency, asOf),
  };
}

export function mapPlaidTransaction(raw: JsonRecord): FeedTransaction | null {
  const providerTransactionId = asString(raw.transaction_id);
  const accountId = asString(raw.account_id);
  const amount = asNumber(raw.amount);
  const date = asString(raw.date);
  if (!providerTransactionId || !accountId || amount === null || !date) return null;
  const currency = asString(raw.iso_currency_code) ?? asString(raw.unofficial_currency_code) ?? 'USD';
  const category = asRecord(raw.personal_finance_category);
  return {
    providerTransactionId,
    pendingTransactionId: asString(raw.pending_transaction_id),
    accountId,
    date: normalizeDate(date),
    amountMinor: plaidAmountToMinor(amount, currency),
    currency,
    description: asString(raw.name) ?? asString(raw.original_description) ?? '',
    merchantName: asString(raw.merchant_name),
    checkNumber: asString(raw.check_number),
    category: asString(category.primary)
      ? {
          source: 'plaid',
          primary: asString(category.primary),
          detailed: asString(category.detailed),
          confidence: asString(category.confidence_level),
        }
      : null,
    pending: raw.pending === true,
    raw,
  };
}

export class PlaidProvider implements BankFeedProvider {
  readonly id = 'plaid';
  readonly capabilities: ProviderCapabilities;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly config: PlaidConfig) {
    this.baseUrl = config.baseUrl ?? PLAID_BASE_URLS[config.env];
    this.fetchImpl = config.fetch ?? defaultFetch();
    this.capabilities = { ...CAPABILITIES, regions: config.countryCodes ?? CAPABILITIES.regions };
  }

  private call(path: string, body: Record<string, unknown>): Promise<JsonRecord> {
    return requestJson(`${this.baseUrl}${path}`, {
      provider: 'plaid',
      fetchImpl: this.fetchImpl,
      json: { client_id: this.config.clientId, secret: this.config.secret, ...body },
      mapError: mapPlaidError,
    });
  }

  async createLinkSession(input: LinkSessionInput): Promise<LinkSession> {
    const body: Record<string, unknown> = {
      client_name: this.config.clientName ?? 'WeldSuite',
      language: this.config.language ?? 'en',
      country_codes: this.config.countryCodes ?? ['US'],
      user: { client_user_id: input.workspaceId },
    };
    if (this.config.webhookUrl) body.webhook = this.config.webhookUrl;
    if (this.config.redirectUri) body.redirect_uri = this.config.redirectUri;

    if (input.mode === 'create') {
      // Only `transactions`: asking for `auth` hides credit cards in Link. History is fixed
      // when the Item is created, so ask for the most up front.
      body.products = ['transactions'];
      body.transactions = { days_requested: Math.max(30, Math.min(input.historyDays, PLAID_MAX_HISTORY_DAYS)) };
      body.account_filters = { depository: { account_subtypes: ['all'] }, credit: { account_subtypes: ['all'] } };
    } else {
      body.access_token = accessTokenOf(input.connection);
      if (input.mode === 'add_accounts') body.update = { account_selection_enabled: true };
    }

    const response = await this.call('/link/token/create', body);
    const token = asString(response.link_token);
    if (!token) throw new FeedProviderError('plaid', 'permanent', 'Plaid returned no link token');
    return { kind: 'plaid_link', token, expiresAt: asString(response.expiration) };
  }

  async completeLink(payload: unknown): Promise<{ connection: FeedConnection; accounts: FeedAccount[] }> {
    const input = asRecord(payload) as PlaidCompletePayload;
    let accessToken: string;
    let itemId: string | null = null;
    let cursor: unknown = null;

    if (input.publicToken) {
      const exchanged = await this.call('/item/public_token/exchange', { public_token: input.publicToken });
      accessToken = asString(exchanged.access_token) ?? '';
      itemId = asString(exchanged.item_id);
      if (!accessToken || !itemId) throw new FeedProviderError('plaid', 'permanent', 'Plaid token exchange returned no item');
    } else {
      accessToken = accessTokenOf(input.connection);
      itemId = input.connection?.providerConnectionId ?? null;
      cursor = input.connection?.cursor ?? null;
    }

    const fetched = await this.call('/accounts/get', { access_token: accessToken });
    const item = asRecord(fetched.item);
    itemId = itemId ?? asString(item.item_id);
    if (!itemId) throw new FeedProviderError('plaid', 'permanent', 'Plaid returned no item id');

    const institutionId = input.institution?.institutionId ?? asString(item.institution_id);
    const institutionName = input.institution?.name ?? asString(item.institution_name) ?? (await this.institutionName(institutionId));
    const accounts = await this.mapAccounts(fetched, { id: institutionId, name: institutionName });

    const itemError = asRecord(item.error);
    return {
      connection: {
        provider: 'plaid',
        providerConnectionId: itemId,
        institutionId,
        institutionName,
        status: asString(itemError.error_code) === 'ITEM_LOGIN_REQUIRED' ? 'reauth_required' : 'active',
        credentials: { accessToken },
        cursor,
        consentExpiresAt: asString(item.consent_expiration_time),
      },
      accounts,
    };
  }

  private async institutionName(institutionId: string | null): Promise<string | null> {
    if (!institutionId) return null;
    try {
      const response = await this.call('/institutions/get_by_id', {
        institution_id: institutionId,
        country_codes: this.config.countryCodes ?? ['US'],
      });
      return asString(asRecord(response.institution).name);
    } catch {
      return null;
    }
  }

  private async mapAccounts(
    response: JsonRecord,
    institution: { id: string | null; name: string | null },
  ): Promise<FeedAccount[]> {
    const asOf = new Date().toISOString();
    const accounts: FeedAccount[] = [];
    for (const raw of asArray(response.accounts)) {
      const mapped = await mapAccount(asRecord(raw), institution, asOf);
      if (mapped) accounts.push(mapped);
    }
    return accounts;
  }

  async listAccounts(connection: StoredConnection): Promise<FeedAccount[]> {
    const response = await this.call('/accounts/get', { access_token: accessTokenOf(connection) });
    const item = asRecord(response.item);
    const institutionId = asString(item.institution_id);
    return this.mapAccounts(response, { id: institutionId, name: asString(item.institution_name) ?? (await this.institutionName(institutionId)) });
  }

  async syncTransactions(connection: StoredConnection, cursor: unknown): Promise<SyncResult> {
    const accessToken = accessTokenOf(connection);
    const current = typeof cursor === 'string' && cursor !== '' ? cursor : undefined;
    let response: JsonRecord;
    try {
      response = await this.call('/transactions/sync', {
        access_token: accessToken,
        cursor: current,
        count: PLAID_PAGE_SIZE,
        options: { include_personal_finance_category: true },
      });
    } catch (err) {
      // The first pull is still running at Plaid; the SYNC_UPDATES_AVAILABLE webhook follows.
      if (err instanceof FeedProviderError && err.code === 'PRODUCT_NOT_READY') {
        return { upserts: [], removals: [], nextCursor: cursor ?? null, hasMore: false };
      }
      throw err;
    }

    const upserts: FeedTransaction[] = [];
    // `modified` is an upsert like `added`: the same provider id, new values.
    for (const raw of [...asArray(response.added), ...asArray(response.modified)]) {
      const mapped = mapPlaidTransaction(asRecord(raw));
      if (mapped) upserts.push(mapped);
    }
    const removals = asArray(response.removed)
      .map((r) => asString(asRecord(r).transaction_id))
      .filter((id): id is string => id !== null);
    const nextCursor = asString(response.next_cursor);

    return {
      upserts,
      removals,
      nextCursor: nextCursor ? nextCursor : (cursor ?? null),
      hasMore: response.has_more === true,
    };
  }

  async getBalances(connection: StoredConnection): Promise<FeedBalance[]> {
    const response = await this.call(this.config.realtimeBalance ? '/accounts/balance/get' : '/accounts/get', {
      access_token: accessTokenOf(connection),
    });
    const asOf = new Date().toISOString();
    const balances: FeedBalance[] = [];
    for (const raw of asArray(response.accounts)) {
      const account = asRecord(raw);
      const type = accountTypeOf(account.type);
      if (!type) continue;
      const bal = asRecord(account.balances);
      const currency = asString(bal.iso_currency_code) ?? asString(bal.unofficial_currency_code) ?? 'USD';
      const balance = plaidBalance(account, type, currency, asOf);
      if (balance) balances.push(balance);
    }
    return balances;
  }

  async refresh(connection: StoredConnection): Promise<void> {
    await this.call('/transactions/refresh', { access_token: accessTokenOf(connection) });
  }

  async disconnect(connection: StoredConnection): Promise<void> {
    try {
      await this.call('/item/remove', { access_token: accessTokenOf(connection) });
    } catch (err) {
      // Already removed on Plaid's side: nothing left to revoke.
      if (err instanceof FeedProviderError && (err.kind === 'revoked' || err.code === 'ITEM_NOT_FOUND')) return;
      throw err;
    }
  }

  async parseWebhook(request: Request, secrets: ProviderSecrets): Promise<FeedEvent[]> {
    const body = await request.text();
    await verifyPlaidWebhook({
      body,
      header: request.headers.get('Plaid-Verification'),
      getKey: createPlaidKeyResolver({
        baseUrl: this.baseUrl,
        clientId: this.config.clientId,
        secret: this.config.secret,
        cache: secrets.keyCache ?? this.config.keyCache,
        fetchImpl: this.fetchImpl,
      }),
      now: secrets.now,
    });

    let payload: JsonRecord;
    try {
      payload = asRecord(JSON.parse(body));
    } catch {
      return [];
    }
    return plaidEventsFromWebhook(payload);
  }
}

/** Plaid webhook body to feed events. Unknown deliveries map to nothing. */
export function plaidEventsFromWebhook(payload: JsonRecord): FeedEvent[] {
  const itemId = asString(payload.item_id);
  const type = asString(payload.webhook_type);
  const code = asString(payload.webhook_code);
  if (!itemId || !type || !code) return [];

  if (type === 'TRANSACTIONS') {
    const syncCodes = new Set(['SYNC_UPDATES_AVAILABLE', 'INITIAL_UPDATE', 'HISTORICAL_UPDATE', 'DEFAULT_UPDATE', 'TRANSACTIONS_REMOVED']);
    return syncCodes.has(code) ? [{ type: 'sync_available', providerConnectionId: itemId }] : [];
  }

  if (type === 'ITEM') {
    const error = asRecord(payload.error);
    switch (code) {
      case 'ERROR':
        return [
          asString(error.error_code) === 'ITEM_LOGIN_REQUIRED'
            ? { type: 'reauth_required', providerConnectionId: itemId, message: asString(error.error_message) }
            : { type: 'error', providerConnectionId: itemId, message: asString(error.error_code) ?? 'Plaid item error' },
        ];
      case 'PENDING_EXPIRATION':
      case 'PENDING_DISCONNECT':
        return [{ type: 'expiring', providerConnectionId: itemId, expiresAt: asString(payload.consent_expiration_time) }];
      case 'USER_PERMISSION_REVOKED':
        return [{ type: 'revoked', providerConnectionId: itemId }];
      case 'USER_ACCOUNT_REVOKED': {
        const accountId = asString(payload.account_id);
        return [{ type: 'disconnected', providerConnectionId: itemId, accountIds: accountId ? [accountId] : undefined }];
      }
      default:
        return [];
    }
  }
  return [];
}

export function createPlaidProvider(config: PlaidConfig): PlaidProvider {
  return new PlaidProvider(config);
}
