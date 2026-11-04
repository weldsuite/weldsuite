/**
 * Every /api/parcel-wallet route on pglite: the wallet (created on first
 * read), its transactions, credits and deductions with their JavaScript
 * arithmetic, the balance check and the cost estimate. Runs against Rust in
 * conformance mode.
 *
 * The tests run in order on one database: the default user's wallet is
 * created, credited and charged step by step.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { CONFORMANCE_WRITE_HEADER } from '@weldsuite/worker-kit/testing/conformance';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { parcelWalletRoutes } from './index';

vi.mock('@weldsuite/entity-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/entity-events')>();
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const BASE = '/api/parcel-wallet';
const USER = 'user_test_default';
const { wallets, walletTransactions, shippingPrices } = schema;
const events = vi.mocked(publishEntityEvent);
/** `GET /` creates the wallet it doesn't find: a write for conformance mode. */
const WRITING_GET: RequestInit = { headers: { [CONFORMANCE_WRITE_HEADER]: '1' } };

let db: Database;

const app = (keys: string[], userId = USER) =>
  createTestApp(BASE, parcelWalletRoutes, { context: { permissions: permissions(...keys), tenantDb: db, userId } });
const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const dataOf = async (res: Response) => ((await res.json()) as { data: Record<string, unknown> }).data;
const published = () =>
  events.mock.calls.map(([p]) => ({ entityType: p.entityType, action: p.action, entityId: p.entityId, data: p.data }));
const walletOf = async (userId: string) => (await db.select().from(wallets).where(eq(wallets.userId, userId)))[0];
const transactionsOf = async (walletId: string) =>
  db.select().from(walletTransactions).where(eq(walletTransactions.walletId, walletId)).orderBy(asc(walletTransactions.createdAt));

const WALLET_ID = /^wal_[0-9a-z]+$/;
const TRANSACTION_ID = /^wtx_[0-9a-z]+$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const at = new Date(Date.UTC(2026, 0, 1, 12));
  await db.insert(wallets).values([
    {
      id: 'wal_rich',
      userId: 'user_rich',
      balance: '250.75',
      currency: 'USD',
      creditLimit: '500.00',
      lowBalanceThreshold: '10.00',
      isFrozen: true,
      totalCredits: '300.00',
      totalDebits: '49.25',
      transactionCount: 2,
      lastTransactionAt: new Date(Date.UTC(2026, 0, 3)),
      createdAt: at,
      updatedAt: at,
    },
    { id: 'wal_gone', userId: 'user_gone', balance: '99.00', deletedAt: at, createdAt: at, updatedAt: at },
  ]);
  await db.insert(walletTransactions).values([
    { id: 'wtx_rich1', walletId: 'wal_rich', userId: 'user_rich', type: 'credit', amount: '300.00', balanceBefore: '0.00', balanceAfter: '300.00', currency: 'USD', createdAt: new Date(Date.UTC(2026, 0, 2)) },
    { id: 'wtx_rich2', walletId: 'wal_rich', userId: 'user_rich', type: 'shipping_charge', amount: '49.25', referenceType: 'parcel', referenceId: 'par_9', description: 'Label', createdAt: new Date(Date.UTC(2026, 0, 3)) },
  ]);
  await db.insert(shippingPrices).values([
    { id: 'spr_dhl', name: 'DHL', carrierId: 'crr_dhl', flatRate: { amount: 7.95, currency: 'USD' }, currency: 'GBP' },
    { id: 'spr_gls', name: 'GLS', carrierId: 'crr_gls', currency: 'CHF' },
    { id: 'spr_off', name: 'Off', carrierId: 'crr_off', isActive: false, flatRate: { amount: 1, currency: 'EUR' } },
  ]);
}, 60_000);

beforeEach(() => {
  events.mockClear();
});

