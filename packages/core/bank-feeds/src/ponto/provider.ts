/**
 * Ponto (Isabel Group) adapter, Europe (Belgium and the Netherlands first),
 * on Ponto Connect API version 2
 * (https://documentation.isabel.eu/ponto-connect/2/api).
 *
 * Calls to `api.ibanity.com` need mutual TLS (a client certificate); the
 * certificate decides whether the sandbox or live data answers. On Workers
 * pass `fetch: env.PONTO_CERT.fetch.bind(env.PONTO_CERT)` from an
 * `mtls_certificates` binding in `fetch`. A live application may also sign
 * its requests with its signature certificate (`signature`, see
 * `./signature.ts`); Ponto requires that for payments, which this adapter
 * does not make, and the sandbox takes them unsigned.
 *
 * Onboarding is OAuth2 authorization code with PKCE, at the sandbox's or the
 * live authorization host (`authorizeUrl`), asking for `ai offline_access`:
 * without `offline_access` Ponto hands out no refresh token and the link
 * would end with its 30-minute access token. Refresh tokens work once, so a
 * refresh is returned in `SyncResult.credentials` (or `pendingCredentials`
 * when the sync fails afterwards) for the caller to store.
 *
 * Ponto synchronizes every account with its bank four times a day by itself.
 * There is no server-side change feed: sync reads each account (its balance,
 * consent end and the outcome of Ponto's latest synchronization), then
 * re-pulls the last 8 days of transactions. "Sync now" (`refresh`) may ask
 * Ponto to synchronize only while the customer is present, which their IP
 * address evidences; it then waits for those synchronizations to finish.
 *
 * Webhooks (`applicationId` set): Ponto tells the receiver when a
 * synchronization brought new data, and connections are polled once a day as
 * a safety net. The link reads the organization id (`/userinfo`), which
 * every webhook names, and indexes the connection by it.
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
  type RequestOptions,
} from '../http';
import {
  accountFingerprint,
  decimalToMinor,
  ibanFingerprint,
  normalizeDate,
  rePullWindow,
} from '../normalize';
import { createIbanityKeyResolver, verifyIbanityWebhook } from '../webhook';
import type {
  BankFeedProvider,
  ConnectionStatus,
  FeedAccount,
  FeedBalance,
  FeedConnection,
  FeedEvent,
  FeedTransaction,
  KeyCache,
  LinkSession,
  LinkSessionInput,
  ProviderCapabilities,
  ProviderSecrets,
  RefreshOptions,
  StoredConnection,
  SyncResult,
} from '../types';
import { importPontoSigningKey, pontoSignatureHeaders, type PontoSignatureConfig, type SignableRequest } from './signature';

export const PONTO_MAX_HISTORY_DAYS = 540;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

/** A live application's authorization page. */
export const PONTO_AUTHORIZE_URL = 'https://authorization.myponto.com/oauth2/auth';
/** A sandbox application's authorization page (`PONTO_ENV=sandbox`). */
export const PONTO_SANDBOX_AUTHORIZE_URL = 'https://sandbox-authorization.myponto.com/oauth2/auth';
/** Account information, and a refresh token so the link outlives its first access token. */
export const PONTO_SCOPE = 'ai offline_access';
/** What "sync now" asks Ponto to fetch from the bank, per account. */
const REFRESH_SUBTYPES = ['accountDetails', 'accountTransactions'] as const;
/** The waits between looks at the synchronizations a refresh started, 15 seconds in all. */
export const PONTO_REFRESH_POLL_MS = [500, 1000, 1500, 2000, 3000, 3000, 4000];
/** Ponto's resource endpoints answer JSON:API. */
const JSON_API = 'application/vnd.api+json';

