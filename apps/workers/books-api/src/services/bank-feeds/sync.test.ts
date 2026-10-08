/**
 * The sync service on a real database (pglite): a scripted provider feeds
 * pages through `syncConnection` and the books must end up right, twice over.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { FeedProviderError, transactionFingerprint, normalizeDescription } from '@weldsuite/bank-feeds';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { sealCredentials, openCredentials } from './credentials';
import { syncConnection } from './sync';
import {
  DATE_RANGE_LIKE,
  FakeProvider,
  TEST_KEYRING,
  makeContext,
  page,
  seedBankAccount,
  seedEntity,
  tx,
} from './testing';

let db: Database;
const ENTITY = 'ent_us';
const CONNECTION = 'bkc_1';

async function reset() {
  await db.delete(schema.bankTransactions);
  await db.delete(schema.bankFeedPendingTransactions);
  await db.delete(schema.bankAccounts);
  await db.delete(schema.bankConnections);
}

async function seedConnection(overrides: Partial<typeof schema.bankConnections.$inferInsert> = {}) {
  await db.insert(schema.bankConnections).values({
    id: CONNECTION,
    entityId: ENTITY,
    provider: 'plaid',
    providerConnectionId: 'item_1',
    institutionName: 'First Platypus Bank',
    status: 'active',
    credentialsEncrypted: await sealCredentials({ accessToken: 'access-secret-1' }, TEST_KEYRING),
    historyDays: 730,
    metadata: {
      feedAccounts: [
        { providerAccountId: 'acc_feed_1', name: 'Checking', mask: '0000', iban: null, type: 'depository', subtype: 'checking', currency: 'USD', fingerprint: 'fp1', status: 'active' },
      ],
    },
    ...overrides,
  });
}

async function seedMappedAccount(overrides: Partial<typeof schema.bankAccounts.$inferInsert> = {}) {
  await seedBankAccount(db, {
    id: 'ba_1',
    entityId: ENTITY,
    feedConnectionId: CONNECTION,
    feedProvider: 'plaid',
    feedAccountId: 'acc_feed_1',
    feedAccountFingerprint: 'fp1',
    feedStatus: 'active',
    ...overrides,
  });
}

const feedRows = () =>
  db.select().from(schema.bankTransactions).where(and(eq(schema.bankTransactions.bankAccountId, 'ba_1'), isNull(schema.bankTransactions.deletedAt)));

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await seedEntity(db, ENTITY);
}, 60_000);

beforeEach(async () => {
  await reset();
  await seedConnection();
  await seedMappedAccount();
});

describe('syncConnection', () => {
  it('stores posted transactions as unreconciled feed rows with the normalized fields', async () => {
    const provider = new FakeProvider();
    provider.script = [
      page({
        upserts: [
          tx({ providerTransactionId: 't_purchase', amountMinor: -1234, checkNumber: null, category: { source: 'plaid', primary: 'FOOD_AND_DRINK' } }),
          tx({ providerTransactionId: 't_check', amountMinor: -50000, description: 'Check 1042', merchantName: null, checkNumber: '1042' }),
          tx({ providerTransactionId: 't_deposit', amountMinor: 250000, description: 'ACH PAYROLL', merchantName: null, date: '2026-10-02' }),
        ],
      }),
    ];
    provider.balances = [{ accountId: 'acc_feed_1', current: 130075, available: 120050, currency: 'USD', asOf: '2026-10-08T00:00:00Z' }];

    const outcome = await syncConnection(makeContext(db, provider), CONNECTION);

    expect(outcome).toMatchObject({ status: 'active', added: 3, updated: 0, removed: 0, pending: 0 });
    const rows = await feedRows();
    expect(rows).toHaveLength(3);
    const purchase = rows.find((r) => r.providerTransactionId === 't_purchase');
    expect(purchase).toMatchObject({
      source: 'feed',
      feedProvider: 'plaid',
      status: 'unreconciled',
      amount: '-12.34',
      description: 'STARBUCKS #1234',
      counterpartyName: 'Starbucks',
      merchantName: 'Starbucks',
      entityId: ENTITY,
      possibleDuplicateOfId: null,
    });
    expect(purchase?.date.toISOString().slice(0, 10)).toBe('2026-10-01');
    expect(purchase?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(purchase?.feedCategory).toMatchObject({ primary: 'FOOD_AND_DRINK' });
    expect(rows.find((r) => r.providerTransactionId === 't_check')).toMatchObject({ checkNumber: '1042', amount: '-500.00' });
    expect(rows.find((r) => r.providerTransactionId === 't_deposit')?.amount).toBe('2500.00');

    const [account] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, 'ba_1'));
    expect(account).toMatchObject({ currentBalance: '1300.75', lastImportBalance: '1300.75' });
    expect(account?.lastImportDate).toBeTruthy();

    const [connection] = await db.select().from(schema.bankConnections).where(eq(schema.bankConnections.id, CONNECTION));
    expect(connection).toMatchObject({ syncCursor: 'cursor-1', lastError: null, status: 'active' });
    expect(connection?.lastSyncedAt).toBeTruthy();
    expect((connection?.metadata as { syncLockUntil?: string } | null)?.syncLockUntil).toBeUndefined();
    expect((connection?.metadata as { lastSync?: { added: number } }).lastSync?.added).toBe(3);
  });

  it('is idempotent: running the same pages twice adds nothing', async () => {
    const provider = new FakeProvider();
    const scripted = () =>
      page({ upserts: [tx({ providerTransactionId: 't1' }), tx({ providerTransactionId: 't2', amountMinor: -500, description: 'Parking' })] });
    provider.script = [scripted(), scripted()];
    const ctx = makeContext(db, provider);

    const first = await syncConnection(ctx, CONNECTION);
    const second = await syncConnection(ctx, CONNECTION);

    expect(first.added).toBe(2);
    expect(second).toMatchObject({ added: 0, updated: 0 });
    expect(await feedRows()).toHaveLength(2);
  });

  it('survives a concurrent insert of the same id (unique index, no duplicate)', async () => {
    const provider = new FakeProvider();
    provider.script = [page({ upserts: [tx({ providerTransactionId: 't1' })] })];
    await db.insert(schema.bankTransactions).values({
      id: 'bt_race',
      entityId: ENTITY,
      bankAccountId: 'ba_1',
      date: new Date('2026-10-01T00:00:00Z'),
      amount: '-12.34',
      description: 'STARBUCKS #1234',
      source: 'feed',
      feedProvider: 'plaid',
      providerTransactionId: 't1',
    });
    await syncConnection(makeContext(db, provider), CONNECTION);
    expect(await feedRows()).toHaveLength(1);
  });

  it('follows has_more and sends the cursor of the previous page', async () => {
    const provider = new FakeProvider();
    provider.script = [
      page({ upserts: [tx({ providerTransactionId: 't1' })], nextCursor: 'c1', hasMore: true }),
      page({ upserts: [tx({ providerTransactionId: 't2', description: 'Other' })], nextCursor: 'c2', hasMore: false }),
    ];

    const outcome = await syncConnection(makeContext(db, provider), CONNECTION);

    expect(provider.syncCalls.map((c) => c.cursor)).toEqual([null, 'c1']);
    expect(outcome.added).toBe(2);
    const [connection] = await db.select().from(schema.bankConnections).where(eq(schema.bankConnections.id, CONNECTION));
    expect(connection?.syncCursor).toBe('c2');
  });

  it('restarts from the first cursor when the provider reports a mutation during pagination', async () => {
    const provider = new FakeProvider();
    provider.script = [
      page({ upserts: [tx({ providerTransactionId: 't1' })], nextCursor: 'c1', hasMore: true }),
      new FeedProviderError('plaid', 'mutation_during_pagination', 'changed'),
      page({ upserts: [tx({ providerTransactionId: 't1' }), tx({ providerTransactionId: 't2', description: 'Other' })], nextCursor: 'c9', hasMore: false }),
    ];
    await db.update(schema.bankConnections).set({ syncCursor: 'c0' }).where(eq(schema.bankConnections.id, CONNECTION));

    const outcome = await syncConnection(makeContext(db, provider), CONNECTION);

    expect(provider.syncCalls.map((c) => c.cursor)).toEqual(['c0', 'c1', 'c0']);
    expect(outcome).toMatchObject({ status: 'active', added: 2 });
    expect(await feedRows()).toHaveLength(2);
  });

  it('keeps only mapped accounts and skips lines before feedSyncFrom', async () => {
    await db.update(schema.bankAccounts).set({ feedSyncFrom: '2026-10-01' }).where(eq(schema.bankAccounts.id, 'ba_1'));
    const provider = new FakeProvider();
    provider.script = [
      page({
        upserts: [
          tx({ providerTransactionId: 'old', date: '2026-09-30' }),
          tx({ providerTransactionId: 'new', date: '2026-10-01' }),
          tx({ providerTransactionId: 'other_account', accountId: 'acc_unmapped' }),
        ],
      }),
    ];

    await syncConnection(makeContext(db, provider), CONNECTION);

    expect((await feedRows()).map((r) => r.providerTransactionId)).toEqual(['new']);
    expect(provider.syncCalls[0]?.accountIds).toEqual(['acc_feed_1']);
  });

  it('does nothing when no feed account is mapped', async () => {
    await db.update(schema.bankAccounts).set({ feedConnectionId: null, feedAccountId: null });
    const provider = new FakeProvider();
    const outcome = await syncConnection(makeContext(db, provider), CONNECTION);
    expect(outcome.skipped).toBe('no_mapped_accounts');
    expect(provider.syncCalls).toHaveLength(0);
  });

  it('refuses to overlap two runs', async () => {
    const provider = new FakeProvider();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    provider.syncTransactions = async (_connection, cursor) => {
      await gate;
      return page({ nextCursor: cursor });
    };
    const ctx = makeContext(db, provider);

    const first = syncConnection(ctx, CONNECTION);
    await vi.waitFor(async () => {
      const [row] = await db.select().from(schema.bankConnections).where(eq(schema.bankConnections.id, CONNECTION));
      expect((row?.metadata as { syncLockUntil?: string } | null)?.syncLockUntil).toBeTruthy();
    });
    const second = await syncConnection(ctx, CONNECTION);
    release();

    expect(second.skipped).toBe('in_progress');
    expect((await first).skipped).toBeUndefined();
    // The lock is released afterwards.
    expect((await syncConnection(ctx, CONNECTION)).skipped).toBeUndefined();
  });

  it('keeps the cursor reset when an account is mapped while a sync is reading, so its history is read next', async () => {
    const provider = new FakeProvider();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    provider.syncTransactions = async () => {
      await gate;
      return page({ upserts: [tx({ providerTransactionId: 't1' })], nextCursor: 'cursor-late' });
    };
    const ctx = makeContext(db, provider);

    const running = syncConnection(ctx, CONNECTION);
    await vi.waitFor(async () => {
      const [row] = await db.select().from(schema.bankConnections).where(eq(schema.bankConnections.id, CONNECTION));
      expect((row?.metadata as { syncLockUntil?: string } | null)?.syncLockUntil).toBeTruthy();
    });
    // A second account is mapped while the run is reading: its earlier history is behind the run's cursor.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedBankAccount(db, { id: 'ba_2', entityId: ENTITY });
    await db
      .update(schema.bankConnections)
      .set({
        syncCursor: null,
        metadata: sql`(coalesce(${schema.bankConnections.metadata}, '{}'::jsonb) || ${JSON.stringify({ resyncAt: new Date().toISOString() })}::jsonb)`,
      })
      .where(eq(schema.bankConnections.id, CONNECTION));
    release();
    await running;

    let [row] = await db.select().from(schema.bankConnections).where(eq(schema.bankConnections.id, CONNECTION));
    expect(row?.syncCursor).toBeNull();
    expect((row?.metadata as { resyncAt?: string }).resyncAt).toBeTruthy();
    expect((row?.metadata as { syncLockUntil?: string }).syncLockUntil).toBeUndefined();

    // The next run starts after the flag, reads from the start, and clears it.
    provider.syncTransactions = async (_connection, cursor) => page({ nextCursor: cursor === null ? 'cursor-full' : 'wrong' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await syncConnection(ctx, CONNECTION);
    [row] = await db.select().from(schema.bankConnections).where(eq(schema.bankConnections.id, CONNECTION));
    expect(row?.syncCursor).toBe('cursor-full');
    expect((row?.metadata as { resyncAt?: string }).resyncAt).toBeUndefined();
  });

  it('takes over a lock that has expired', async () => {
    await db
      .update(schema.bankConnections)
      .set({ metadata: { syncLockUntil: new Date(Date.now() - 60_000).toISOString(), feedAccounts: [] } })
      .where(eq(schema.bankConnections.id, CONNECTION));
    const outcome = await syncConnection(makeContext(db, new FakeProvider()), CONNECTION);
    expect(outcome.skipped).toBeUndefined();
  });
});

describe('pending and posted', () => {
  it('keeps pending lines out of the books, then swaps them for the posted line (Plaid: new id)', async () => {
    const provider = new FakeProvider();
    provider.script = [
      page({ upserts: [tx({ providerTransactionId: 'pending_1', pending: true, amountMinor: -4000, description: 'HOTEL HOLD' })], nextCursor: 'c1' }),
      page({
        upserts: [tx({ providerTransactionId: 'posted_1', pendingTransactionId: 'pending_1', amountMinor: -4250, description: 'HOTEL STAY', date: '2026-10-03' })],
        removals: ['pending_1'],
        nextCursor: 'c2',
      }),
    ];
    const ctx = makeContext(db, provider);

    const first = await syncConnection(ctx, CONNECTION);
    expect(first).toMatchObject({ added: 0, pending: 1 });
    expect(await feedRows()).toHaveLength(0);
    const pendingRows = await db.select().from(schema.bankFeedPendingTransactions);
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0]).toMatchObject({ providerTransactionId: 'pending_1', amount: '-40.00', bankAccountId: 'ba_1', connectionId: CONNECTION });

    const second = await syncConnection(ctx, CONNECTION);
    expect(second.added).toBe(1);
    expect(await db.select().from(schema.bankFeedPendingTransactions)).toHaveLength(0);
    expect((await feedRows()).map((r) => [r.providerTransactionId, r.amount])).toEqual([['posted_1', '-42.50']]);
  });

  it('turns a pending line into a posted one in place (Stripe FC: same id)', async () => {
    const provider = new FakeProvider('plaid');
    provider.script = [
      page({ upserts: [tx({ providerTransactionId: 'fctxn_1', pending: true, amountMinor: -900 })], nextCursor: 'c1' }),
      page({ upserts: [tx({ providerTransactionId: 'fctxn_1', pending: false, amountMinor: -900 })], nextCursor: 'c2' }),
    ];
    const ctx = makeContext(db, provider);
    await syncConnection(ctx, CONNECTION);
    expect(await db.select().from(schema.bankFeedPendingTransactions)).toHaveLength(1);
    await syncConnection(ctx, CONNECTION);
    expect(await db.select().from(schema.bankFeedPendingTransactions)).toHaveLength(0);
    expect(await feedRows()).toHaveLength(1);
  });

  it('updates a pending line that moved', async () => {
    const provider = new FakeProvider();
    provider.script = [
      page({ upserts: [tx({ providerTransactionId: 'p1', pending: true, amountMinor: -1000 })] }),
      page({ upserts: [tx({ providerTransactionId: 'p1', pending: true, amountMinor: -1500 })] }),
    ];
    const ctx = makeContext(db, provider);
    await syncConnection(ctx, CONNECTION);
    await syncConnection(ctx, CONNECTION);
    const rows = await db.select().from(schema.bankFeedPendingTransactions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe('-15.00');
  });

  it('matches pending to posted by amount, window and description for date-range providers, and voids old leftovers', async () => {
    const provider = new FakeProvider('plaid', DATE_RANGE_LIKE);
    const today = new Date();
    const daysAgo = (n: number) => new Date(today.getTime() - n * 86_400_000).toISOString().slice(0, 10);
    await db.insert(schema.bankFeedPendingTransactions).values([
      { id: 'bfp_match', entityId: ENTITY, bankAccountId: 'ba_1', connectionId: CONNECTION, provider: 'plaid', providerTransactionId: 'pend_a', date: daysAgo(4), amount: '-45.99', currency: 'USD', description: 'AMAZON MKTPLACE PMTS' },
      { id: 'bfp_other', entityId: ENTITY, bankAccountId: 'ba_1', connectionId: CONNECTION, provider: 'plaid', providerTransactionId: 'pend_b', date: daysAgo(3), amount: '-10.00', currency: 'USD', description: 'SOMETHING ELSE' },
      { id: 'bfp_stale', entityId: ENTITY, bankAccountId: 'ba_1', connectionId: CONNECTION, provider: 'plaid', providerTransactionId: 'pend_old', date: daysAgo(20), amount: '-5.00', currency: 'USD', description: 'FORGOTTEN HOLD' },
    ]);
    provider.script = [
      page({
        upserts: [tx({ providerTransactionId: 'posted_a', amountMinor: -4599, description: 'Amazon Mktplace Pmts AMZN.COM/BILL', date: daysAgo(1) })],
        nextCursor: { through: daysAgo(0) },
      }),
    ];

    const outcome = await syncConnection(makeContext(db, provider), CONNECTION);

    expect(outcome).toMatchObject({ added: 1, pendingVoided: 1 });
    const pending = await db.select().from(schema.bankFeedPendingTransactions);
    expect(pending.find((p) => p.providerTransactionId === 'pend_a')).toBeUndefined();
    expect(pending.find((p) => p.providerTransactionId === 'pend_b')?.voidedAt).toBeNull();
    expect(pending.find((p) => p.providerTransactionId === 'pend_old')?.voidedAt).toBeTruthy();
  });
});

describe('removals and changes', () => {
  async function seedFeedRow(id: string, providerId: string, status = 'unreconciled', extra: Partial<typeof schema.bankTransactions.$inferInsert> = {}) {
    await db.insert(schema.bankTransactions).values({
      id,
      entityId: ENTITY,
      bankAccountId: 'ba_1',
      date: new Date('2026-10-01T00:00:00Z'),
      amount: '-12.34',
      description: 'STARBUCKS #1234',
      merchantName: 'Starbucks',
      source: 'feed',
      feedProvider: 'plaid',
      providerTransactionId: providerId,
      status,
      ...extra,
    });
  }

  it('soft-deletes an unreconciled line the bank removed and keeps a reconciled one with a warning', async () => {
    await seedFeedRow('bt_open', 'gone_open');
    await seedFeedRow('bt_done', 'gone_done', 'reconciled', { journalEntryId: 'je_1' });
    const provider = new FakeProvider();
    provider.script = [page({ removals: ['gone_open', 'gone_done', 'never_seen'] })];

    const outcome = await syncConnection(makeContext(db, provider), CONNECTION);

    expect(outcome).toMatchObject({ removed: 1, warnings: 1 });
    const [open] = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.id, 'bt_open'));
    const [done] = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.id, 'bt_done'));
    expect(open?.deletedAt).toBeTruthy();
    expect(done?.deletedAt).toBeNull();
    const [connection] = await db.select().from(schema.bankConnections).where(eq(schema.bankConnections.id, CONNECTION));
    const warnings = (connection?.metadata as { warnings: Array<{ code: string; bankTransactionId: string }> }).warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: 'removed_reconciled', bankTransactionId: 'bt_done' });
  });

  it('follows a modified line while it is unreconciled and leaves a reconciled one alone', async () => {
    await seedFeedRow('bt_open', 't_open');
    await seedFeedRow('bt_done', 't_done', 'reconciled', { journalEntryId: 'je_1' });
    const provider = new FakeProvider();
    provider.script = [
      page({
        upserts: [
          tx({ providerTransactionId: 't_open', amountMinor: -1500, description: 'STARBUCKS #1234 NYC', date: '2026-10-02' }),
          tx({ providerTransactionId: 't_done', amountMinor: -9999 }),
        ],
      }),
    ];

    const outcome = await syncConnection(makeContext(db, provider), CONNECTION);

    expect(outcome).toMatchObject({ added: 0, updated: 1 });
    const [open] = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.id, 'bt_open'));
    const [done] = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.id, 'bt_done'));
    expect(open).toMatchObject({ amount: '-15.00', description: 'STARBUCKS #1234 NYC' });
    expect(open?.date.toISOString().slice(0, 10)).toBe('2026-10-02');
    expect(done?.amount).toBe('-12.34');
  });

  it('brings back a removed line the provider sends again', async () => {
    await seedFeedRow('bt_gone', 't1', 'unreconciled', { deletedAt: new Date() });
    const provider = new FakeProvider();
    provider.script = [page({ upserts: [tx({ providerTransactionId: 't1' })] })];
    await syncConnection(makeContext(db, provider), CONNECTION);
    const [row] = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.id, 'bt_gone'));
    expect(row?.deletedAt).toBeNull();
  });
});

describe('possible duplicates after an import', () => {
  it('flags a feed line that matches an imported line, without merging them', async () => {
    const description = 'STARBUCKS #1234';
    const fingerprint = await transactionFingerprint('2026-10-01', -1234, normalizeDescription(description), 0);
    await db.insert(schema.bankTransactions).values([
      // imported with a stored fingerprint
      { id: 'bt_imp', entityId: ENTITY, bankAccountId: 'ba_1', date: new Date('2026-10-01T00:00:00Z'), amount: '-12.34', description, source: 'import', fingerprint },
      // imported without one (older import): matched by recomputing
      { id: 'bt_imp2', entityId: ENTITY, bankAccountId: 'ba_1', date: new Date('2026-10-02T00:00:00Z'), amount: '-5.00', description: 'Parking', source: null },
    ]);
    const provider = new FakeProvider();
    provider.script = [
      page({
        upserts: [
          tx({ providerTransactionId: 'f1', description }),
          tx({ providerTransactionId: 'f2', description: 'Parking', amountMinor: -500, date: '2026-10-02' }),
          tx({ providerTransactionId: 'f3', description: 'Unrelated', amountMinor: -700 }),
        ],
      }),
    ];

    const outcome = await syncConnection(makeContext(db, provider), CONNECTION);

    expect(outcome.possibleDuplicates).toBe(2);
    const rows = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.source, 'feed'));
    expect(rows.find((r) => r.providerTransactionId === 'f1')?.possibleDuplicateOfId).toBe('bt_imp');
    expect(rows.find((r) => r.providerTransactionId === 'f2')?.possibleDuplicateOfId).toBe('bt_imp2');
    expect(rows.find((r) => r.providerTransactionId === 'f3')?.possibleDuplicateOfId).toBeNull();
    expect(await db.select().from(schema.bankTransactions)).toHaveLength(5);
  });

  it('numbers identical lines on one day so twins do not collapse', async () => {
    const provider = new FakeProvider();
    provider.script = [page({ upserts: [tx({ providerTransactionId: 'a' }), tx({ providerTransactionId: 'b' })] })];
    await syncConnection(makeContext(db, provider), CONNECTION);
    const rows = await feedRows();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.fingerprint)).size).toBe(2);
  });
});

describe('connection health', () => {
  it('marks the connection reauth_required, deactivates the index, and recovers on the next clean read', async () => {
    const provider = new FakeProvider();
    provider.script = [new FeedProviderError('plaid', 'reauth_required', 'Plaid ITEM_LOGIN_REQUIRED')];
    const ctx = makeContext(db, provider);
    await ctx.index.upsert([{ provider: 'plaid', providerConnectionId: 'item_1', clerkOrgId: 'org_test', connectionId: CONNECTION, entityId: ENTITY, syncIntervalHours: 24, nextSyncAt: new Date() }]);

    const failed = await syncConnection(ctx, CONNECTION);

    expect(failed).toMatchObject({ status: 'reauth_required', error: 'Plaid ITEM_LOGIN_REQUIRED' });
    expect(failed.retryable).toBeFalsy();
    const [connection] = await db.select().from(schema.bankConnections).where(eq(schema.bankConnections.id, CONNECTION));
    expect(connection).toMatchObject({ status: 'reauth_required', lastError: 'Plaid ITEM_LOGIN_REQUIRED' });
    expect((connection?.metadata as { syncLockUntil?: string }).syncLockUntil).toBeUndefined();
    const [account] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, 'ba_1'));
    expect(account?.feedStatus).toBe('reauth_required');
    expect(ctx.index.rows.get('plaid:item_1')?.isActive).toBe(false);

    provider.script = [page({ upserts: [tx({ providerTransactionId: 't1' })] })];
    const recovered = await syncConnection(ctx, CONNECTION);

    expect(recovered.status).toBe('active');
    expect(ctx.index.rows.get('plaid:item_1')?.isActive).toBe(true);
    const [after] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, 'ba_1'));
    expect(after?.feedStatus).toBe('active');
  });

  it('keeps the status on a transient failure and flags it retryable; a permanent one becomes error', async () => {
    const provider = new FakeProvider();
    const ctx = makeContext(db, provider);

    provider.script = [new FeedProviderError('plaid', 'rate_limit', 'Plaid RATE_LIMIT_EXCEEDED')];
    const limited = await syncConnection(ctx, CONNECTION);
    expect(limited).toMatchObject({ status: 'active', retryable: true });

    provider.script = [new FeedProviderError('plaid', 'permanent', 'Plaid INVALID_FIELD')];
    const broken = await syncConnection(ctx, CONNECTION);
    expect(broken).toMatchObject({ status: 'error', retryable: false });

    // error is not terminal: the next clean sync clears it.
    expect((await syncConnection(ctx, CONNECTION)).status).toBe('active');
  });

  it('records revoked access and stops', async () => {
    const provider = new FakeProvider();
    provider.script = [new FeedProviderError('plaid', 'revoked', 'Plaid ITEM_NOT_FOUND')];
    const outcome = await syncConnection(makeContext(db, provider), CONNECTION);
    expect(outcome.status).toBe('revoked');
    expect((await syncConnection(makeContext(db, provider), CONNECTION)).skipped).toBe('not_active');
  });

  it('releases the lock and rethrows on an unexpected failure', async () => {
    const provider = new FakeProvider();
    provider.script = [new Error('database exploded')];
    await expect(syncConnection(makeContext(db, provider), CONNECTION)).rejects.toThrow('database exploded');
    expect((await syncConnection(makeContext(db, new FakeProvider()), CONNECTION)).skipped).toBeUndefined();
  });

  it('takes per-account statuses from the provider and rolls them up', async () => {
    await seedBankAccount(db, { id: 'ba_2', entityId: ENTITY, feedConnectionId: CONNECTION, feedProvider: 'plaid', feedAccountId: 'acc_feed_2', feedStatus: 'active' });
    await db
      .update(schema.bankConnections)
      .set({
        metadata: {
          feedAccounts: [
            { providerAccountId: 'acc_feed_1', name: 'A', mask: '1', iban: null, type: 'depository', subtype: 'checking', currency: 'USD', fingerprint: 'f1', status: 'active' },
            { providerAccountId: 'acc_feed_2', name: 'B', mask: '2', iban: null, type: 'depository', subtype: 'checking', currency: 'USD', fingerprint: 'f2', status: 'active' },
          ],
        },
      })
      .where(eq(schema.bankConnections.id, CONNECTION));
    const provider = new FakeProvider();
    provider.script = [page({ accountStatuses: { acc_feed_1: 'active', acc_feed_2: 'reauth_required' } })];
    const ctx = makeContext(db, provider);

    const outcome = await syncConnection(ctx, CONNECTION);

    expect(outcome.status).toBe('reauth_required');
    const [second] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, 'ba_2'));
    const [first] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, 'ba_1'));
    expect([first?.feedStatus, second?.feedStatus]).toEqual(['active', 'reauth_required']);
  });

  it('turns an expiring consent into status expiring and an expired one into reauth_required', async () => {
    const provider = new FakeProvider('plaid', DATE_RANGE_LIKE);
    const ctx = makeContext(db, provider);
    await db.update(schema.bankConnections).set({ consentExpiresAt: new Date(Date.now() + 5 * 86_400_000) }).where(eq(schema.bankConnections.id, CONNECTION));
    expect((await syncConnection(ctx, CONNECTION)).status).toBe('expiring');
    await db.update(schema.bankConnections).set({ consentExpiresAt: new Date(Date.now() - 86_400_000) }).where(eq(schema.bankConnections.id, CONNECTION));
    expect((await syncConnection(ctx, CONNECTION)).status).toBe('reauth_required');
  });

  it('stores rotated credentials the provider hands back, encrypted', async () => {
    const provider = new FakeProvider('plaid', DATE_RANGE_LIKE);
    provider.script = [page({ nextCursor: { through: '2026-10-08' }, credentials: { accessToken: 'rotated-token', refreshToken: 'rt-2' } })];
    await syncConnection(makeContext(db, provider), CONNECTION);

    const [connection] = await db.select().from(schema.bankConnections).where(eq(schema.bankConnections.id, CONNECTION));
    expect(connection?.credentialsEncrypted).not.toContain('rotated-token');
    expect(await openCredentials(connection?.credentialsEncrypted ?? null, TEST_KEYRING)).toEqual({ accessToken: 'rotated-token', refreshToken: 'rt-2' });
    expect(connection?.syncCursor).toEqual({ through: '2026-10-08' });
  });

  it('passes the stored credentials to the provider and asks for a refresh on demand', async () => {
    const provider = new FakeProvider();
    await syncConnection(makeContext(db, provider), CONNECTION, { refresh: true });
    expect(provider.refreshed).toBe(1);
    expect(provider.syncCalls[0]?.credentials).toEqual({ accessToken: 'access-secret-1' });
  });

  it('skips disconnected and unknown connections', async () => {
    const provider = new FakeProvider();
    expect((await syncConnection(makeContext(db, provider), 'bkc_missing')).skipped).toBe('not_found');
    await db.update(schema.bankConnections).set({ status: 'disconnected' }).where(eq(schema.bankConnections.id, CONNECTION));
    expect((await syncConnection(makeContext(db, provider), CONNECTION)).skipped).toBe('not_active');
    expect(provider.syncCalls).toHaveLength(0);
  });
});

describe('reconciliation hook', () => {
  it('runs the matcher for accounts that received new lines, unless auto-reconcile is off', async () => {
    await seedBankAccount(db, { id: 'ba_2', entityId: ENTITY, feedConnectionId: CONNECTION, feedProvider: 'plaid', feedAccountId: 'acc_feed_2', autoReconcile: false });
    const matcher = vi.fn(async () => 2);
    const provider = new FakeProvider();
    provider.script = [
      page({ upserts: [tx({ providerTransactionId: 't1' }), tx({ providerTransactionId: 't2', accountId: 'acc_feed_2', description: 'Other' })] }),
    ];

    const outcome = await syncConnection(makeContext(db, provider, { autoReconcile: matcher }), CONNECTION);

    expect(matcher).toHaveBeenCalledTimes(1);
    expect(matcher).toHaveBeenCalledWith(db, 'ba_1');
    expect(outcome.autoReconciled).toBe(2);
  });

  it('does not let a matcher failure fail the sync', async () => {
    const provider = new FakeProvider();
    provider.script = [page({ upserts: [tx({ providerTransactionId: 't1' })] })];
    const outcome = await syncConnection(
      makeContext(db, provider, {
        autoReconcile: async () => {
          throw new Error('matcher broke');
        },
      }),
      CONNECTION,
    );
    expect(outcome).toMatchObject({ status: 'active', added: 1 });
  });
});