describe('before the wallet exists', () => {
  it('GET /with-transactions answers no wallet', async () => {
    const res = await app(['carriers:read']).request(`${BASE}/with-transactions`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { wallet: null, transactions: [] } });
  });

  it('GET /transactions answers an empty first page whatever the page asked', async () => {
    const res = await app(['carriers:read']).request(`${BASE}/transactions?page=3&pageSize=5`);
    expect(await res.json()).toEqual({
      data: { transactions: [], pagination: { page: 1, pageSize: 5, totalCount: 0, totalPages: 0, hasMore: false } },
    });
  });

  it('POST /check-balance counts a missing wallet as 0', async () => {
    const res = await app(['carriers:read']).request(`${BASE}/check-balance`, post({ amount: 5 }));
    expect(res.status).toBe(200);
    expect(await dataOf(res)).toEqual({ hasSufficientBalance: false, currentBalance: 0, required: 5, shortfall: 5 });
  });

  it('POST /deduct refuses without a wallet', async () => {
    const res = await app(['carriers:manage']).request(`${BASE}/deduct`, post({ amount: 1 }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'No wallet found for user' } });
    expect(published()).toEqual([]);
  });
});

describe('GET /api/parcel-wallet', () => {
  it('creates the wallet on first read and publishes created', async () => {
    const res = await app(['carriers:read']).request(BASE, WRITING_GET);
    expect(res.status).toBe(200);
    const data = await dataOf(res);
    // creditLimit, lowBalanceThreshold and lastTransactionAt are left out while unset.
    expect(data).toEqual({
      id: expect.stringMatching(WALLET_ID),
      balance: { amount: 0, currency: 'EUR' },
      isActive: true,
      isFrozen: false,
      totalCredits: 0,
      totalDebits: 0,
      transactionCount: 0,
      createdAt: expect.stringMatching(ISO),
    });
    const wallet = await walletOf(USER);
    expect(wallet).toMatchObject({ id: data.id, balance: '0.00', currency: 'EUR', totalCredits: '0.00', transactionCount: 0 });
    expect(published()).toEqual([
      {
        entityType: 'parcel_wallet',
        action: 'created',
        entityId: expect.stringMatching(WALLET_ID),
        data: { id: expect.stringMatching(WALLET_ID), userId: USER },
      },
    ]);
  });

  it('answers the same wallet afterwards, publishing nothing', async () => {
    const wallet = await walletOf(USER);
    const data = await dataOf(await app(['carriers:read']).request(BASE));
    expect(data.id).toBe(wallet?.id);
    expect(published()).toEqual([]);
  });

  it("reads another user's wallet with ?userId=, every field set", async () => {
    const data = await dataOf(await app(['carriers:read']).request(`${BASE}?userId=user_rich`));
    expect(data).toEqual({
      id: 'wal_rich',
      balance: { amount: 250.75, currency: 'USD' },
      creditLimit: 500,
      lowBalanceThreshold: 10,
      isActive: true,
      isFrozen: true,
      totalCredits: 300,
      totalDebits: 49.25,
      transactionCount: 2,
      lastTransactionAt: '2026-01-03T00:00:00.000Z',
      createdAt: '2026-01-01T12:00:00.000Z',
    });
  });

  it("creates another user's wallet too; a deleted one doesn't count", async () => {
    const res = await app(['carriers:read']).request(`${BASE}?userId=user_gone`, WRITING_GET);
    const data = await dataOf(res);
    expect(data.id).toMatch(WALLET_ID);
    expect(data.id).not.toBe('wal_gone');
    expect(data.balance).toEqual({ amount: 0, currency: 'EUR' });
    expect(published()).toEqual([
      expect.objectContaining({ entityType: 'parcel_wallet', action: 'created', data: expect.objectContaining({ userId: 'user_gone' }) }),
    ]);
  });

  it('needs carriers:read', async () => {
    expect((await app(['carriers:manage']).request(BASE)).status).toBe(403);
    expect((await app(['carriers:manage']).request(`${BASE}/with-transactions`)).status).toBe(403);
    expect((await app(['carriers:manage']).request(`${BASE}/transactions`)).status).toBe(403);
  });
});