export interface PontoConfig {
  clientId: string;
  clientSecret: string;
  /** Ponto Connect API. Default Ibanity's host, which needs the mTLS `fetch`. */
  apiUrl?: string;
  /** OAuth2 authorization endpoint. Default the live one, `PONTO_AUTHORIZE_URL`. */
  authorizeUrl?: string;
  /** OAuth2 token endpoint. Default `<apiUrl>/oauth2/token`. */
  tokenUrl?: string;
  /** Default `PONTO_SCOPE`. */
  scope?: string;
  /** Key for deriving PKCE verifiers from the state; defaults to the client secret. */
  stateSecret?: string;
  /** `env.PONTO_CERT.fetch` from a Workers mTLS binding. */
  fetch?: FetchLike;
  /** The signature certificate every request is signed with; unset sends them unsigned. */
  signature?: PontoSignatureConfig;
  /** Waits between polls of a refresh's synchronizations (tests skip them). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * The application's id in Isabel's developer portal (`PONTO_APPLICATION_ID`),
   * the audience of its webhook signatures. Set, Ponto's webhooks are on: the
   * receiver verifies them and connections are polled once a day only.
   */
  applicationId?: string;
  /** Where the webhook verification keys are cached (Workers KV). */
  keyCache?: KeyCache;
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
  // On with an application id (`PontoConfig.applicationId`), which the webhooks' signatures name.
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

/** The accounts a connection reads: the mapped ones, else every account the link brought. */
function accountIdsOf(connection: StoredConnection): string[] {
  return connection.accountIds ?? asArray(connection.metadata.accountIds).filter((v): v is string => typeof v === 'string');
}

/** The earlier of two consent ends (ISO timestamps); either may be missing. */
function earlierEnd(current: string | undefined, next: string | undefined): string | undefined {
  if (!next) return current;
  if (!current) return next;
  return next < current ? next : current;
}

/**
 * One page of transactions (newest first): the ones inside the window, and
 * whether one fell below it, after which the pages that follow are older.
 */
function pageInWindow(
  data: JsonRecord[],
  accountId: string,
  window: { from: string; to: string },
): { inWindow: FeedTransaction[]; olderSeen: boolean } {
  const inWindow: FeedTransaction[] = [];
  let olderSeen = false;
  for (const raw of data) {
    const tx = mapPontoTransaction(raw, accountId);
    if (!tx) continue;
    if (tx.date < window.from) olderSeen = true;
    else if (tx.date <= window.to) inWindow.push(tx);
  }
  return { inWindow, olderSeen };
}

/** A synchronization that is done, well or not. */
function isFinished(synchronization: JsonRecord): boolean {
  const status = asString(asRecord(synchronization.attributes).status);
  return status === 'success' || status === 'error';
}

/**
 * What an account's latest synchronization says about its bank authorization:
 * expired, invalid or revoked at the bank all need the customer in Ponto (a
 * reconnect). A technical failure is Ponto's to retry, so it says nothing.
 */
function authorizationProblem(account: JsonRecord): ConnectionStatus | null {
  const latest = asRecord(asRecord(account.meta).latestSynchronization);
  const codes = asArray(asRecord(latest.attributes).errors).map((e) => asString(asRecord(e).code));
  return codes.some((c) => c === 'authorizationExpired' || c === 'authorizationInvalid' || c === 'authorizationRevoked')
    ? 'reauth_required'
    : null;
}

export class PontoProvider implements BankFeedProvider {
  readonly id = 'ponto';
  readonly capabilities: ProviderCapabilities;
  private readonly apiUrl: string;
  private readonly fetchImpl: FetchLike;
  /** Tokens refreshed during this request, so later calls reuse them. */
  private readonly refreshed = new Map<string, Tokens>();
  /** Accounts a sync read, so the balances that follow need no second call. */
  private readonly details = new Map<string, JsonRecord | null>();
  private signingKey: Promise<CryptoKey> | null = null;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly config: PontoConfig) {
    this.apiUrl = config.apiUrl ?? 'https://api.ibanity.com/ponto-connect';
    this.fetchImpl = config.fetch ?? defaultFetch();
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.capabilities = { ...CAPABILITIES, webhooks: Boolean(config.applicationId) };
  }

  private get basicAuth(): string {
    return `Basic ${btoa(`${this.config.clientId}:${this.config.clientSecret}`)}`;
  }

  /** The `Digest` and `Signature` headers of a request, from the signature certificate. */
  private async sign(signature: PontoSignatureConfig, request: SignableRequest): Promise<Record<string, string>> {
    this.signingKey ??= importPontoSigningKey(signature.privateKey);
    const key = await this.signingKey.catch((err: unknown) => {
      this.signingKey = null;
      throw err;
    });
    return pontoSignatureHeaders(request, signature.certificateId, key, Math.floor(Date.now() / 1000));
  }

