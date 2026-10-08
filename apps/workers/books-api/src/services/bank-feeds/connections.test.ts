import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { FeedProviderError, type FeedConnection } from '@weldsuite/bank-feeds';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  completeLink,
  connectionViewById,
  createLinkSession,
  deleteConnection,
  disconnectConnection,
  listConnectionViews,
  listPendingTransactions,
  mapAccounts,
} from './connections';
import { openCredentials } from './credentials';
import { applyFeedEvent } from './events';
import { FeedServiceError } from './errors';
import { syncConnection } from './sync';
import { FakeProvider, TEST_KEYRING, feedAccount, makeContext, page, seedBankAccount, seedEntity, tx } from './testing';

let db: Database;
const ENTITY = 'ent_us';

function linked(overrides: Partial<FeedConnection> = {}, accounts = [feedAccount({ providerAccountId: 'acc_feed_1' }), feedAccount({ providerAccountId: 'acc_card', name: 'Sapphire', mask: '4242', type: 'credit', subtype: 'credit_card' })]) {
  return {
    connection: {
      provider: 'plaid',
      providerConnectionId: 'item_1',
      institutionId: 'ins_1',
      institutionName: 'First Platypus Bank',
      status: 'active',
      credentials: { accessToken: 'access-secret-1' },
      cursor: null,
      consentExpiresAt: null,
      ...overrides,
    } satisfies FeedConnection,
    accounts,
  };
}

async function reset() {
  await db.delete(schema.bankTransactions);
  await db.delete(schema.bankFeedPendingTransactions);
  await db.delete(schema.bankAccounts);
  await db.delete(schema.bankConnections);
  await db.delete(schema.accounts);
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await seedEntity(db, ENTITY);
}, 60_000);

beforeEach(reset);

