/**
 * Test doubles for the bank-feed services: a scripted provider, an in-memory
 * master index and seed helpers. Used by the tests under this folder and the
 * route tests; not imported by production code.
 */

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
  StoredConnection,
  SyncResult,
} from '@weldsuite/bank-feeds';
import { accountFingerprint } from '@weldsuite/bank-feeds';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { BankFeedIndex, BankFeedIndexRow, FeedContext } from './types';

export const TEST_KEYRING = { v1: 'a'.repeat(64) };

export const PLAID_LIKE: ProviderCapabilities = {
  regions: ['US'],
  changeCursor: true,
  webhooks: true,
  pendingTransactions: true,
  maxHistoryDays: 730,
  onDemandRefresh: true,
  accountTypes: ['depository', 'credit', 'loan'],
};

export const DATE_RANGE_LIKE: ProviderCapabilities = {
  regions: ['NL'],
  changeCursor: false,
  webhooks: false,
  pendingTransactions: true,
  maxHistoryDays: 540,
  onDemandRefresh: false,
  consentTtlDays: 180,
  accountTypes: ['depository'],
};

export class FakeProvider implements BankFeedProvider {
  id: string;
  capabilities: ProviderCapabilities;
  /** Consumed one per `syncTransactions` call; an Error is thrown. When empty, an empty result is returned. */
  script: Array<SyncResult | Error> = [];
  syncCalls: Array<{ cursor: unknown; accountIds?: string[]; credentials: Record<string, unknown> }> = [];
  balances: FeedBalance[] = [];
  disconnected: StoredConnection[] = [];
  refreshed = 0;
  disconnectError: Error | null = null;
  linkResult: { connection: FeedConnection; accounts: FeedAccount[] } | null = null;
  completeCalls: unknown[] = [];

  constructor(id = 'plaid', capabilities: ProviderCapabilities = PLAID_LIKE) {
    this.id = id;
    this.capabilities = capabilities;
  }

  async createLinkSession(input: LinkSessionInput): Promise<LinkSession> {
    return { kind: 'plaid_link', token: `link-${input.mode}-${input.connection?.providerConnectionId ?? 'new'}` };
  }

  async completeLink(payload: unknown) {
    this.completeCalls.push(payload);
    if (!this.linkResult) throw new Error('FakeProvider: no link result scripted');
    return this.linkResult;
  }

  async syncTransactions(connection: StoredConnection, cursor: unknown): Promise<SyncResult> {
    this.syncCalls.push({ cursor, accountIds: connection.accountIds, credentials: connection.credentials });
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    return next ?? { upserts: [], removals: [], nextCursor: cursor, hasMore: false };
  }

  async getBalances(): Promise<FeedBalance[]> {
    return this.balances;
  }

  async refresh(): Promise<void> {
    this.refreshed += 1;
  }

  async parseWebhook(): Promise<FeedEvent[]> {
    return [];
  }

  async disconnect(connection: StoredConnection): Promise<void> {
    this.disconnected.push(connection);
    if (this.disconnectError) throw this.disconnectError;
  }
}

export interface MemoryIndex extends BankFeedIndex {
  rows: Map<string, BankFeedIndexRow & { isActive: boolean; lastError: string | null }>;
}

export function memoryIndex(): MemoryIndex {
  const rows: MemoryIndex['rows'] = new Map();
  return {
    rows,
    async upsert(items) {
      for (const item of items) rows.set(`${item.provider}:${item.providerConnectionId}`, { ...item, isActive: true, lastError: null });
    },
    async setActive(connectionId, active, lastError = null) {
      for (const row of rows.values()) if (row.connectionId === connectionId) Object.assign(row, { isActive: active, lastError });
    },
    async remove(connectionId) {
      for (const [key, row] of rows) if (row.connectionId === connectionId) rows.delete(key);
    },
  };
}

export function makeContext(
  db: Database,
  provider: BankFeedProvider,
  overrides: Partial<FeedContext> = {},
): FeedContext & { index: MemoryIndex } {
  return {
    db,
    keyring: TEST_KEYRING,
    index: memoryIndex(),
    getProvider: (id) => {
      if (id !== provider.id) throw new Error(`Unknown provider ${id}`);
      return provider;
    },
    clerkOrgId: 'org_test',
    ...overrides,
  } as FeedContext & { index: MemoryIndex };
}

export async function seedEntity(db: Database, id = 'ent_us', jurisdictionCode = 'US', baseCurrency = 'USD'): Promise<string> {
  await db
    .insert(schema.entities)
    .values({ id, name: 'Test Entity', jurisdictionCode, baseCurrency, locale: jurisdictionCode === 'US' ? 'en-US' : 'nl-NL' })
    .onConflictDoNothing();
  return id;
}

export async function seedBankAccount(
  db: Database,
  values: Partial<typeof schema.bankAccounts.$inferInsert> & { id: string; entityId: string },
): Promise<void> {
  await db.insert(schema.bankAccounts).values({ name: `Account ${values.id}`, currency: 'USD', ...values });
}

export function feedAccount(overrides: Partial<FeedAccount> & { providerAccountId: string }): FeedAccount {
  return {
    name: 'Business Checking',
    mask: '0000',
    type: 'depository',
    subtype: 'checking',
    currency: 'USD',
    institutionId: 'ins_1',
    institutionName: 'First Platypus Bank',
    fingerprint: `fp-${overrides.providerAccountId}`,
    ...overrides,
  };
}

export async function realFingerprint(institution: string, mask: string, subtype: string): Promise<string> {
  return accountFingerprint(institution, mask, subtype);
}

export function tx(overrides: Partial<FeedTransaction> & { providerTransactionId: string }): FeedTransaction {
  return {
    pendingTransactionId: null,
    accountId: 'acc_feed_1',
    date: '2026-10-01',
    amountMinor: -1234,
    currency: 'USD',
    description: 'STARBUCKS #1234',
    merchantName: 'Starbucks',
    checkNumber: null,
    category: null,
    pending: false,
    raw: {},
    ...overrides,
  };
}

export function page(overrides: Partial<SyncResult> = {}): SyncResult {
  return { upserts: [], removals: [], nextCursor: 'cursor-1', hasMore: false, ...overrides };
}