  /** One call to Ponto's API, signed when a signature certificate is configured. */
  private request(url: string, options: Pick<RequestOptions, 'method' | 'headers' | 'json' | 'form'>): Promise<JsonRecord> {
    const { signature } = this.config;
    return requestJson(url, {
      ...options,
      provider: 'ponto',
      fetchImpl: this.fetchImpl,
      mapError: mapPontoError,
      sign: signature ? (request) => this.sign(signature, request) : undefined,
    });
  }

  private tokenRequest(form: Array<[string, string]>): Promise<JsonRecord> {
    return this.request(this.config.tokenUrl ?? `${this.apiUrl}/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: this.basicAuth },
      form,
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

  /** Tokens rotated here that no sync result carried away yet. */
  pendingCredentials(providerConnectionId: string): Record<string, unknown> | undefined {
    const tokens = this.refreshed.get(providerConnectionId);
    return tokens ? { ...tokens } : undefined;
  }

  private get(url: string, accessToken: string): Promise<JsonRecord> {
    return this.request(url, { headers: { Accept: JSON_API, Authorization: `Bearer ${accessToken}` } });
  }

  /** One account as Ponto has it; null when it left the integration (removed in Ponto). */
  private async accountDetails(accountId: string, accessToken: string): Promise<JsonRecord | null> {
    try {
      return asRecord((await this.get(`${this.apiUrl}/accounts/${encodeURIComponent(accountId)}`, accessToken)).data);
    } catch (err) {
      if (err instanceof FeedProviderError && err.status === 404) return null;
      throw err;
    }
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
    const url = `${this.config.authorizeUrl ?? PONTO_AUTHORIZE_URL}${queryString([
      ['client_id', this.config.clientId],
      ['redirect_uri', input.redirectUrl],
      ['response_type', 'code'],
      ['scope', this.config.scope ?? PONTO_SCOPE],
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

    // The Ponto organization: every webhook names it, so it routes them to this connection.
    const organizationId = await this.organizationId(tokens.accessToken);
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
    const providerConnectionId = existing?.providerConnectionId ?? crypto.randomUUID();
    return {
      connection: {
        provider: 'ponto',
        providerConnectionId,
        // The connection's own id keeps its due syncs; the organization's routes the webhooks.
        indexKeys: organizationId ? [providerConnectionId, organizationId] : undefined,
        institutionId: null,
        institutionName: 'Ponto',
        status: 'active',
        credentials: { ...tokens },
        cursor: existing?.cursor ?? null,
        consentExpiresAt: earliestExpiry,
        metadata: {
          accountIds: accounts.map((a) => a.providerAccountId),
          ...(organizationId ? { organizationId } : {}),
        },
      },
      accounts,
    };
  }

  /** The organization the token is for (`/userinfo`'s `sub`); null when Ponto does not say, which only costs the webhooks. */
  private async organizationId(accessToken: string): Promise<string | null> {
    try {
      return asString((await this.get(`${this.apiUrl}/userinfo`, accessToken)).sub);
    } catch (err) {
      if (err instanceof FeedProviderError) return null;
      throw err;
    }
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
    const accountStatuses: Record<string, ConnectionStatus> = {};
    let consentExpiresAt: string | undefined;
    for (const accountId of accountIdsOf(connection)) {
      const read = await this.readAccount(accountId, tokens.accessToken, window);
      upserts.push(...read.upserts);
      if (read.status) accountStatuses[accountId] = read.status;
      consentExpiresAt = earlierEnd(consentExpiresAt, read.consentExpiresAt);
    }

    return {
      upserts,
      removals: [],
      nextCursor: { through: window.to } satisfies PontoCursor,
      hasMore: false,
      accountStatuses,
      credentials: changed ? { ...tokens } : undefined,
      ...(consentExpiresAt ? { consentExpiresAt } : {}),
    };
  }

  /**
   * One account: first whether Ponto can still reach the bank for it, and
   * until when (its details, kept for the balances), then its transactions in
   * the window. An account taken out of the integration in Ponto needs a
   * reconnect to add it back.
   */
  private async readAccount(
    accountId: string,
    accessToken: string,
    window: { from: string; to: string },
  ): Promise<{ upserts: FeedTransaction[]; status: ConnectionStatus | null; consentExpiresAt?: string }> {
    const details = await this.accountDetails(accountId, accessToken);
    this.details.set(accountId, details);
    if (!details) return { upserts: [], status: 'reauth_required' };
    return {
      upserts: await this.windowTransactions(accountId, accessToken, window),
      status: authorizationProblem(details),
      consentExpiresAt: asString(asRecord(details.attributes).authorizationExpirationExpectedAt) ?? undefined,
    };
  }

  /** The account's transactions in the window, page by page until a page dips below it. */
  private async windowTransactions(accountId: string, accessToken: string, window: { from: string; to: string }): Promise<FeedTransaction[]> {
    const upserts: FeedTransaction[] = [];
    let url: string | null = `${this.apiUrl}/accounts/${encodeURIComponent(accountId)}/transactions${queryString([['page[limit]', String(PAGE_SIZE)]])}`;
    let reachedWindowStart = false;
    for (let page = 0; page < MAX_PAGES && url && !reachedWindowStart; page += 1) {
      const response = await this.get(url, accessToken);
      const data = asArray(response.data).map(asRecord);
      const { inWindow, olderSeen } = pageInWindow(data, accountId, window);
      upserts.push(...inWindow);
      reachedWindowStart = olderSeen;
      url = data.length === 0 ? null : asString(asRecord(response.links).next);
    }
    return upserts;
  }

  async getBalances(connection: StoredConnection): Promise<FeedBalance[]> {
    const balances: FeedBalance[] = [];
    for (const accountId of accountIdsOf(connection)) {
      // The sync just read the account; otherwise ask for it.
      let raw = this.details.get(accountId);
      this.details.delete(accountId);
      if (raw === undefined) raw = await this.accountDetails(accountId, (await this.ensureTokens(connection)).tokens.accessToken);
      const balance = raw ? pontoBalance(raw) : null;
      if (balance) balances.push(balance);
    }
    return balances;
  }

  /**
   * "Sync now": ask Ponto to fetch the balance and transactions from the bank
   * and wait for it, so the read that follows has them. Ponto allows this only
   * with the customer present (their IP address), at most every five minutes
   * and 50 times a day per account; without the address nothing is asked.
   */
  async refresh(connection: StoredConnection, options: RefreshOptions = {}): Promise<void> {
    const customerIp = options.customerIp?.trim();
    if (!customerIp) return;
    const { tokens } = await this.ensureTokens(connection);
    const started: string[] = [];
    let refused: FeedProviderError | null = null;
    for (const accountId of accountIdsOf(connection)) {
      for (const subtype of REFRESH_SUBTYPES) {
        const outcome = await this.startSynchronization(accountId, subtype, tokens.accessToken, customerIp);
        if (outcome instanceof FeedProviderError) refused ??= outcome;
        else if (outcome) started.push(outcome);
      }
    }
    await this.waitForSynchronizations(started, tokens.accessToken);
    if (started.length === 0 && refused) throw refused;
  }

  /**
   * Ask Ponto for one synchronization: its id while it runs, null when it is
   * already done, or Ponto's refusal (too soon after the last one, the day's
   * limit), after which the read takes what Ponto has. A lapsed or revoked
   * authorization stops the refresh.
   */
  private async startSynchronization(
    accountId: string,
    subtype: string,
    accessToken: string,
    customerIp: string,
  ): Promise<string | null | FeedProviderError> {
    try {
      const response = await this.request(`${this.apiUrl}/synchronizations`, {
        method: 'POST',
        headers: { Accept: JSON_API, Authorization: `Bearer ${accessToken}`, 'Content-Type': JSON_API },
        json: {
          data: {
            type: 'synchronization',
            attributes: { resourceType: 'account', resourceId: accountId, subtype, customerIpAddress: customerIp },
          },
        },
      });
      const synchronization = asRecord(response.data);
      const id = asString(synchronization.id);
      return id && !isFinished(synchronization) ? id : null;
    } catch (err) {
      if (!(err instanceof FeedProviderError) || err.kind === 'reauth_required' || err.kind === 'revoked') throw err;
      return err;
    }
  }

  /** Poll the synchronizations until each is done, for 15 seconds at most. */
  private async waitForSynchronizations(ids: string[], accessToken: string): Promise<void> {
    let pending = ids;
    for (const wait of PONTO_REFRESH_POLL_MS) {
      if (pending.length === 0) return;
      await this.sleep(wait);
      const still: string[] = [];
      for (const id of pending) {
        const response = await this.get(`${this.apiUrl}/synchronizations/${encodeURIComponent(id)}`, accessToken);
        if (!isFinished(asRecord(response.data))) still.push(id);
      }
      pending = still;
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
      await this.request(this.config.tokenUrl ? this.config.tokenUrl.replace(/token$/, 'revoke') : `${this.apiUrl}/oauth2/revoke`, {
        method: 'POST',
        headers: { Authorization: this.basicAuth },
        form: [['token', tokens.refreshToken]],
      });
    } catch (err) {
      // Already revoked.
      if (err instanceof FeedProviderError && (err.kind === 'reauth_required' || err.kind === 'revoked' || err.kind === 'permanent')) return;
      throw err;
    }
  }

  /**
   * A Ponto Connect webhook: verified (Ibanity's RS512 `Signature` JWT, its
   * key fetched with the application's certificate), then turned into feed
   * events keyed by the Ponto organization.
   */
  async parseWebhook(request: Request, secrets: ProviderSecrets): Promise<FeedEvent[]> {
    const { applicationId } = this.config;
    if (!applicationId) throw new WebhookVerificationError('Ponto webhooks are not enabled; connections are polled');
    const body = await request.text();
    await verifyIbanityWebhook({
      body,
      header: request.headers.get('Signature'),
      applicationId,
      getKey: createIbanityKeyResolver({ applicationId, cache: secrets.keyCache ?? this.config.keyCache, fetchImpl: this.fetchImpl }),
      now: secrets.now,
    });

    let payload: JsonRecord;
    try {
      payload = asRecord(JSON.parse(body));
    } catch {
      return [];
    }
    return pontoEventsFromWebhook(payload);
  }
}

/**
 * A Ponto Connect webhook body (`{ data: { type, relationships } }`) to feed
 * events, keyed by the organization (`providerConnectionId`). New or changed
 * data, a reauthorization, a lifted block and a failed synchronization (the
 * sync reads why) ask for a sync; an account taken out of the integration
 * asks for a reconnect; a revoked integration ends the access. The rest
 * (pending lines, unchanged synchronizations, payments) maps to nothing.
 */
export function pontoEventsFromWebhook(payload: JsonRecord): FeedEvent[] {
  const data = asRecord(payload.data);
  const type = asString(data.type);
  const relationships = asRecord(data.relationships);
  const organizationId = asString(asRecord(asRecord(relationships.organization).data).id);
  const accountId = asString(asRecord(asRecord(relationships.account).data).id);
  if (!type || !organizationId) return [];
  const event = (kind: FeedEvent['type'], message?: string): FeedEvent[] => [
    {
      type: kind,
      providerConnectionId: organizationId,
      ...(accountId ? { accountIds: [accountId] } : {}),
      ...(message ? { message } : {}),
    },
  ];
  switch (type) {
    case 'pontoConnect.account.transactionsCreated':
    case 'pontoConnect.account.transactionsUpdated':
    case 'pontoConnect.account.detailsUpdated':
    case 'pontoConnect.account.reauthorized':
    case 'pontoConnect.synchronization.failed':
    case 'pontoConnect.organization.unblocked':
      return event('sync_available');
    case 'pontoConnect.integration.accountRevoked':
      return event('reauth_required', 'The account was taken out of the Ponto integration.');
    case 'pontoConnect.integration.revoked':
      return event('revoked', 'The Ponto integration was revoked.');
    case 'pontoConnect.organization.blocked':
      return event('error', "Ponto blocked the organization; Isabel's service desk can say why.");
    default:
      return [];
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
    // When Ponto last synchronized the account (`meta`; read from the attributes too, where older answers had it).
    asOf: asString(asRecord(raw.meta).synchronizedAt) ?? asString(attributes.synchronizedAt) ?? new Date().toISOString(),
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