describe('createLinkSession', () => {
  it('asks the provider for a session with the capped history and, for reconnects, the stored connection', async () => {
    const provider = new FakeProvider();
    provider.linkResult = linked();
    const ctx = makeContext(db, provider);

    const created = await createLinkSession(ctx, { providerId: 'plaid', mode: 'create', workspaceId: 'ws_1', redirectUrl: 'https://app.example/cb' });
    expect(created).toMatchObject({ provider: 'plaid', kind: 'plaid_link', token: 'link-create-new', historyDays: 730 });

    const { view } = await completeLink(ctx, { providerId: 'plaid', payload: { publicToken: 'p' }, entityId: ENTITY, userId: 'user_1' });
    const reauth = await createLinkSession(ctx, { providerId: 'plaid', mode: 'reauth', connectionId: view.id, workspaceId: 'ws_1', redirectUrl: 'https://app.example/cb' });
    expect(reauth.token).toBe('link-reauth-item_1');

    await expect(
      createLinkSession(ctx, { providerId: 'plaid', mode: 'reauth', workspaceId: 'ws_1', redirectUrl: 'https://app.example/cb' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('reports an unconfigured provider as unavailable', async () => {
    const ctx = makeContext(db, new FakeProvider(), {
      getProvider: () => {
        throw new FeedProviderError('teller', 'not_configured', "Bank feed provider 'teller' is not configured");
      },
    });
    await expect(createLinkSession(ctx, { providerId: 'teller', mode: 'create', workspaceId: 'ws', redirectUrl: 'https://x.example' })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});

describe('completeLink', () => {
  it('stores the connection with encrypted credentials, indexes it, and lists the accounts', async () => {
    const provider = new FakeProvider();
    provider.linkResult = linked({ consentExpiresAt: '2027-01-01T00:00:00Z' });
    const ctx = makeContext(db, provider);

    const { view, created } = await completeLink(ctx, { providerId: 'plaid', payload: { publicToken: 'public-1' }, entityId: ENTITY, userId: 'user_1' });

    expect(created).toBe(true);
    expect(view).toMatchObject({ provider: 'plaid', institutionName: 'First Platypus Bank', status: 'active', entityId: ENTITY, historyDays: 730 });
    expect(view.accounts.map((a) => [a.feedAccountId, a.bankAccountId])).toEqual([
      ['acc_feed_1', null],
      ['acc_card', null],
    ]);
    expect(JSON.stringify(view)).not.toContain('access-secret-1');

    const [row] = await db.select().from(schema.bankConnections).where(eq(schema.bankConnections.id, view.id));
    expect(row?.credentialsEncrypted).toBeTruthy();
    expect(row?.credentialsEncrypted).not.toContain('access-secret-1');
    expect(await openCredentials(row?.credentialsEncrypted ?? null, TEST_KEYRING)).toEqual({ accessToken: 'access-secret-1' });
    expect(row?.consentExpiresAt?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(row?.createdBy).toBe('user_1');

    const indexed = ctx.index.rows.get('plaid:item_1');
    expect(indexed).toMatchObject({ connectionId: view.id, clerkOrgId: 'org_test', entityId: ENTITY, syncIntervalHours: 24, isActive: true });
  });

  it('indexes every webhook key a provider reports and polls providers without webhooks more often', async () => {
    const provider = new FakeProvider('stripe_fc', { ...new FakeProvider().capabilities, webhooks: true });
    provider.linkResult = linked({ provider: 'stripe_fc', providerConnectionId: 'fcsess_1', indexKeys: ['fca_1', 'fca_2'] });
    const ctx = makeContext(db, provider);
    await completeLink(ctx, { providerId: 'stripe_fc', payload: { sessionId: 'fcsess_1' }, entityId: ENTITY, userId: null });
    expect([...ctx.index.rows.keys()].sort()).toEqual(['stripe_fc:fca_1', 'stripe_fc:fca_2']);

    const polled = new FakeProvider('ponto', { ...new FakeProvider().capabilities, webhooks: false });
    polled.linkResult = linked({ provider: 'ponto', providerConnectionId: 'ponto_1' });
    const pollCtx = makeContext(db, polled);
    await completeLink(pollCtx, { providerId: 'ponto', payload: {}, entityId: ENTITY, userId: null });
    expect(pollCtx.index.rows.get('ponto:ponto_1')?.syncIntervalHours).toBe(6);
  });

  it('is idempotent for a repeated completion of the same link', async () => {
    const provider = new FakeProvider();
    provider.linkResult = linked();
    const ctx = makeContext(db, provider);
    const first = await completeLink(ctx, { providerId: 'plaid', payload: {}, entityId: ENTITY, userId: null });
    const second = await completeLink(ctx, { providerId: 'plaid', payload: {}, entityId: ENTITY, userId: null });
    expect(second.view.id).toBe(first.view.id);
    expect(second.created).toBe(false);
    expect(await listConnectionViews(ctx, ENTITY)).toHaveLength(1);
  });

  it('suggests the existing bank account by fingerprint, IBAN, last four or name', async () => {
    await seedBankAccount(db, { id: 'ba_fp', entityId: ENTITY, name: 'Old name', feedAccountFingerprint: 'fp-acc_feed_1' });
    await seedBankAccount(db, { id: 'ba_last4', entityId: ENTITY, name: 'Cards', accountNumberLast4: '4242' });
    await seedBankAccount(db, { id: 'ba_iban', entityId: ENTITY, name: 'Euro', iban: 'NL91 ABNA 0417 1643 00' });
    await seedBankAccount(db, { id: 'ba_name', entityId: ENTITY, name: 'savings account' });
    await seedBankAccount(db, { id: 'ba_taken', entityId: ENTITY, name: 'Taken', accountNumberLast4: '9999', feedConnectionId: 'bkc_other', feedStatus: 'active' });

    const provider = new FakeProvider();
    provider.linkResult = linked({}, [
      feedAccount({ providerAccountId: 'a1' }),
      feedAccount({ providerAccountId: 'a2', name: 'Card', mask: '4242', fingerprint: 'x2' }),
      feedAccount({ providerAccountId: 'a3', name: 'EUR', mask: '4300', iban: 'NL91ABNA0417164300', fingerprint: 'x3' }),
      feedAccount({ providerAccountId: 'a4', name: 'Savings Account', mask: '7', fingerprint: 'x4' }),
      feedAccount({ providerAccountId: 'a5', name: 'Taken', mask: '9999', fingerprint: 'x5' }),
    ]);
    provider.linkResult.accounts[0] = feedAccount({ providerAccountId: 'a1', fingerprint: 'fp-acc_feed_1' });

    const { view } = await completeLink(makeContext(db, provider), { providerId: 'plaid', payload: {}, entityId: ENTITY, userId: null });

    const suggestions = Object.fromEntries(view.accounts.map((a) => [a.feedAccountId, a.suggestion]));
    expect(suggestions.a1).toEqual({ bankAccountId: 'ba_fp', bankAccountName: 'Old name', reason: 'fingerprint' });
    expect(suggestions.a2).toMatchObject({ bankAccountId: 'ba_last4', reason: 'last4' });
    expect(suggestions.a3).toMatchObject({ bankAccountId: 'ba_iban', reason: 'iban' });
    expect(suggestions.a4).toMatchObject({ bankAccountId: 'ba_name', reason: 'name' });
    expect(suggestions.a5).toBeNull(); // already linked to another live connection
  });

  it('reattaches bank accounts to the new provider account ids after a relink (same fingerprint)', async () => {
    const provider = new FakeProvider('stripe_fc');
    provider.linkResult = linked({ provider: 'stripe_fc', providerConnectionId: 'fcsess_1' }, [feedAccount({ providerAccountId: 'fca_old', fingerprint: 'same-fp' })]);
    const ctx = makeContext(db, provider);
    const { view } = await completeLink(ctx, { providerId: 'stripe_fc', payload: {}, entityId: ENTITY, userId: null });
    await mapAccounts(ctx, view.id, { mappings: [{ feedAccountId: 'fca_old', create: { name: 'Checking' } }] });
    await db.update(schema.bankAccounts).set({ feedStatus: 'reauth_required' });

    provider.linkResult = linked({ provider: 'stripe_fc', providerConnectionId: 'fcsess_2' }, [feedAccount({ providerAccountId: 'fca_new', fingerprint: 'same-fp' })]);
    const relinked = await completeLink(ctx, { providerId: 'stripe_fc', payload: {}, connectionId: view.id, entityId: ENTITY, userId: null });

    expect(relinked.created).toBe(false);
    expect(provider.completeCalls.at(-1)).toMatchObject({ connection: { providerConnectionId: 'fcsess_1' } });
    const [bank] = await db.select().from(schema.bankAccounts);
    expect(bank).toMatchObject({ feedAccountId: 'fca_new', feedStatus: 'active', feedConnectionId: view.id });
    expect(relinked.view.accounts.map((a) => a.feedAccountId)).toEqual(['fca_new']);
    expect(relinked.view.status).toBe('active');
  });

  it('adds accounts to a connection without touching the ones it already has', async () => {
    const provider = new FakeProvider('stripe_fc');
    provider.linkResult = linked({ provider: 'stripe_fc', providerConnectionId: 'fcsess_1' }, [feedAccount({ providerAccountId: 'fca_a', fingerprint: 'fp-a' })]);
    const ctx = makeContext(db, provider);
    const { view } = await completeLink(ctx, { providerId: 'stripe_fc', payload: {}, entityId: ENTITY, userId: null });
    await mapAccounts(ctx, view.id, { mappings: [{ feedAccountId: 'fca_a', create: { name: 'A' } }] });
    await applyFeedEvent(ctx, view.id, { type: 'reauth_required', providerConnectionId: 'fca_a', accountIds: ['fca_a'] });

    provider.linkResult = linked({ provider: 'stripe_fc', providerConnectionId: 'fcsess_2' }, [feedAccount({ providerAccountId: 'fca_b', fingerprint: 'fp-b' })]);
    const added = await completeLink(ctx, { providerId: 'stripe_fc', payload: {}, connectionId: view.id, entityId: ENTITY, userId: null });

    expect(added.view.accounts.map((a) => [a.feedAccountId, a.status])).toEqual([
      ['fca_a', 'reauth_required'],
      ['fca_b', 'active'],
    ]);
    // The account that still needs the user keeps the whole connection flagged.
    expect(added.view.status).toBe('reauth_required');
    const [bank] = await db.select().from(schema.bankAccounts);
    expect(bank).toMatchObject({ feedAccountId: 'fca_a', feedStatus: 'reauth_required' });
  });

  it('never takes the stored connection from the client payload', async () => {
    const provider = new FakeProvider();
    provider.linkResult = linked();
    const ctx = makeContext(db, provider);
    await completeLink(ctx, { providerId: 'plaid', payload: { publicToken: 'p', connection: { credentials: { accessToken: 'attacker' } } }, entityId: ENTITY, userId: null });
    expect(provider.completeCalls[0]).toEqual({ publicToken: 'p' });
  });

  it('turns provider errors into service errors', async () => {
    const provider = new FakeProvider();
    provider.completeLink = async () => {
      throw new FeedProviderError('plaid', 'permanent', 'Plaid INVALID_PUBLIC_TOKEN');
    };
    await expect(completeLink(makeContext(db, provider), { providerId: 'plaid', payload: {}, entityId: ENTITY, userId: null })).rejects.toMatchObject({
      code: 'bad_request',
      message: 'Plaid INVALID_PUBLIC_TOKEN',
    });
  });
});

describe('mapAccounts', () => {
  async function linkedConnection() {
    const provider = new FakeProvider();
    provider.linkResult = linked();
    const ctx = makeContext(db, provider);
    const { view } = await completeLink(ctx, { providerId: 'plaid', payload: {}, entityId: ENTITY, userId: null });
    return { provider, ctx, id: view.id };
  }

  it('attaches a feed account to an existing bank account', async () => {
    const { ctx, id } = await linkedConnection();
    await seedBankAccount(db, { id: 'ba_existing', entityId: ENTITY, name: 'Operating' });

    const result = await mapAccounts(ctx, id, { mappings: [{ feedAccountId: 'acc_feed_1', bankAccountId: 'ba_existing', syncFrom: '2026-10-01' }] });

    expect(result.needsSync).toBe(true);
    expect(result.mapped).toEqual([{ feedAccountId: 'acc_feed_1', bankAccountId: 'ba_existing', created: false }]);
    const [bank] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, 'ba_existing'));
    expect(bank).toMatchObject({
      feedConnectionId: id,
      feedProvider: 'plaid',
      feedAccountId: 'acc_feed_1',
      feedAccountFingerprint: 'fp-acc_feed_1',
      feedSyncFrom: '2026-10-01',
      feedStatus: 'active',
      accountType: 'checking',
      accountNumberLast4: '0000',
      bankName: 'First Platypus Bank',
    });
    expect(result.view.accounts.find((a) => a.feedAccountId === 'acc_feed_1')).toMatchObject({ bankAccountId: 'ba_existing', bankAccountName: 'Operating', syncFrom: '2026-10-01' });
  });

  it('creates bank accounts with ledger accounts: checking under the 1000s, a card under liabilities', async () => {
    await db.insert(schema.accounts).values([
      { id: 'acc_1000', entityId: ENTITY, code: '1000', name: 'Checking', type: 'asset', subtype: 'bank', normalSide: 'debit' },
      { id: 'acc_1010', entityId: ENTITY, code: '1010', name: 'Savings', type: 'asset', subtype: 'bank', normalSide: 'debit' },
      { id: 'acc_2100', entityId: ENTITY, code: '2100', name: 'Credit Card Payable', type: 'liability', subtype: 'credit_card', normalSide: 'credit', metadata: { systemRole: 'credit_card_payable' } },
    ]);
    const { ctx, id } = await linkedConnection();

    const result = await mapAccounts(ctx, id, {
      mappings: [
        { feedAccountId: 'acc_feed_1', create: { name: 'Chase Checking' } },
        { feedAccountId: 'acc_card', create: { name: 'Sapphire Card', accountType: 'credit_card' } },
      ],
      syncFrom: '2026-01-01',
    });

    expect(result.mapped.every((m) => m.created)).toBe(true);
    const banks = await db.select().from(schema.bankAccounts);
    const checking = banks.find((b) => b.name === 'Chase Checking');
    const card = banks.find((b) => b.name === 'Sapphire Card');
    expect(checking).toMatchObject({ accountType: 'checking', accountNumberLast4: '0000', currency: 'USD', feedSyncFrom: '2026-01-01', isDefault: true, feedAccountId: 'acc_feed_1' });
    expect(card).toMatchObject({ accountType: 'credit_card', accountNumberLast4: '4242', isDefault: false });

    const ledger = await db.select().from(schema.accounts);
    const checkingLedger = ledger.find((a) => a.id === checking?.ledgerAccountId);
    const cardLedger = ledger.find((a) => a.id === card?.ledgerAccountId);
    expect(checkingLedger).toMatchObject({ code: '1011', type: 'asset', subtype: 'bank', normalSide: 'debit', name: 'Chase Checking' });
    expect(cardLedger).toMatchObject({ code: '2101', type: 'liability', subtype: 'credit_card', normalSide: 'credit', parentAccountId: 'acc_2100' });
  });

  it('refuses double mappings, unknown accounts, and bank accounts linked to another live connection', async () => {
    const { ctx, id } = await linkedConnection();
    await seedBankAccount(db, { id: 'ba_other', entityId: ENTITY, feedConnectionId: 'bkc_other', feedStatus: 'active' });
    await seedBankAccount(db, { id: 'ba_free', entityId: ENTITY });

    await expect(mapAccounts(ctx, id, { mappings: [{ feedAccountId: 'nope', bankAccountId: 'ba_free' }] })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      mapAccounts(ctx, id, { mappings: [{ feedAccountId: 'acc_feed_1', bankAccountId: 'ba_free' }, { feedAccountId: 'acc_card', bankAccountId: 'ba_free' }] }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(mapAccounts(ctx, id, { mappings: [{ feedAccountId: 'acc_feed_1', bankAccountId: 'ba_other' }] })).rejects.toMatchObject({ code: 'conflict' });
    await expect(mapAccounts(ctx, id, { mappings: [{ feedAccountId: 'acc_feed_1' }] })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(mapAccounts(ctx, id, { mappings: [{ feedAccountId: 'acc_feed_1', bankAccountId: 'ba_missing' }] })).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      mapAccounts(ctx, id, { mappings: [{ feedAccountId: 'acc_feed_1', create: { name: 'X', ledgerAccountId: 'acc_elsewhere' } }] }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('allows a bank account left behind by a disconnected connection to be linked again', async () => {
    const { ctx, id } = await linkedConnection();
    await seedBankAccount(db, { id: 'ba_old', entityId: ENTITY, feedConnectionId: 'bkc_dead', feedStatus: 'disconnected' });
    const result = await mapAccounts(ctx, id, { mappings: [{ feedAccountId: 'acc_feed_1', bankAccountId: 'ba_old' }] });
    expect(result.mapped[0]?.bankAccountId).toBe('ba_old');
  });

  it('resets the cursor for newly mapped accounts (so their history is read) but not for a repeat', async () => {
    const { provider, ctx, id } = await linkedConnection();
    await seedBankAccount(db, { id: 'ba_1', entityId: ENTITY });
    await mapAccounts(ctx, id, { mappings: [{ feedAccountId: 'acc_feed_1', bankAccountId: 'ba_1' }] });
    provider.script = [page({ nextCursor: 'cursor-5' })];
    await syncConnection(ctx, id);
    expect((await db.select().from(schema.bankConnections).where(eq(schema.bankConnections.id, id)))[0]?.syncCursor).toBe('cursor-5');

    const repeat = await mapAccounts(ctx, id, { mappings: [{ feedAccountId: 'acc_feed_1', bankAccountId: 'ba_1' }] });
    expect(repeat.needsSync).toBe(false);
    expect((await db.select().from(schema.bankConnections).where(eq(schema.bankConnections.id, id)))[0]?.syncCursor).toBe('cursor-5');

    await seedBankAccount(db, { id: 'ba_2', entityId: ENTITY });
    const added = await mapAccounts(ctx, id, { mappings: [{ feedAccountId: 'acc_card', bankAccountId: 'ba_2' }] });
    expect(added.needsSync).toBe(true);
    expect((await db.select().from(schema.bankConnections).where(eq(schema.bankConnections.id, id)))[0]?.syncCursor).toBeNull();
  });
});

describe('disconnect and delete', () => {
  async function connectedWithData() {
    const provider = new FakeProvider();
    provider.linkResult = linked();
    const ctx = makeContext(db, provider);
    const { view } = await completeLink(ctx, { providerId: 'plaid', payload: {}, entityId: ENTITY, userId: null });
    await mapAccounts(ctx, view.id, { mappings: [{ feedAccountId: 'acc_feed_1', create: { name: 'Checking' } }] });
    provider.script = [page({ upserts: [tx({ providerTransactionId: 't1' })] })];
    await syncConnection(ctx, view.id);
    return { provider, ctx, id: view.id };
  }

  it('revokes at the provider, drops the tokens, keeps every transaction, and stops syncing', async () => {
    const { provider, ctx, id } = await connectedWithData();

    const view = await disconnectConnection(ctx, id);

    expect(provider.disconnected).toHaveLength(1);
    expect(provider.disconnected[0]?.credentials).toEqual({ accessToken: 'access-secret-1' });
    expect(view.status).toBe('disconnected');
    expect(view.accounts[0]?.status).toBe('disconnected');
    const [row] = await db.select().from(schema.bankConnections).where(eq(schema.bankConnections.id, id));
    expect(row?.credentialsEncrypted).toBeNull();
    const [bank] = await db.select().from(schema.bankAccounts);
    expect(bank).toMatchObject({ feedStatus: 'disconnected', feedConnectionId: id });
    expect(await db.select().from(schema.bankTransactions)).toHaveLength(1);
    expect(ctx.index.rows.get('plaid:item_1')?.isActive).toBe(false);
    expect((await syncConnection(ctx, id)).skipped).toBe('not_active');

    // Disconnecting again does not call the provider again.
    await disconnectConnection(ctx, id);
    expect(provider.disconnected).toHaveLength(1);
  });

  it('does not mark the connection disconnected when the provider call fails retryably', async () => {
    const { provider, ctx, id } = await connectedWithData();
    provider.disconnectError = new FeedProviderError('plaid', 'transient', 'Plaid responded 503');
    await expect(disconnectConnection(ctx, id)).rejects.toBeInstanceOf(FeedServiceError);
    const [row] = await db.select().from(schema.bankConnections).where(eq(schema.bankConnections.id, id));
    expect(row?.status).toBe('active');
    expect(row?.credentialsEncrypted).toBeTruthy();
  });

  it('treats an already-gone consent as disconnected', async () => {
    const { provider, ctx, id } = await connectedWithData();
    provider.disconnectError = new FeedProviderError('plaid', 'revoked', 'Plaid ITEM_NOT_FOUND');
    expect((await disconnectConnection(ctx, id)).status).toBe('disconnected');
  });

  it('delete removes the connection and index row, frees the bank account, and keeps transactions', async () => {
    const { provider, ctx, id } = await connectedWithData();

    await deleteConnection(ctx, id);

    expect(provider.disconnected).toHaveLength(1);
    expect(await listConnectionViews(ctx, ENTITY)).toEqual([]);
    const [bank] = await db.select().from(schema.bankAccounts);
    expect(bank).toMatchObject({ feedConnectionId: null, feedAccountId: null, feedStatus: null, feedAccountFingerprint: 'fp-acc_feed_1' });
    expect(await db.select().from(schema.bankTransactions)).toHaveLength(1);
    expect(ctx.index.rows.size).toBe(0);
    await expect(connectionViewById(ctx, id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lists pending transactions of a connection', async () => {
    const { provider, ctx, id } = await connectedWithData();
    provider.script = [page({ upserts: [tx({ providerTransactionId: 'p1', pending: true, amountMinor: -2500, description: 'Hold' })] })];
    await syncConnection(ctx, id);
    const pending = await listPendingTransactions(db, id);
    expect(pending).toEqual([expect.objectContaining({ amount: '-25.00', description: 'Hold', currency: 'USD' })]);
    expect(await listPendingTransactions(db, id, 'ba_other')).toEqual([]);
  });
});

describe('applyFeedEvent', () => {
  async function connectedAndMapped(accounts = [feedAccount({ providerAccountId: 'acc_feed_1' }), feedAccount({ providerAccountId: 'acc_card', fingerprint: 'fp-card' })]) {
    const provider = new FakeProvider();
    provider.linkResult = linked({}, accounts);
    const ctx = makeContext(db, provider);
    const { view } = await completeLink(ctx, { providerId: 'plaid', payload: {}, entityId: ENTITY, userId: null });
    await mapAccounts(ctx, view.id, {
      mappings: [
        { feedAccountId: 'acc_feed_1', create: { name: 'Checking' } },
        { feedAccountId: 'acc_card', create: { name: 'Card' } },
      ],
    });
    return { ctx, id: view.id };
  }

  it('asks for a sync on sync_available, and for none on a finished connection', async () => {
    const { ctx, id } = await connectedAndMapped();
    expect(await applyFeedEvent(ctx, id, { type: 'sync_available', providerConnectionId: 'item_1' })).toMatchObject({ needsSync: true, status: 'active' });
    await disconnectConnection(ctx, id);
    expect((await applyFeedEvent(ctx, id, { type: 'sync_available', providerConnectionId: 'item_1' })).needsSync).toBe(false);
  });

  it('flags the whole connection and its accounts, and deactivates the index, on reauth_required', async () => {
    const { ctx, id } = await connectedAndMapped();

    const result = await applyFeedEvent(ctx, id, { type: 'reauth_required', providerConnectionId: 'item_1', message: 'login' });

    expect(result).toMatchObject({ status: 'reauth_required', changed: true, needsSync: false });
    const [row] = await db.select().from(schema.bankConnections).where(eq(schema.bankConnections.id, id));
    expect(row).toMatchObject({ status: 'reauth_required', lastError: 'login' });
    expect((await db.select().from(schema.bankAccounts)).map((b) => b.feedStatus)).toEqual(['reauth_required', 'reauth_required']);
    expect(ctx.index.rows.get('plaid:item_1')?.isActive).toBe(false);
  });

  it('keeps status per account and rolls it up (one account disconnected, the other still syncing)', async () => {
    const { ctx, id } = await connectedAndMapped();

    const result = await applyFeedEvent(ctx, id, { type: 'disconnected', providerConnectionId: 'item_1', accountIds: ['acc_card'] });

    expect(result.status).toBe('active');
    const banks = await db.select().from(schema.bankAccounts);
    expect(Object.fromEntries(banks.map((b) => [b.feedAccountId, b.feedStatus]))).toEqual({ acc_feed_1: 'active', acc_card: 'disconnected' });
    expect(ctx.index.rows.get('plaid:item_1')?.isActive).toBe(true);

    const other = await applyFeedEvent(ctx, id, { type: 'reauth_required', providerConnectionId: 'item_1', accountIds: ['acc_feed_1'] });
    expect(other.status).toBe('reauth_required');
  });

  it('records the consent expiry and never downgrades a harder state to expiring', async () => {
    const { ctx, id } = await connectedAndMapped();
    await applyFeedEvent(ctx, id, { type: 'expiring', providerConnectionId: 'item_1', expiresAt: '2026-11-01T00:00:00Z' });
    let [row] = await db.select().from(schema.bankConnections).where(eq(schema.bankConnections.id, id));
    expect(row).toMatchObject({ status: 'expiring' });
    expect(row?.consentExpiresAt?.toISOString()).toBe('2026-11-01T00:00:00.000Z');

    await applyFeedEvent(ctx, id, { type: 'revoked', providerConnectionId: 'item_1' });
    await applyFeedEvent(ctx, id, { type: 'expiring', providerConnectionId: 'item_1' });
    [row] = await db.select().from(schema.bankConnections).where(eq(schema.bankConnections.id, id));
    expect(row?.status).toBe('revoked');
  });

  it('ignores events for accounts a relink replaced, and reports a deleted connection', async () => {
    const { ctx, id } = await connectedAndMapped();
    const stale = await applyFeedEvent(ctx, id, { type: 'disconnected', providerConnectionId: 'old', accountIds: ['acc_gone'] });
    expect(stale).toMatchObject({ changed: false, status: 'active' });
    expect(await applyFeedEvent(ctx, 'bkc_missing', { type: 'reauth_required', providerConnectionId: 'x' })).toMatchObject({ missing: true });
  });
});
