/**
 * Ponto (Isabel Group) adapter, Europe (Belgium and the Netherlands first).
 *
 * NOT LIVE-TESTED. Written from Ponto Connect's documented OAuth2 flow and
 * JSON:API shapes and covered by hand-written fixtures only; verify the
 * endpoint paths, paging and token lifetimes against the sandbox before
 * relying on it.
 *
 * Calls to `api.ibanity.com` need mutual TLS (a client certificate, and
 * request signing for payments, which we do not use). On Workers pass
 * `fetch: env.PONTO_CERT.fetch.bind(env.PONTO_CERT)` from an `mtls_certificates`
 * binding in `fetch`; the default is the global `fetch`, which works against
 * `api.myponto.com` (set `apiUrl`) when that host is used instead.
 *
 * Onboarding is OAuth2 authorization code with PKCE. There is no server-side
 * change feed: sync is date-range polling that re-pulls the last 8 days.
 * Refresh tokens rotate, so token refreshes are returned in
 * `SyncResult.credentials` for the caller to store.
 */

import { FeedProviderError, WebhookVerificationError } from '../errors';
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  defaultFetch,
  queryString,
  requestJson,
  toBase64Url,
  utf8,
  type FetchLike,
  type JsonRecord,
} from '../http';
import {
  accountFingerprint,
  decimalToMinor,
  ibanFingerprint,
  normalizeDate,
  rePullWindow,
} from '../normalize';
import type {
  BankFeedProvider,
  FeedAccount,
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

export const PONTO_MAX_HISTORY_DAYS = 540;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

export interface PontoConfig {
  clientId: string;
  clientSecret: string;
  /** Ponto Connect API. Default Ibanity's host, which needs the mTLS `fetch`. */
  apiUrl?: string;
  /** OAuth2 authorization endpoint. */
  authorizeUrl?: string;
  /** OAuth2 token endpoint. Default `<apiUrl>/oauth2/token`. */
  tokenUrl?: string;
  scope?: string;
  /** Key for deriving PKCE verifiers from the state; defaults to the client secret. */
  stateSecret?: string;
  /** `env.PONTO_CERT.fetch` from a Workers mTLS binding. */
  fetch?: FetchLike;
}

export interface PontoCompletePayload {
  /** The `code` the redirect carried. */
  code: string;
  /** The `state` the redirect carried (it derives the PKCE verifier). */
  state: string;
  redirectUrl: string;
  connection?: StoredConnection;
}

const CAPABILITIES: ProviderCapabilities = {
  regions: ['BE', 'NL', 'LU', 'FR', 'DE', 'ES', 'IT', 'AT', 'PT', 'IE', 'FI'],
  changeCursor: false,
  // Ponto can push new-transaction webhooks, but they need their own signature scheme; polled for now.
  webhooks: false,
  pendingTransactions: false,
  maxHistoryDays: PONTO_MAX_HISTORY_DAYS,
  onDemandRefresh: true,
  consentTtlDays: 180,
  accountTypes: ['depository'],
};

interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** ISO timestamp */
  expiresAt: string;
}

interface PontoCursor {
  through: string | null;
}

function readCursor(value: unknown): PontoCursor {
  return { through: asString(asRecord(value).through) };
}

function readTokens(credentials: Record<string, unknown>): Tokens {
  const accessToken = asString(credentials.accessToken);
  const refreshToken = asString(credentials.refreshToken);
  if (!accessToken || !refreshToken) throw new FeedProviderError('ponto', 'reauth_required', 'Ponto connection has no tokens');
  return { accessToken, refreshToken, expiresAt: asString(credentials.expiresAt) ?? new Date(0).toISOString() };
}

function mapPontoError(status: number, body: JsonRecord): FeedProviderError | null {
  const errors = asArray(body.errors).map(asRecord);
  const code = asString(errors[0]?.code) ?? asString(body.error);
  const detail = asString(errors[0]?.detail) ?? asString(body.error_description);
  const message = `Ponto${code ? ` ${code}` : ''}${detail ? `: ${detail}` : ''}`;
  if (code === 'invalid_grant' || code === 'invalid_token' || code === 'accessDenied') {
    return new FeedProviderError('ponto', 'reauth_required', message, { status, code });
  }
  if (code === 'authorizationRevoked') return new FeedProviderError('ponto', 'revoked', message, { status, code });
  return null;
}

