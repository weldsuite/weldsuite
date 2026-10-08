/**
 * WeldBooks bank feeds client: link a bank through an aggregator (Plaid,
 * Stripe Financial Connections, Ponto, Enable Banking), map its accounts to
 * WeldBooks bank accounts, sync, disconnect. Talks to books-api through the
 * same `weldbooksApi` transport as `accountingApi`; shapes mirror
 * `apps/workers/books-api/src/routes/bank-connections` and
 * `services/bank-feeds/{types,connections,sync}.ts`.
 *
 * Responses never carry provider tokens or full account numbers.
 */
import { weldbooksApi } from '../weldbooks-client';

// ============================================================================
// Shapes
// ============================================================================

export type BankFeedConnectionStatus =
  | 'active'
  | 'reauth_required'
  | 'expiring'
  | 'revoked'
  | 'disconnected'
  | 'error';

export type BankFeedAccountType = 'depository' | 'credit' | 'loan';

/** How the client starts a link: Plaid Link, Stripe.js, or a redirect to the bank. */
export type BankFeedLinkKind = 'plaid_link' | 'stripe_fc' | 'redirect';

export type BankFeedLinkMode = 'create' | 'reauth' | 'add_accounts';

/** The WeldBooks bank account types a feed account can be created as. */
export const BANK_FEED_ACCOUNT_TYPES = [
  'checking',
  'savings',
  'credit_card',
  'money_market',
  'line_of_credit',
] as const;
export type BankFeedBankAccountType = (typeof BANK_FEED_ACCOUNT_TYPES)[number];

export interface BankFeedCapabilities {
  regions: string[];
  changeCursor: boolean;
  webhooks: boolean;
  pendingTransactions: boolean;
  /** How far back the first sync can reach: Plaid 730 days, Stripe Financial Connections 180. */
  maxHistoryDays: number;
  onDemandRefresh: boolean;
  consentTtlDays?: number;
  accountTypes: BankFeedAccountType[];
}

export interface BankFeedMappingSuggestion {
  bankAccountId: string;
  bankAccountName: string;
  reason: 'fingerprint' | 'iban' | 'last4' | 'name';
}

export interface BankFeedAccount {
  feedAccountId: string;
  name: string;
  mask: string | null;
  type: BankFeedAccountType;
  subtype: string | null;
  currency: string;
  status: BankFeedConnectionStatus;
  bankAccountId: string | null;
  bankAccountName: string | null;
  /** `YYYY-MM-DD`: feed transactions before this date are skipped. */
  syncFrom: string | null;
  /** Only on a fresh link, for accounts not yet mapped. */
  suggestion?: BankFeedMappingSuggestion | null;
}

export interface BankFeedWarning {
  at: string;
  code: string;
  message: string;
  providerTransactionId?: string;
  bankTransactionId?: string;
}

export interface BankFeedConnection {
  id: string;
  entityId: string;
  provider: string;
  institutionId: string | null;
  institutionName: string | null;
  status: BankFeedConnectionStatus;
  lastSyncedAt: string | null;
  lastError: string | null;
  consentExpiresAt: string | null;
  historyDays: number | null;
  createdAt: string;
  /** Null when the provider is no longer configured. */
  capabilities: BankFeedCapabilities | null;
  accounts: BankFeedAccount[];
  warnings: BankFeedWarning[];
}

export interface BankFeedProviderOption {
  id: string;
  kind: BankFeedLinkKind;
  /** The bank is chosen in WeldBooks before the redirect (Enable Banking). */
  requiresInstitution: boolean;
  capabilities: BankFeedCapabilities;
}

export interface BankFeedProviders {
  country: string;
  providers: BankFeedProviderOption[];
}

export interface BankFeedInstitution {
  id: string;
  name: string;
  country: string;
  logoUrl?: string | null;
}

export interface BankFeedLinkSessionInput {
  provider: string;
  mode?: BankFeedLinkMode;
  connectionId?: string;
  /** Where the bank sends the browser back to (OAuth / redirect flows). */
  redirectUrl: string;
  institution?: { id?: string; name: string; country: string };
  psuType?: 'business' | 'personal';
}

export interface BankFeedLinkSession {
  provider: string;
  kind: BankFeedLinkKind;
  /** Plaid Link token. */
  token?: string;
  /** Stripe.js client secret. */
  clientSecret?: string;
  /** Redirect providers: where to send the browser. */
  url?: string;
  sessionId?: string;
  expiresAt?: string | null;
  historyDays: number;
}

/** What a launcher hands back: Plaid `{ publicToken, institution }`, Stripe `{ sessionId }`, redirect `{ code, state, redirectUrl }`. */
export type BankFeedCompletePayload = Record<string, unknown>;

export interface BankFeedCompleteInput {
  provider: string;
  payload: BankFeedCompletePayload;
  connectionId?: string;
}

export interface BankFeedCompleteResult {
  connection: BankFeedConnection;
  /** The connection's accounts, with a suggested bank account for those not yet mapped. */
  accounts: BankFeedAccount[];
}

