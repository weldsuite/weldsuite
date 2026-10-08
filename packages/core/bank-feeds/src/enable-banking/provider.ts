/**
 * Enable Banking adapter, Europe (PSD2 AISP covering the EEA, Nordics, UK).
 *
 * NOT LIVE-TESTED. Written from Enable Banking's documented flow
 * (https://enablebanking.com/docs/api/quick-start) and covered by hand-written
 * fixtures only; verify against the sandbox's mock ASPSPs before relying on it.
 *
 * The app authenticates every call with an RS256 JWT signed with its private
 * key (WebCrypto, so it runs on Workers). The user picks a bank up front
 * (`institution`), is redirected to it (`POST /auth`), and comes back with a
 * code that `POST /sessions` turns into a session with its accounts. There is no
 * change feed and no AIS webhook: sync is date-range polling that re-pulls the
 * last 8 days, within PSD2's four unattended pulls a day per account. The
 * consent lapses after at most 180 days (`access.valid_until`) and the user
 * must go through the bank again.
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
  sha256Hex,
} from '../normalize';
import type {
  BankFeedProvider,
  FeedAccount,
  FeedAccountType,
  FeedBalance,
  FeedConnection,
  FeedEvent,
  FeedInstitution,
  FeedTransaction,
  LinkSession,
  LinkSessionInput,
  ProviderCapabilities,
  ProviderSecrets,
  StoredConnection,
  SyncResult,
} from '../types';

export const ENABLE_BANKING_MAX_HISTORY_DAYS = 730;
const MAX_CONSENT_DAYS = 180;
const FALLBACK_CONSENT_DAYS = 90;
const MAX_PAGES = 100;

export interface EnableBankingConfig {
  /** Application id (`kid` of the JWT). */
  appId: string;
  /** PKCS#8 PEM private key of the application (`-----BEGIN PRIVATE KEY-----`). `\n` escapes are accepted. */
  privateKey: string;
  apiUrl?: string;
  fetch?: FetchLike;
}

export interface EnableBankingCompletePayload {
  /** The `code` the redirect carried. */
  code: string;
  state?: string;
  connection?: StoredConnection;
}

const CAPABILITIES: ProviderCapabilities = {
  regions: [
    'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IS', 'IE', 'IT', 'LV',
    'LI', 'LT', 'LU', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'GB',
  ],
  changeCursor: false,
  webhooks: false,
  pendingTransactions: false,
  maxHistoryDays: ENABLE_BANKING_MAX_HISTORY_DAYS,
  onDemandRefresh: false,
  consentTtlDays: MAX_CONSENT_DAYS,
  accountTypes: ['depository', 'credit'],
};

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----(BEGIN|END)[^-]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(body);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function mapEnableBankingError(status: number, body: JsonRecord): FeedProviderError | null {
  const message = asString(body.message) ?? asString(body.error) ?? '';
  const code = asString(body.error) ?? asString(body.code);
  const text = `Enable Banking${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`;
  const extra = { status, code: code ?? undefined };
  // A dead consent or closed session: the user has to go through the bank again.
  if (/session|consent|expired|closed|revoked/i.test(`${code ?? ''} ${message}`) && (status === 401 || status === 403 || status === 422)) {
    return new FeedProviderError('enable_banking', 'reauth_required', text, extra);
  }
  if (status === 401 || status === 403) return new FeedProviderError('enable_banking', 'auth', text, extra);
  return null;
}

function accountTypeOf(cashAccountType: string | null): FeedAccountType {
  return cashAccountType === 'CARD' ? 'credit' : 'depository';
}

function subtypeOf(cashAccountType: string | null): string {
  switch (cashAccountType) {
    case 'SVGS':
      return 'savings';
    case 'CARD':
      return 'credit_card';
    default:
      return 'checking';
  }
}

export class EnableBankingProvider implements BankFeedProvider {
  readonly id = 'enable_banking';
  readonly capabilities = CAPABILITIES;
  private readonly apiUrl: string;
  private readonly fetchImpl: FetchLike;
  private signingKey: Promise<CryptoKey> | null = null;

  constructor(private readonly config: EnableBankingConfig) {
    this.apiUrl = config.apiUrl ?? 'https://api.enablebanking.com';
    this.fetchImpl = config.fetch ?? defaultFetch();
  }