export class PontoProvider implements BankFeedProvider {
  readonly id = 'ponto';
  readonly capabilities = CAPABILITIES;
  private readonly apiUrl: string;
  private readonly fetchImpl: FetchLike;
  /** Tokens refreshed during this request, so later calls reuse them. */
  private readonly refreshed = new Map<string, Tokens>();

  constructor(private readonly config: PontoConfig) {
    this.apiUrl = config.apiUrl ?? 'https://api.ibanity.com/ponto-connect';
    this.fetchImpl = config.fetch ?? defaultFetch();
  }

  private get basicAuth(): string {
    return `Basic ${btoa(`${this.config.clientId}:${this.config.clientSecret}`)}`;
  }

  private tokenRequest(form: Array<[string, string]>): Promise<JsonRecord> {
    return requestJson(this.config.tokenUrl ?? `${this.apiUrl}/oauth2/token`, {
      provider: 'ponto',
      fetchImpl: this.fetchImpl,
      method: 'POST',
      headers: { Authorization: this.basicAuth },
      form,
      mapError: mapPontoError,
    });
  }

  private toTokens(response: JsonRecord): Tokens {
    const accessToken = asString(response.access_token);
    const refreshToken = asString(response.refresh_token);
    if (!accessToken || !refreshToken) throw new FeedProviderError('ponto', 'permanent', 'Ponto returned no tokens');
    const expiresIn = asNumber(response.expires_in) ?? 1800;
    return { accessToken, refreshToken, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
  }

  /** A usable access token, refreshing (and rotating the refresh token) when it is about to expire. */
  private async ensureTokens(connection: StoredConnection): Promise<{ tokens: Tokens; changed: boolean }> {
    const cached = this.refreshed.get(connection.providerConnectionId);
    if (cached) return { tokens: cached, changed: true };
    const tokens = readTokens(connection.credentials);
    if (Date.parse(tokens.expiresAt) - Date.now() > 60_000) return { tokens, changed: false };
    const next = this.toTokens(
      await this.tokenRequest([
        ['grant_type', 'refresh_token'],
        ['refresh_token', tokens.refreshToken],
      ]),
    );
    this.refreshed.set(connection.providerConnectionId, next);
    return { tokens: next, changed: true };
  }

  private get(url: string, accessToken: string): Promise<JsonRecord> {
    return requestJson(url, {
      provider: 'ponto',
      fetchImpl: this.fetchImpl,
      headers: { Authorization: `Bearer ${accessToken}` },
      mapError: mapPontoError,
    });
  }

  /** PKCE verifier derived from the state, so no verifier is stored or sent to the browser. */
  private async verifierFor(state: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw',
      utf8(this.config.stateSecret ?? this.config.clientSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(`ponto-pkce|${state}`))));
  }

  async createLinkSession(input: LinkSessionInput): Promise<LinkSession> {
    const state = toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
    const verifier = await this.verifierFor(state);
    const challenge = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(verifier))));
    const url = `${this.config.authorizeUrl ?? 'https://authorization.myponto.com/oauth2/auth'}${queryString([
      ['client_id', this.config.clientId],
      ['redirect_uri', input.redirectUrl],
      ['response_type', 'code'],
      ['scope', this.config.scope ?? 'ai'],
      ['state', state],
      ['code_challenge', challenge],
      ['code_challenge_method', 'S256'],
    ])}`;
    return { kind: 'redirect', url, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
  }

  async completeLink(payload: unknown): Promise<{ connection: FeedConnection; accounts: FeedAccount[] }> {
    const input = asRecord(payload) as unknown as PontoCompletePayload;
    const code = asString(input.code);
    const state = asString(input.state);
    const redirectUrl = asString(input.redirectUrl);
    if (!code || !state || !redirectUrl) throw new FeedProviderError('ponto', 'permanent', 'Ponto authorization response incomplete');

    const tokens = this.toTokens(
      await this.tokenRequest([
        ['grant_type', 'authorization_code'],
        ['code', code],
        ['redirect_uri', redirectUrl],
        ['client_id', this.config.clientId],
        ['code_verifier', await this.verifierFor(state)],
      ]),
    );

    const rawAccounts = await this.listRawAccounts(tokens.accessToken);
    const accounts: FeedAccount[] = [];
    let earliestExpiry: string | null = null;
    for (const raw of rawAccounts) {
      const mapped = await this.mapAccount(raw);
      if (mapped) accounts.push(mapped);
      const expires = asString(asRecord(raw.attributes).authorizationExpirationExpectedAt);
      if (expires && (!earliestExpiry || expires < earliestExpiry)) earliestExpiry = expires;
    }

    const existing = input.connection;
    return {
      connection: {
        provider: 'ponto',
        providerConnectionId: existing?.providerConnectionId ?? crypto.randomUUID(),
        institutionId: null,
        institutionName: 'Ponto',
        status: 'active',
        credentials: { ...tokens },
        cursor: existing?.cursor ?? null,
        consentExpiresAt: earliestExpiry,
        metadata: { accountIds: accounts.map((a) => a.providerAccountId) },
      },
      accounts,
    };
  }

  private async listRawAccounts(accessToken: string): Promise<JsonRecord[]> {
    const accounts: JsonRecord[] = [];
    let url: string | null = `${this.apiUrl}/accounts${queryString([['page[limit]', String(PAGE_SIZE)]])}`;
    for (let page = 0; page < MAX_PAGES && url; page += 1) {
      const response = await this.get(url, accessToken);
      accounts.push(...asArray(response.data).map(asRecord));
      url = asString(asRecord(response.links).next);
    }
    return accounts;
  }

  private async mapAccount(raw: JsonRecord): Promise<FeedAccount | null> {
    const providerAccountId = asString(raw.id);
    const attributes = asRecord(raw.attributes);
    if (!providerAccountId) return null;
    const reference = asString(attributes.reference);
    const iban = asString(attributes.referenceType) === 'IBAN' ? reference : null;
    const subtype = (asString(attributes.subtype) ?? 'checking').toLowerCase();
    const institutionId = asString(asRecord(asRecord(asRecord(raw.relationships).financialInstitution).data).id);
    return {
      providerAccountId,
      name: asString(attributes.description) ?? asString(attributes.holderName) ?? reference ?? 'Account',
      mask: reference ? reference.slice(-4) : null,
      iban,
      type: 'depository',
      subtype,
      currency: (asString(attributes.currency) ?? 'EUR').toUpperCase(),
      institutionId,
      institutionName: null,
      fingerprint: iban ? await ibanFingerprint(iban) : await accountFingerprint(institutionId, reference, subtype),
      balance: pontoBalance(raw),
    };
  }

  async listAccounts(connection: StoredConnection): Promise<FeedAccount[]> {
    const { tokens } = await this.ensureTokens(connection);
    const accounts: FeedAccount[] = [];
    for (const raw of await this.listRawAccounts(tokens.accessToken)) {
      const mapped = await this.mapAccount(raw);
      if (mapped) accounts.push(mapped);
    }
    return accounts;
  }

  async syncTransactions(connection: StoredConnection, cursor: unknown): Promise<SyncResult> {
    const { tokens, changed } = await this.ensureTokens(connection);
    const today = new Date().toISOString().slice(0, 10);
    const window = rePullWindow({
      lastThrough: readCursor(cursor).through,
      today,
      historyDays: Math.min(connection.historyDays ?? PONTO_MAX_HISTORY_DAYS, PONTO_MAX_HISTORY_DAYS),
    });

    const upserts: FeedTransaction[] = [];
    for (const accountId of connection.accountIds ?? asArray(connection.metadata.accountIds).filter((v): v is string => typeof v === 'string')) {
      let url: string | null = `${this.apiUrl}/accounts/${encodeURIComponent(accountId)}/transactions${queryString([['page[limit]', String(PAGE_SIZE)]])}`;
      let reachedWindowStart = false;
      for (let page = 0; page < MAX_PAGES && url && !reachedWindowStart; page += 1) {
        const response = await this.get(url, tokens.accessToken);
        const data = asArray(response.data).map(asRecord);
        for (const raw of data) {
          const tx = mapPontoTransaction(raw, accountId);
          if (!tx) continue;
          // Newest first: once a page dips below the window the rest is older.
          if (tx.date < window.from) {
            reachedWindowStart = true;
            continue;
          }
          if (tx.date <= window.to) upserts.push(tx);
        }
        url = data.length === 0 ? null : asString(asRecord(response.links).next);
      }
    }

    return {
      upserts,
      removals: [],
      nextCursor: { through: window.to } satisfies PontoCursor,
      hasMore: false,
      credentials: changed ? { ...tokens } : undefined,
    };
  }

  async getBalances(connection: StoredConnection): Promise<FeedBalance[]> {
    const { tokens } = await this.ensureTokens(connection);
    const balances: FeedBalance[] = [];
    for (const accountId of connection.accountIds ?? asArray(connection.metadata.accountIds).filter((v): v is string => typeof v === 'string')) {
      const response = await this.get(`${this.apiUrl}/accounts/${encodeURIComponent(accountId)}`, tokens.accessToken);
      const balance = pontoBalance(asRecord(response.data));
      if (balance) balances.push(balance);
    }
    return balances;
  }

  /** Ask Ponto to fetch fresh transactions from the bank; they show up on the next sync. */
  async refresh(connection: StoredConnection): Promise<void> {
    const { tokens } = await this.ensureTokens(connection);
    for (const accountId of connection.accountIds ?? asArray(connection.metadata.accountIds).filter((v): v is string => typeof v === 'string')) {
      await requestJson(`${this.apiUrl}/synchronizations`, {
        provider: 'ponto',
        fetchImpl: this.fetchImpl,
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/vnd.api+json' },
        json: { data: { type: 'synchronization', attributes: { resourceType: 'account', resourceId: accountId, subtype: 'accountTransactions' } } },
        mapError: mapPontoError,
      });
    }
  }

  async disconnect(connection: StoredConnection): Promise<void> {
    let tokens: Tokens;
    try {
      tokens = readTokens(connection.credentials);
    } catch {
      return;
    }
    try {
      await requestJson(this.config.tokenUrl ? this.config.tokenUrl.replace(/token$/, 'revoke') : `${this.apiUrl}/oauth2/revoke`, {
        provider: 'ponto',
        fetchImpl: this.fetchImpl,
        method: 'POST',
        headers: { Authorization: this.basicAuth },
        form: [['token', tokens.refreshToken]],
        mapError: mapPontoError,
      });
    } catch (err) {
      // Already revoked.
      if (err instanceof FeedProviderError && (err.kind === 'reauth_required' || err.kind === 'revoked' || err.kind === 'permanent')) return;
      throw err;
    }
  }

  async parseWebhook(_request: Request, _secrets: ProviderSecrets): Promise<FeedEvent[]> {
    throw new WebhookVerificationError('Ponto webhooks are not enabled; connections are polled');
  }
}

