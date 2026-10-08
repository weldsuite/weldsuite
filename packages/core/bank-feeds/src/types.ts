/**
 * Provider-neutral bank-feed model (docs/plans/weldbooks-us.md section 9).
 *
 * Every adapter turns its aggregator's quirks into these shapes so WeldBooks
 * never sees them:
 *  - amounts are integers in minor units, signed like a bank statement (money
 *    in positive, money out negative; a card purchase is negative);
 *  - dates are calendar dates (`YYYY-MM-DD`) without time-zone conversion;
 *  - pending transactions are flagged, never mixed into posted ones;
 *  - connection status is one enum, rolled up from per-account statuses.
 */

export type FeedProviderId = 'plaid' | 'stripe_fc' | 'teller' | 'ponto' | 'enable_banking';

export type ConnectionStatus =
  | 'active'
  | 'reauth_required'
  | 'expiring'
  | 'revoked'
  | 'disconnected'
  | 'error';

export type FeedAccountType = 'depository' | 'credit' | 'loan';

export type LinkMode = 'create' | 'reauth' | 'add_accounts';

export interface ProviderCapabilities {
  /** ISO 3166-1 alpha-2 countries the provider can link banks in. */
  regions: string[];
  /** true: server-side change feed (Plaid, Stripe FC refresh watermark); false: date-range polling. */
  changeCursor: boolean;
  webhooks: boolean;
  pendingTransactions: boolean;
  /** How far back the first sync can reach. */
  maxHistoryDays: number;
  onDemandRefresh: boolean;
  /** PSD2: 180 (90 at some banks). */
  consentTtlDays?: number;
  accountTypes: FeedAccountType[];
}

/** An account as the provider reports it, already normalized. */
export interface FeedAccount {
  providerAccountId: string;
  name: string;
  /** Last four digits (or the provider's mask) when known. */
  mask: string | null;
  /** IBAN where the bank has one (Europe); the best key to match an existing WeldBooks bank account. */
  iban?: string | null;
  type: FeedAccountType;
  /** checking | savings | money_market | credit_card | line_of_credit | mortgage | ... (snake_case) */
  subtype: string | null;
  currency: string;
  institutionId: string | null;
  institutionName: string | null;
  /** institution + mask + subtype (or the provider's persistent id), so a relink or a provider switch reattaches. */
  fingerprint: string;
  /** Per-account status where the provider tracks it (Stripe FC). */
  status?: ConnectionStatus;
  /** Balance returned together with the account, when the provider does. */
  balance?: FeedBalance | null;
}

export interface FeedConnection {
  provider: string;
  /** Plaid item id, Stripe FC session id, Ponto organisation, Enable Banking session id. */
  providerConnectionId: string;
  /**
   * Provider-side ids under which webhooks arrive for this connection. Defaults
   * to `[providerConnectionId]`; Stripe FC sends events per account, so it lists
   * its account ids.
   */
  indexKeys?: string[];
  institutionId: string | null;
  institutionName: string | null;
  status: ConnectionStatus;
  /** Secrets (access tokens). The caller encrypts them; they never leave the worker. */
  credentials: Record<string, unknown>;
  /** Initial sync cursor (usually null). */
  cursor: unknown;
  /** ISO timestamp; PSD2 consents expire. */
  consentExpiresAt?: string | null;
  /** Non-secret provider state (ids needed later). */
  metadata?: Record<string, unknown>;
}

/** A connection as stored by the caller, with its credentials decrypted. */
export interface StoredConnection {
  provider: string;
  providerConnectionId: string;
  credentials: Record<string, unknown>;
  cursor: unknown;
  metadata: Record<string, unknown>;
  historyDays?: number | null;
  /**
   * Provider account ids the caller wants synced (the ones mapped to a
   * WeldBooks bank account). Account-level providers fetch only these.
   */
  accountIds?: string[];
}

export interface FeedTransaction {
  providerTransactionId: string;
  /** Plaid: the pending transaction this posted one replaces. */
  pendingTransactionId?: string | null;
  accountId: string;
  /** YYYY-MM-DD */
  date: string;
  /** Signed integer in minor units, statement convention. */
  amountMinor: number;
  currency: string;
  description: string;
  merchantName?: string | null;
  checkNumber?: string | null;
  category?: Record<string, unknown> | null;
  pending: boolean;
  raw: Record<string, unknown>;
}

