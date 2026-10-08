import type {
  BankFeedProvider,
  ConnectionStatus,
  FeedAccount,
  FeedAccountType,
  ProviderCapabilities,
} from '@weldsuite/bank-feeds/types';
import type { EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import type { Database } from '@weldsuite/worker-kit/db';

/** The master-DB `bank_feed_connection_index` as the services use it (swappable in tests). */
export interface BankFeedIndexRow {
  provider: string;
  /** The id the provider's webhooks identify the connection by. */
  providerConnectionId: string;
  clerkOrgId: string;
  connectionId: string;
  entityId: string;
  syncIntervalHours: number;
  nextSyncAt: Date;
}

export interface BankFeedIndex {
  upsert(rows: BankFeedIndexRow[]): Promise<void>;
  setActive(connectionId: string, active: boolean, lastError?: string | null): Promise<void>;
  remove(connectionId: string): Promise<void>;
}

export interface FeedContext {
  db: Database;
  keyring: EncryptionKeyring;
  index: BankFeedIndex;
  getProvider(id: string): BankFeedProvider;
  /** Clerk org id of the workspace, for the master index. */
  clerkOrgId: string;
  now?: () => Date;
  /** Runs the reconciliation matcher after new transactions arrive; returns how many it matched. */
  autoReconcile?: (db: Database, bankAccountId: string) => Promise<number>;
}

/** A feed account as kept in `bank_connections.metadata.feedAccounts`: nothing secret. */
export interface StoredFeedAccount {
  providerAccountId: string;
  name: string;
  mask: string | null;
  iban: string | null;
  type: FeedAccountType;
  subtype: string | null;
  currency: string;
  fingerprint: string;
  status: ConnectionStatus;
}

export interface ConnectionWarning {
  at: string;
  code: string;
  message: string;
  providerTransactionId?: string;
  bankTransactionId?: string;
}

export interface MappingSuggestion {
  bankAccountId: string;
  bankAccountName: string;
  reason: 'fingerprint' | 'iban' | 'last4' | 'name';
}

export interface ConnectionAccountView {
  feedAccountId: string;
  name: string;
  mask: string | null;
  type: FeedAccountType;
  subtype: string | null;
  currency: string;
  status: ConnectionStatus;
  bankAccountId: string | null;
  bankAccountName: string | null;
  syncFrom: string | null;
  /** Only on a fresh link, for accounts not yet mapped. */
  suggestion?: MappingSuggestion | null;
}

export interface ConnectionView {
  id: string;
  entityId: string;
  provider: string;
  institutionId: string | null;
  institutionName: string | null;
  status: ConnectionStatus;
  lastSyncedAt: string | null;
  lastError: string | null;
  consentExpiresAt: string | null;
  historyDays: number | null;
  createdAt: string;
  capabilities: ProviderCapabilities | null;
  accounts: ConnectionAccountView[];
  warnings: ConnectionWarning[];
}

export type { FeedAccount };

export const SYNC_LOCK_MINUTES = 5;
export const MAX_WARNINGS = 50;
export const DEFAULT_HISTORY_DAYS = 730;

/** Statuses that stop syncing until the user acts or the link is gone. */
export const INACTIVE_STATUSES: ReadonlySet<ConnectionStatus> = new Set(['reauth_required', 'revoked', 'disconnected']);