function pontoBalance(raw: JsonRecord): FeedBalance | null {
  const accountId = asString(raw.id);
  const attributes = asRecord(raw.attributes);
  const current = asNumber(attributes.currentBalance);
  if (!accountId || current === null) return null;
  const currency = (asString(attributes.currency) ?? 'EUR').toUpperCase();
  const available = asNumber(attributes.availableBalance);
  return {
    accountId,
    current: decimalToMinor(current, currency),
    available: available === null ? null : decimalToMinor(available, currency),
    limit: null,
    currency,
    asOf: asString(attributes.synchronizedAt) ?? new Date().toISOString(),
  };
}

/** Ponto amounts are signed decimals: debits negative, already the statement convention. */
export function mapPontoTransaction(raw: JsonRecord, accountId: string): FeedTransaction | null {
  const id = asString(raw.id);
  const attributes = asRecord(raw.attributes);
  const amount = asNumber(attributes.amount);
  const when = asString(attributes.executionDate) ?? asString(attributes.valueDate);
  if (!id || amount === null || !when) return null;
  const currency = (asString(attributes.currency) ?? 'EUR').toUpperCase();
  return {
    providerTransactionId: id,
    pendingTransactionId: null,
    accountId,
    date: normalizeDate(when),
    amountMinor: decimalToMinor(amount, currency),
    currency,
    description: asString(attributes.remittanceInformation) ?? asString(attributes.description) ?? asString(attributes.counterpartName) ?? '',
    merchantName: asString(attributes.counterpartName),
    checkNumber: null,
    category: null,
    pending: false,
    raw,
  };
}

export function createPontoProvider(config: PontoConfig): PontoProvider {
  return new PontoProvider(config);
}