export interface FeedBalance {
  accountId: string;
  /** Minor units, statement convention: a credit card's owed amount is negative. */
  current: number;
  /** Available funds, or available credit on a card (never negated). */
  available?: number | null;
  /** Credit limit, minor units. */
  limit?: number | null;
  currency: string;
  /** ISO timestamp the provider took the balance. */
  asOf: string;
}

export type FeedEventType =
  | 'sync_available'
  | 'reauth_required'
  | 'expiring'
  | 'revoked'
  | 'disconnected'
  | 'error';

export interface FeedEvent {
  type: FeedEventType;
  /** The id the webhook identifies the connection by (an index key). */
  providerConnectionId: string;
  accountIds?: string[];
  /** `expiring`: when the consent ends. */
  expiresAt?: string | null;
  message?: string | null;
}

export type LinkKind = 'plaid_link' | 'stripe_fc' | 'redirect';

export interface LinkSession {
  kind: LinkKind;
  /** Plaid Link token. */
  token?: string;
  /** Stripe.js `collectFinancialConnectionsAccounts` client secret. */
  clientSecret?: string;
  /** Redirect flows: where to send the browser. */
  url?: string;
  /** Provider session id when it has one (Stripe FC, Enable Banking authorization). */
  sessionId?: string;
  /** ISO timestamp the session stops working. */
  expiresAt?: string | null;
}

export interface LinkSessionInput {
  workspaceId: string;
  mode: LinkMode;
  connectionId?: string;
  historyDays: number;
  redirectUrl: string;
  /** Required for `reauth` and `add_accounts`: the connection being repaired or extended. */
  connection?: StoredConnection;
  /** Redirect providers that need the bank chosen up front (Enable Banking). */
  institution?: { id?: string; name: string; country: string };
  /** Business or personal accounts (PSD2 providers). */
  psuType?: 'business' | 'personal';
}

export interface SyncResult {
  upserts: FeedTransaction[];
  /** Provider transaction ids that no longer exist. */
  removals: string[];
  /** Opaque, stored as JSON per provider. */
  nextCursor: unknown;
  hasMore: boolean;
  /** Per-account status changes found while syncing (Stripe FC, Ponto). */
  accountStatuses?: Record<string, ConnectionStatus>;
  /** Replacement credentials when the call refreshed a rotating token (Ponto); the caller re-encrypts and stores them. */
  credentials?: Record<string, unknown>;
}

/** Cache for provider verification keys; Workers KV satisfies it. */
export interface KeyCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface ProviderSecrets {
  /** HMAC signing secret (Stripe FC, Teller). */
  webhookSecret?: string;
  /** Verification-key cache (Plaid). */
  keyCache?: KeyCache;
  /** Overrides the clock in tests, ms since the epoch. */
  now?: number;
}

export interface BankFeedProvider {
  readonly id: FeedProviderId | string;
  readonly capabilities: ProviderCapabilities;

  createLinkSession(input: LinkSessionInput): Promise<LinkSession>;
  /**
   * Finish a link. `payload` is what the client launcher returns (Plaid
   * `public_token`, Stripe FC session id, the redirect `code`), plus the stored
   * connection for `reauth` / `add_accounts`.
   */
  completeLink(payload: unknown): Promise<{ connection: FeedConnection; accounts: FeedAccount[] }>;
  syncTransactions(connection: StoredConnection, cursor: unknown): Promise<SyncResult>;
  getBalances(connection: StoredConnection): Promise<FeedBalance[]>;
  refresh?(connection: StoredConnection): Promise<void>;
  /** Verify the signature and turn the delivery into events. Throws `WebhookVerificationError`. */
  parseWebhook(request: Request, secrets: ProviderSecrets): Promise<FeedEvent[]>;
  /** Always calls the provider's revoke/remove (it also ends billing). */
  disconnect(connection: StoredConnection): Promise<void>;
  /** Banks the provider can link in a country, for providers that need the bank up front. */
  listInstitutions?(country: string): Promise<FeedInstitution[]>;
  /** Accounts currently on the connection (add-accounts flows, resyncing the list). */
  listAccounts?(connection: StoredConnection): Promise<FeedAccount[]>;
}

export interface FeedInstitution {
  id: string;
  name: string;
  country: string;
  logoUrl?: string | null;
}