  /** Application JWT: RS256, valid for an hour, `kid` = application id. */
  private async appJwt(): Promise<string> {
    this.signingKey ??= crypto.subtle.importKey(
      'pkcs8',
      pemToDer(this.config.privateKey),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const iat = Math.floor(Date.now() / 1000);
    const header = toBase64Url(utf8(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: this.config.appId })));
    const claims = toBase64Url(utf8(JSON.stringify({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat, exp: iat + 3600 })));
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await this.signingKey, utf8(`${header}.${claims}`));
    return `${header}.${claims}.${toBase64Url(new Uint8Array(signature))}`;
  }

  private async call(method: string, path: string, options: { query?: Array<[string, string]>; json?: unknown } = {}): Promise<JsonRecord> {
    return requestJson(`${this.apiUrl}${path}${queryString(options.query ?? [])}`, {
      provider: 'enable_banking',
      fetchImpl: this.fetchImpl,
      method,
      headers: { Authorization: `Bearer ${await this.appJwt()}` },
      json: options.json,
      mapError: mapEnableBankingError,
    });
  }

  async listInstitutions(country: string): Promise<FeedInstitution[]> {
    const response = await this.call('GET', '/aspsps', { query: [['country', country.toUpperCase()]] });
    return asArray(response.aspsps)
      .map(asRecord)
      .flatMap((aspsp) => {
        const name = asString(aspsp.name);
        if (!name) return [];
        return [{ id: name, name, country: asString(aspsp.country) ?? country.toUpperCase(), logoUrl: asString(aspsp.logo) }];
      });
  }

  /** How long the consent may last at this bank (seconds), from the ASPSP list. */
  private async consentDays(institution: { name: string; country: string }): Promise<number> {
    try {
      const response = await this.call('GET', '/aspsps', { query: [['country', institution.country.toUpperCase()]] });
      const match = asArray(response.aspsps)
        .map(asRecord)
        .find((a) => asString(a.name)?.toLowerCase() === institution.name.toLowerCase());
      const seconds = asNumber(match?.maximum_consent_validity);
      if (seconds && seconds > 0) return Math.max(1, Math.min(MAX_CONSENT_DAYS, Math.floor(seconds / 86_400)));
    } catch {
      // fall back below
    }
    return FALLBACK_CONSENT_DAYS;
  }

  async createLinkSession(input: LinkSessionInput): Promise<LinkSession> {
    if (!input.institution) {
      throw new FeedProviderError('enable_banking', 'permanent', 'Enable Banking needs the bank chosen up front');
    }
    const days = await this.consentDays(input.institution);
    const response = await this.call('POST', '/auth', {
      json: {
        access: { valid_until: new Date(Date.now() + days * 86_400_000).toISOString() },
        aspsp: { name: input.institution.name, country: input.institution.country.toUpperCase() },
        state: toBase64Url(crypto.getRandomValues(new Uint8Array(24))),
        redirect_url: input.redirectUrl,
        psu_type: input.psuType ?? 'business',
      },
    });
    const url = asString(response.url);
    if (!url) throw new FeedProviderError('enable_banking', 'permanent', 'Enable Banking returned no authorization URL');
    return { kind: 'redirect', url, sessionId: asString(response.authorization_id) ?? undefined };
  }

  async completeLink(payload: unknown): Promise<{ connection: FeedConnection; accounts: FeedAccount[] }> {
    const input = asRecord(payload) as unknown as EnableBankingCompletePayload;
    const code = asString(input.code);
    if (!code) throw new FeedProviderError('enable_banking', 'permanent', 'Enable Banking authorization code missing');

    const session = await this.call('POST', '/sessions', { json: { code } });
    const sessionId = asString(session.session_id);
    if (!sessionId) throw new FeedProviderError('enable_banking', 'permanent', 'Enable Banking returned no session');
    const aspsp = asRecord(session.aspsp);
    const institutionName = asString(aspsp.name);

    const accounts: FeedAccount[] = [];
    for (const raw of asArray(session.accounts).map(asRecord)) {
      const mapped = await mapAccount(raw, institutionName);
      if (mapped) accounts.push(mapped);
    }

    return {
      connection: {
        provider: 'enable_banking',
        providerConnectionId: sessionId,
        institutionId: institutionName,
        institutionName,
        status: 'active',
        credentials: { sessionId },
        cursor: input.connection?.cursor ?? null,
        consentExpiresAt: asString(asRecord(session.access).valid_until),
        metadata: { accountIds: accounts.map((a) => a.providerAccountId), country: asString(aspsp.country) },
      },
      accounts,
    };
  }

  private accountIdsOf(connection: StoredConnection): string[] {
    return connection.accountIds ?? asArray(connection.metadata.accountIds).filter((v): v is string => typeof v === 'string');
  }

  async syncTransactions(connection: StoredConnection, cursor: unknown): Promise<SyncResult> {
    const today = new Date().toISOString().slice(0, 10);
    const window = rePullWindow({
      lastThrough: asString(asRecord(cursor).through),
      today,
      historyDays: Math.min(connection.historyDays ?? ENABLE_BANKING_MAX_HISTORY_DAYS, ENABLE_BANKING_MAX_HISTORY_DAYS),
    });

    const upserts: FeedTransaction[] = [];
    for (const uid of this.accountIdsOf(connection)) {
      let continuationKey: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const query: Array<[string, string]> = [
          ['date_from', window.from],
          ['date_to', window.to],
          ['transaction_status', 'BOOK'],
          ['strategy', 'longest'],
        ];
        if (continuationKey) query.push(['continuation_key', continuationKey]);
        const response = await this.call('GET', `/accounts/${encodeURIComponent(uid)}/transactions`, { query });
        const occurrences = new Map<string, number>();
        for (const raw of asArray(response.transactions).map(asRecord)) {
          const mapped = await mapEnableBankingTransaction(raw, uid, occurrences);
          if (mapped) upserts.push(mapped);
        }
        continuationKey = asString(response.continuation_key);
        if (!continuationKey) break;
      }
    }

    return { upserts, removals: [], nextCursor: { through: window.to }, hasMore: false };
  }

  async getBalances(connection: StoredConnection): Promise<FeedBalance[]> {
    const balances: FeedBalance[] = [];
    for (const uid of this.accountIdsOf(connection)) {
      const response = await this.call('GET', `/accounts/${encodeURIComponent(uid)}/balances`);
      const entries = asArray(response.balances).map(asRecord);
      // Closing booked, then interim booked, then expected.
      const preferred = ['CLBD', 'ITBD', 'XPCD', 'OPBD']
        .map((type) => entries.find((e) => asString(e.balance_type) === type))
        .find((e) => e !== undefined);
      const entry = preferred ?? entries[0];
      if (!entry) continue;
      const amount = asRecord(entry.balance_amount);
      const value = asNumber(amount.amount);
      if (value === null) continue;
      const currency = (asString(amount.currency) ?? 'EUR').toUpperCase();
      const minor = decimalToMinor(value, currency);
      const debit = asString(entry.credit_debit_indicator) === 'DBIT';
      balances.push({
        accountId: uid,
        current: debit ? (minor === 0 ? 0 : -Math.abs(minor)) : minor,
        available: null,
        limit: null,
        currency,
        asOf: asString(entry.reference_date) ? `${asString(entry.reference_date)}T00:00:00.000Z` : new Date().toISOString(),
      });
    }
    return balances;
  }

  async disconnect(connection: StoredConnection): Promise<void> {
    const sessionId = asString(connection.credentials.sessionId) ?? connection.providerConnectionId;
    try {
      await this.call('DELETE', `/sessions/${encodeURIComponent(sessionId)}`);
    } catch (err) {
      // Session already closed or expired.
      if (err instanceof FeedProviderError && (err.kind === 'reauth_required' || err.kind === 'permanent')) return;
      throw err;
    }
  }

  async parseWebhook(_request: Request, _secrets: ProviderSecrets): Promise<FeedEvent[]> {
    throw new WebhookVerificationError('Enable Banking has no account-information webhooks; connections are polled');
  }
}