describe('POST /api/parcel-wallet/credits and /deduct', () => {
  const credit = async (body: unknown) => app(['carriers:manage']).request(`${BASE}/credits`, post(body));
  const deduct = async (body: unknown) => app(['carriers:manage']).request(`${BASE}/deduct`, post(body));

  it('credits the wallet: a transaction, the totals and an updated event', async () => {
    const res = await credit({ amount: 10.5, paymentMethod: 'card', paymentReference: 'pi_1' });
    expect(res.status).toBe(201);
    const data = await dataOf(res);
    expect(data).toEqual({ newBalance: 10.5, transactionId: expect.stringMatching(TRANSACTION_ID) });
    const wallet = await walletOf(USER);
    expect(wallet).toMatchObject({ balance: '10.50', totalCredits: '10.50', transactionCount: 1 });
    expect(wallet?.lastTransactionAt).toBeInstanceOf(Date);
    const [tx] = await transactionsOf(wallet!.id);
    expect(tx).toMatchObject({
      id: data.transactionId,
      userId: USER,
      type: 'credit',
      amount: '10.50',
      currency: 'EUR',
      balanceBefore: '0.00',
      balanceAfter: '10.50',
      description: 'Added 10.5 credits via card',
      metadata: { paymentReference: 'pi_1' },
      referenceType: null,
    });
    expect(published()).toEqual([
      {
        entityType: 'parcel_wallet',
        action: 'updated',
        entityId: wallet!.id,
        data: { id: wallet!.id, userId: USER, transactionId: expect.stringMatching(TRANSACTION_ID), amount: 10.5, newBalance: 10.5 },
      },
    ]);
  });

  it('adds in JavaScript numbers; the column rounds to cents', async () => {
    expect(await dataOf(await credit({ amount: 0.2, description: 'Top-up' }))).toMatchObject({ newBalance: 10.7 });
    // 10.7 + 0.1
    expect(await dataOf(await credit({ amount: 0.1 }))).toMatchObject({ newBalance: 10.799999999999999 });
    const wallet = await walletOf(USER);
    expect(wallet).toMatchObject({ balance: '10.80', totalCredits: '10.80', transactionCount: 3 });
    const txs = await transactionsOf(wallet!.id);
    expect(txs.map((t) => [t.description, t.metadata])).toEqual([
      ['Added 10.5 credits via card', { paymentReference: 'pi_1' }],
      ['Top-up', null],
      ['Added 0.1 credits via deposit', null],
    ]);
  });

  it('deducts: a debit transaction, the totals and an event with the negative amount', async () => {
    const wallet = await walletOf(USER);
    const res = await deduct({ amount: 3.3, referenceType: 'parcel', referenceId: 'par_1' });
    expect(res.status).toBe(201);
    // 10.8 - 3.3
    expect(await dataOf(res)).toEqual({ newBalance: 7.500000000000001, transactionId: expect.stringMatching(TRANSACTION_ID) });
    expect(published()).toEqual([
      {
        entityType: 'parcel_wallet',
        action: 'updated',
        entityId: wallet!.id,
        data: { id: wallet!.id, userId: USER, transactionId: expect.stringMatching(TRANSACTION_ID), amount: -3.3, newBalance: 7.500000000000001 },
      },
    ]);
    expect(await dataOf(await deduct({ amount: 0.5, referenceId: null, description: 'Adjustment' }))).toMatchObject({ newBalance: 7 });
    expect(await walletOf(USER)).toMatchObject({ balance: '7.00', totalDebits: '3.80', transactionCount: 5 });
    const txs = await transactionsOf(wallet!.id);
    expect(txs.slice(3).map((t) => [t.type, t.amount, t.balanceBefore, t.balanceAfter, t.referenceType, t.referenceId, t.description])).toEqual([
      ['debit', '3.30', '10.80', '7.50', 'parcel', 'par_1', 'Charge of 3.3'],
      ['debit', '0.50', '7.50', '7.00', null, null, 'Adjustment'],
    ]);
  });

  it('refuses a deduction above the balance', async () => {
    const res = await deduct({ amount: 100 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Insufficient balance: have 7, need 100' } });
    expect(published()).toEqual([]);
  });

  it('POST /credits creates a missing wallet itself, without a created event', async () => {
    const res = await app(['carriers:manage'], 'user_fresh').request(`${BASE}/credits`, post({ amount: 25 }));
    expect(res.status).toBe(201);
    expect(await dataOf(res)).toMatchObject({ newBalance: 25 });
    expect(await walletOf('user_fresh')).toMatchObject({ balance: '25.00', totalCredits: '25.00', totalDebits: '0.00', transactionCount: 1 });
    expect(published()).toEqual([expect.objectContaining({ entityType: 'parcel_wallet', action: 'updated' })]);
  });

  it('refuses invalid bodies (400) and callers without carriers:manage (403)', async () => {
    for (const body of [{}, { amount: 0 }, { amount: -1 }, { amount: '5' }, { amount: 5, paymentMethod: 1 }]) {
      expect((await credit(body)).status, `credits ${JSON.stringify(body)}`).toBe(400);
    }
    for (const body of [{}, { amount: 0 }, { amount: 1, referenceType: 2 }, { amount: 1, referenceId: 3 }]) {
      expect((await deduct(body)).status, `deduct ${JSON.stringify(body)}`).toBe(400);
    }
    expect((await app(['carriers:read']).request(`${BASE}/credits`, post({ amount: 1 }))).status).toBe(403);
    expect((await app(['carriers:read']).request(`${BASE}/deduct`, post({ amount: 1 }))).status).toBe(403);
    expect(published()).toEqual([]);
  });
});

describe('the wallet after its transactions', () => {
  it('GET / answers the totals', async () => {
    const data = await dataOf(await app(['carriers:read']).request(BASE));
    expect(data).toMatchObject({
      balance: { amount: 7, currency: 'EUR' },
      totalCredits: 10.8,
      totalDebits: 3.8,
      transactionCount: 5,
      lastTransactionAt: expect.stringMatching(ISO),
    });
  });

  it('GET /with-transactions answers the wallet and its transactions, newest first', async () => {
    const data = await dataOf(await app(['carriers:read']).request(`${BASE}/with-transactions`));
    expect(data.wallet).toEqual({
      id: expect.stringMatching(WALLET_ID),
      balance: { amount: 7, currency: 'EUR' },
      isActive: true,
      isFrozen: false,
      totalCredits: 10.8,
      totalDebits: 3.8,
      transactionCount: 5,
    });
    const txs = data.transactions as Array<Record<string, unknown>>;
    expect(txs.map((t) => [t.type, t.amount, t.balanceBefore, t.balanceAfter, t.description])).toEqual([
      ['debit', { amount: 0.5, currency: 'EUR' }, 7.5, 7, 'Adjustment'],
      ['debit', { amount: 3.3, currency: 'EUR' }, 10.8, 7.5, 'Charge of 3.3'],
      ['credit', { amount: 0.1, currency: 'EUR' }, 10.7, 10.8, 'Added 0.1 credits via deposit'],
      ['credit', { amount: 0.2, currency: 'EUR' }, 10.5, 10.7, 'Top-up'],
      // balanceBefore '0.00' is a non-empty string: 0, not left out.
      ['credit', { amount: 10.5, currency: 'EUR' }, 0, 10.5, 'Added 10.5 credits via card'],
    ]);
    // Unset reference columns are left out.
    expect(txs[1]).toEqual({
      id: expect.stringMatching(TRANSACTION_ID),
      type: 'debit',
      amount: { amount: 3.3, currency: 'EUR' },
      balanceBefore: 10.8,
      balanceAfter: 7.5,
      referenceType: 'parcel',
      referenceId: 'par_1',
      description: 'Charge of 3.3',
      createdAt: expect.stringMatching(ISO),
    });
    // The keys, not their order: the Rust backend writes them sorted.
    expect(Object.keys(txs[0]!).sort()).toEqual(
      ['id', 'type', 'amount', 'balanceBefore', 'balanceAfter', 'description', 'createdAt'].sort(),
    );
  });

  it("GET /with-transactions?userId= reads another user's wallet", async () => {
    const data = await dataOf(await app(['carriers:read']).request(`${BASE}/with-transactions?userId=user_rich`));
    expect(data.wallet).toMatchObject({ id: 'wal_rich', balance: { amount: 250.75, currency: 'USD' } });
    expect(data.transactions).toEqual([
      {
        id: 'wtx_rich2',
        type: 'shipping_charge',
        amount: { amount: 49.25, currency: 'EUR' },
        referenceType: 'parcel',
        referenceId: 'par_9',
        description: 'Label',
        createdAt: '2026-01-03T00:00:00.000Z',
      },
      {
        id: 'wtx_rich1',
        type: 'credit',
        amount: { amount: 300, currency: 'USD' },
        balanceBefore: 0,
        balanceAfter: 300,
        createdAt: '2026-01-02T00:00:00.000Z',
      },
    ]);
  });

  it("GET /transactions pages the current user's transactions", async () => {
    const { request } = app(['carriers:read']);
    type TxPage = { transactions: Array<Record<string, unknown>>; pagination: Record<string, unknown> };
    const page = async (query: string) => (await dataOf(await request(`${BASE}/transactions${query}`))) as unknown as TxPage;
    const first = await page('?page=1&pageSize=2');
    expect(first.transactions.map((t) => [t.type, t.amount, t.currency])).toEqual([
      ['debit', 0.5, 'EUR'],
      ['debit', 3.3, 'EUR'],
    ]);
    expect(first.pagination).toEqual({ page: 1, pageSize: 2, totalCount: 5, totalPages: 3, hasMore: true });
    const last = await page('?page=3&pageSize=2');
    expect(last.transactions.map((t) => t.amount)).toEqual([10.5]);
    expect(last.pagination).toEqual({ page: 3, pageSize: 2, totalCount: 5, totalPages: 3, hasMore: false });
    const beyond = await page('?page=9&pageSize=2');
    expect(beyond).toEqual({ transactions: [], pagination: { page: 9, pageSize: 2, totalCount: 5, totalPages: 3, hasMore: false } });
    // ?userId= is not read here.
    expect((await page('?userId=user_rich')).pagination).toMatchObject({ page: 1, pageSize: 20, totalCount: 5 });
  });

  it('GET /transactions filters by type and date', async () => {
    const { request } = app(['carriers:read']);
    const count = async (query: string) =>
      ((await dataOf(await request(`${BASE}/transactions?${query}`))).pagination as { totalCount: number }).totalCount;
    expect(await count('type=credit')).toBe(3);
    expect(await count('type=debit')).toBe(2);
    expect(await count('type=refund')).toBe(0);
    expect(await count('dateFrom=2000-01-01T00:00:00.000Z')).toBe(5);
    expect(await count('dateFrom=2999-01-01T00:00:00.000Z')).toBe(0);
    expect(await count('dateTo=2000-01-01')).toBe(0);
    expect(await count('type=credit&dateTo=2999-01-01')).toBe(3);
  });

  it('GET /transactions refusals: a bad page (400), a date JavaScript cannot read (500)', async () => {
    const { request } = app(['carriers:read']);
    for (const query of ['page=0', 'pageSize=0', 'pageSize=101', 'pageSize=abc', 'page=-1']) {
      expect((await request(`${BASE}/transactions?${query}`)).status, query).toBe(400);
    }
    const res = await request(`${BASE}/transactions?dateFrom=yesterday`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get transactions' } });
  });

  it('POST /check-balance compares and answers the shortfall', async () => {
    const { request } = app(['carriers:read']);
    expect(await dataOf(await request(`${BASE}/check-balance`, post({ amount: 7 })))).toEqual({
      hasSufficientBalance: true,
      currentBalance: 7,
      required: 7,
      shortfall: 0,
    });
    expect(await dataOf(await request(`${BASE}/check-balance`, post({ amount: 50.25 })))).toEqual({
      hasSufficientBalance: false,
      currentBalance: 7,
      required: 50.25,
      shortfall: 43.25,
    });
    for (const body of [{}, { amount: 0 }, { amount: '5' }]) {
      expect((await request(`${BASE}/check-balance`, post(body))).status, JSON.stringify(body)).toBe(400);
    }
    expect((await app(['carriers:manage']).request(`${BASE}/check-balance`, post({ amount: 1 }))).status).toBe(403);
  });
});

describe('POST /api/parcel-wallet/estimate-cost', () => {
  const estimate = async (body: Record<string, unknown>) => {
    const res = await app(['carriers:read']).request(`${BASE}/estimate-cost`, post(body));
    expect(res.status, JSON.stringify(body)).toBe(200);
    return dataOf(res);
  };
  const route = { fromCountry: 'NL', toCountry: 'BE', weight: 2 };

  it("answers an active price's flat rate", async () => {
    expect(await estimate({ ...route, carrierId: 'crr_dhl' })).toEqual({
      estimatedCost: 7.95,
      currency: 'USD',
      breakdown: { basePrice: 7.95, weightCharge: 0 },
    });
    // No flat rate: 0 in the price's currency.
    expect(await estimate({ ...route, carrierId: 'crr_gls' })).toEqual({
      estimatedCost: 0,
      currency: 'CHF',
      breakdown: { basePrice: 0, weightCharge: 0 },
    });
  });

  it('falls back to a formula without an active price', async () => {
    const formula = (estimatedCost: number) => ({ estimatedCost, currency: 'EUR', breakdown: { basePrice: estimatedCost, weightCharge: 0 } });
    // International: 25 + 2 × weight.
    expect(await estimate({ ...route, carrierId: 'crr_off' })).toEqual(formula(29));
    expect(await estimate({ ...route, carrierId: 'crr_none', serviceType: 'EXPRESS' })).toEqual(formula(43.5));
    expect(await estimate({ ...route, carrierId: 'crr_none', serviceType: 'OVERNIGHT' })).toEqual(formula(58));
    // Case matters.
    expect(await estimate({ ...route, carrierId: 'crr_none', serviceType: 'express' })).toEqual(formula(29));
    // Domestic: 10 + 2 × weight; the weight is coerced from a string.
    expect(await estimate({ carrierId: 'crr_none', fromCountry: 'NL', toCountry: 'NL', weight: '1.25' })).toEqual(formula(12.5));
  });

  it('refuses invalid bodies (400) and callers without carriers:read (403)', async () => {
    const { request } = app(['carriers:read']);
    for (const body of [
      {},
      { ...route },
      { ...route, carrierId: 'crr_dhl', weight: 0 },
      { ...route, carrierId: 'crr_dhl', weight: 'heavy' },
      { ...route, carrierId: 'crr_dhl', toCountry: undefined },
      { ...route, carrierId: 'crr_dhl', serviceType: 1 },
    ]) {
      expect((await request(`${BASE}/estimate-cost`, post(body))).status, JSON.stringify(body)).toBe(400);
    }
    expect((await app(['carriers:manage']).request(`${BASE}/estimate-cost`, post({ ...route, carrierId: 'crr_dhl' }))).status).toBe(403);
  });
});