export interface BankFeedAccountMapping {
  feedAccountId: string;
  /** Link to an existing WeldBooks bank account... */
  bankAccountId?: string;
  /** ...or create one. */
  create?: { name: string; accountType?: BankFeedBankAccountType; ledgerAccountId?: string };
  /** `YYYY-MM-DD`; null imports as far back as the provider allows. */
  syncFrom?: string | null;
}

export interface BankFeedMapAccountsInput {
  mappings: BankFeedAccountMapping[];
  syncFrom?: string | null;
  /** Start the first sync right away (default true). */
  sync?: boolean;
}

export interface BankFeedMapAccountsResult {
  connection: BankFeedConnection;
  mapped: Array<{ feedAccountId: string; bankAccountId: string; created: boolean }>;
  syncStarted: boolean;
}

export interface BankFeedSyncOutcome {
  connectionId: string;
  status: BankFeedConnectionStatus;
  skipped?: 'not_found' | 'not_active' | 'in_progress' | 'no_mapped_accounts';
  added: number;
  updated: number;
  removed: number;
  pending: number;
  pendingVoided: number;
  possibleDuplicates: number;
  autoReconciled: number;
  warnings: number;
  /** A sync that hit a provider error still answers 200: the error is here. */
  error?: string;
  retryable?: boolean;
}

export interface BankFeedSyncResult {
  outcome: BankFeedSyncOutcome;
  connection: BankFeedConnection;
}

export interface BankFeedPendingTransaction {
  id: string;
  bankAccountId: string;
  date: string;
  /** Signed decimal string, statement convention: money in positive, money out negative. */
  amount: string;
  currency: string;
  description: string | null;
  merchantName: string | null;
}

// ============================================================================
// Errors
// ============================================================================

/** The part of the `weldbooksApi` error the feed screens read (the class itself is not exported). */
export interface BankFeedRequestError extends Error {
  status: number;
  code: string | null;
}

export function isBankFeedRequestError(err: unknown): err is BankFeedRequestError {
  return err instanceof Error && typeof (err as { status?: unknown }).status === 'number';
}

// ============================================================================
// Client
// ============================================================================

interface Envelope<T> {
  data: T;
}

function query(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) qs.set(key, value);
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
}

const base = '/bank-connections';

export const bankFeedsApi = {
  async listConnections(): Promise<BankFeedConnection[]> {
    const res = await weldbooksApi.get<Envelope<BankFeedConnection[]>>(base);
    return res.data ?? [];
  },

  async getConnection(id: string): Promise<BankFeedConnection> {
    const res = await weldbooksApi.get<Envelope<BankFeedConnection>>(`${base}/${id}`);
    return res.data;
  },

  /** Providers the entity's country can use; only configured ones are listed. */
  async listProviders(country?: string): Promise<BankFeedProviders> {
    const res = await weldbooksApi.get<Envelope<BankFeedProviders>>(`${base}/providers${query({ country })}`);
    return res.data;
  },

  async listInstitutions(provider: string, country: string): Promise<BankFeedInstitution[]> {
    const res = await weldbooksApi.get<Envelope<BankFeedInstitution[]>>(
      `${base}/institutions${query({ provider, country })}`,
    );
    return res.data ?? [];
  },

  async createLinkSession(input: BankFeedLinkSessionInput): Promise<BankFeedLinkSession> {
    const res = await weldbooksApi.post<Envelope<BankFeedLinkSession>>(`${base}/link-session`, input);
    return res.data;
  },

  async completeLink(input: BankFeedCompleteInput): Promise<BankFeedCompleteResult> {
    const res = await weldbooksApi.post<Envelope<BankFeedCompleteResult>>(`${base}/complete`, input);
    return res.data;
  },

  async mapAccounts(id: string, input: BankFeedMapAccountsInput): Promise<BankFeedMapAccountsResult> {
    const res = await weldbooksApi.post<Envelope<BankFeedMapAccountsResult>>(`${base}/${id}/map-accounts`, input);
    return res.data;
  },

  async syncConnection(id: string, options: { refresh?: boolean } = {}): Promise<BankFeedSyncResult> {
    const res = await weldbooksApi.post<Envelope<BankFeedSyncResult>>(`${base}/${id}/sync`, {
      refresh: options.refresh === true,
    });
    return res.data;
  },

  async disconnectConnection(id: string): Promise<BankFeedConnection> {
    const res = await weldbooksApi.post<Envelope<BankFeedConnection>>(`${base}/${id}/disconnect`);
    return res.data;
  },

  /** Disconnect and remove: bank accounts keep every synced transaction. */
  async deleteConnection(id: string): Promise<void> {
    await weldbooksApi.delete<void>(`${base}/${id}`);
  },

  async listPendingTransactions(id: string, bankAccountId?: string): Promise<BankFeedPendingTransaction[]> {
    const res = await weldbooksApi.get<Envelope<BankFeedPendingTransaction[]>>(
      `${base}/${id}/pending${query({ bankAccountId })}`,
    );
    return res.data ?? [];
  },
};