async function mapAccount(raw: JsonRecord, institutionName: string | null): Promise<FeedAccount | null> {
  const uid = asString(raw.uid);
  if (!uid) return null;
  const iban = asString(asRecord(raw.account_id).iban);
  const cashType = asString(raw.cash_account_type);
  const subtype = subtypeOf(cashType);
  const identification = asString(raw.identification_hash);
  return {
    providerAccountId: uid,
    name: asString(raw.name) ?? asString(raw.details) ?? iban ?? 'Account',
    mask: iban ? iban.slice(-4) : null,
    iban,
    type: accountTypeOf(cashType),
    subtype,
    currency: (asString(raw.currency) ?? 'EUR').toUpperCase(),
    institutionId: institutionName,
    institutionName,
    fingerprint: iban
      ? await ibanFingerprint(iban)
      : identification
        ? await sha256Hex(`acct-eb|${identification}`)
        : await accountFingerprint(institutionName, null, subtype),
  };
}

/** Enable Banking amounts are positive; `credit_debit_indicator` carries the direction. */
export async function mapEnableBankingTransaction(
  raw: JsonRecord,
  accountUid: string,
  occurrences: Map<string, number>,
): Promise<FeedTransaction | null> {
  const amountRecord = asRecord(raw.transaction_amount);
  const value = asNumber(amountRecord.amount);
  const when = asString(raw.booking_date) ?? asString(raw.value_date) ?? asString(raw.transaction_date);
  if (value === null || !when) return null;
  const currency = (asString(amountRecord.currency) ?? 'EUR').toUpperCase();
  const minor = decimalToMinor(Math.abs(value), currency);
  const debit = asString(raw.credit_debit_indicator) === 'DBIT';
  const amountMinor = debit ? (minor === 0 ? 0 : -minor) : minor;

  const remittance = asArray(raw.remittance_information).map(asString).filter((v): v is string => v !== null).join(' ');
  const counterparty = asString(asRecord(debit ? raw.creditor : raw.debtor).name);
  const description = remittance || asString(raw.note) || counterparty || '';
  const date = normalizeDate(when);

  let providerTransactionId = asString(raw.entry_reference) ?? asString(raw.transaction_id);
  if (!providerTransactionId) {
    // Some banks give no stable id: derive one from the line, numbering identical twins.
    const key = `${date}|${amountMinor}|${description}`;
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    providerTransactionId = `eb_${(await sha256Hex(`${accountUid}|${key}|${occurrence}`)).slice(0, 40)}`;
  }

  return {
    providerTransactionId,
    pendingTransactionId: null,
    accountId: accountUid,
    date,
    amountMinor,
    currency,
    description,
    merchantName: counterparty,
    checkNumber: null,
    category: null,
    pending: asString(raw.status) === 'PDNG',
    raw,
  };
}

export function createEnableBankingProvider(config: EnableBankingConfig): EnableBankingProvider {
  return new EnableBankingProvider(config);
}
