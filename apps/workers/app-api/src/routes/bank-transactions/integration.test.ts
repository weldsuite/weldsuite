/**
 * DB-backed integration tests for /api/bank-transactions.
 *
 * Pins the manual-create contract: a cashbook line can be posted without
 * an import file, lands as unreconciled, and updates the bank account
 * running balance.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { bankTransactionsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

async function seedBankAccount(id: string, balance = '100.00') {
  await db.insert(schema.bankAccounts).values({
    id,
    entityId: 'ent_manual_bt',
    name: 'Checking',
    currency: 'EUR',
    currentBalance: balance,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe('/api/bank-transactions · pglite integration', () => {
  it('POST / writes an unreconciled transaction and updates the account balance', async () => {
    await seedBankAccount('ba_manual_in');
    const { request } = createTestApp('/api/bank-transactions', bankTransactionsRoutes, {
      context: { permissions: permissions('banking:create'), tenantDb: db },
    });

    const res = await request('/api/bank-transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bankAccountId: 'ba_manual_in',
        date: '2026-08-15',
        amount: 50.25,
        description: 'Client payment',
        counterpartyName: 'Acme BV',
        counterpartyIban: 'nl91 abna 0417 1643 00',
        reference: 'INV-100',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { id: string; amount: string; status: string; runningBalance: string; counterpartyIban: string | null };
    };
    expect(body.data.id).toMatch(/^bt_/);
    expect(body.data.amount).toBe('50.25');
    expect(body.data.status).toBe('unreconciled');
    expect(body.data.runningBalance).toBe('150.25');
    expect(body.data.counterpartyIban).toBe('NL91ABNA0417164300');

    const [row] = await db
      .select()
      .from(schema.bankTransactions)
      .where(eq(schema.bankTransactions.id, body.data.id))
      .limit(1);
    expect(row?.description).toBe('Client payment');
    expect(row?.entityId).toBe('ent_manual_bt');
    expect(row?.importBatchId).toBeNull();
    expect((row?.rawData as { source?: string } | null)?.source).toBe('manual');

    const [account] = await db
      .select()
      .from(schema.bankAccounts)
      .where(eq(schema.bankAccounts.id, 'ba_manual_in'))
      .limit(1);
    expect(account?.currentBalance).toBe('150.25');
  });

  it('POST / stores outgoing amounts as negative', async () => {
    await seedBankAccount('ba_manual_out', '200.00');
    const { request } = createTestApp('/api/bank-transactions', bankTransactionsRoutes, {
      context: { permissions: permissions('banking:create'), tenantDb: db },
    });

    const res = await request('/api/bank-transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bankAccountId: 'ba_manual_out',
        date: '2026-08-16',
        amount: -80,
        description: 'Office rent',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { amount: string; runningBalance: string } };
    expect(body.data.amount).toBe('-80.00');
    expect(body.data.runningBalance).toBe('120.00');
  });

  it('POST / returns 404 when the bank account does not exist', async () => {
    const { request } = createTestApp('/api/bank-transactions', bankTransactionsRoutes, {
      context: { permissions: permissions('banking:create'), tenantDb: db },
    });
    const res = await request('/api/bank-transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bankAccountId: 'ba_missing',
        date: '2026-08-15',
        amount: 10,
      }),
    });
    expect(res.status).toBe(404);
  });

  it('POST / returns 400 when amount is zero', async () => {
    const { request } = createTestApp('/api/bank-transactions', bankTransactionsRoutes, {
      context: { permissions: permissions('banking:create'), tenantDb: db },
    });
    const res = await request('/api/bank-transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bankAccountId: 'ba_manual_in',
        date: '2026-08-15',
        amount: 0,
      }),
    });
    expect(res.status).toBe(400);
  });

  it('POST / returns 400 when required fields are missing', async () => {
    const { request } = createTestApp('/api/bank-transactions', bankTransactionsRoutes, {
      context: { permissions: permissions('banking:create'), tenantDb: db },
    });
    const res = await request('/api/bank-transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'no account' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST / with categoryAccountId posts a journal entry and reconciles', async () => {
    await db.insert(schema.accounts).values([
      {
        id: 'acc_bank_cat',
        entityId: 'ent_cat_bt',
        code: '1100',
        name: 'Bank',
        type: 'asset',
        subtype: 'bank',
        normalSide: 'debit',
        currentBalance: '0',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'acc_other_income_cat',
        entityId: 'ent_cat_bt',
        code: '8100',
        name: 'Other income',
        type: 'revenue',
        subtype: 'other_income',
        normalSide: 'credit',
        currentBalance: '0',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    await db.insert(schema.bankAccounts).values({
      id: 'ba_cat_in',
      entityId: 'ent_cat_bt',
      name: 'PayPal',
      currency: 'EUR',
      currentBalance: '0.00',
      ledgerAccountId: 'acc_bank_cat',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { request } = createTestApp('/api/bank-transactions', bankTransactionsRoutes, {
      context: { permissions: permissions('banking:create'), tenantDb: db },
    });

    const res = await request('/api/bank-transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bankAccountId: 'ba_cat_in',
        date: '2026-09-10',
        amount: 42.5,
        description: 'PayPal fee refund settlement',
        counterpartyName: 'PayPal',
        categoryAccountId: 'acc_other_income_cat',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { id: string; status: string; journalEntryId: string | null };
    };
    expect(body.data.status).toBe('reconciled');
    expect(body.data.journalEntryId).toMatch(/^je_/);

    const [txn] = await db
      .select()
      .from(schema.bankTransactions)
      .where(eq(schema.bankTransactions.id, body.data.id))
      .limit(1);
    expect(txn?.status).toBe('reconciled');
    expect(txn?.reconciliationType).toBe('manual');
    expect(txn?.categoryAccountId).toBe('acc_other_income_cat');
    expect(txn?.journalEntryId).toBe(body.data.journalEntryId);

    const [entry] = await db
      .select()
      .from(schema.journalEntries)
      .where(eq(schema.journalEntries.id, body.data.journalEntryId!))
      .limit(1);
    expect(entry?.status).toBe('posted');
    expect(entry?.sourceType).toBe('bank_transaction');
    expect(entry?.sourceId).toBe(body.data.id);
    expect(entry?.totalDebit).toBe('42.50');
    expect(entry?.totalCredit).toBe('42.50');

    const lines = await db
      .select()
      .from(schema.journalLines)
      .where(eq(schema.journalLines.journalEntryId, body.data.journalEntryId!));
    const byAccount = Object.fromEntries(lines.map((l) => [l.accountId, l]));
    expect(byAccount.acc_bank_cat?.debit).toBe('42.50');
    expect(byAccount.acc_bank_cat?.credit).toBe('0.00');
    expect(byAccount.acc_other_income_cat?.debit).toBe('0.00');
    expect(byAccount.acc_other_income_cat?.credit).toBe('42.50');

    const [bankGl] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, 'acc_bank_cat')).limit(1);
    const [incomeGl] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, 'acc_other_income_cat')).limit(1);
    expect(Number(bankGl?.currentBalance)).toBe(42.5);
    expect(Number(incomeGl?.currentBalance)).toBe(-42.5);
  });

  it('POST / returns 400 when categorizing without a linked ledger account', async () => {
    await seedBankAccount('ba_cat_nogl');
    const { request } = createTestApp('/api/bank-transactions', bankTransactionsRoutes, {
      context: { permissions: permissions('banking:create'), tenantDb: db },
    });
    const res = await request('/api/bank-transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bankAccountId: 'ba_cat_nogl',
        date: '2026-09-10',
        amount: 10,
        categoryAccountId: 'acc_other_income_cat',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /:id/reconcile type=manual posts money-out to an expense account', async () => {
    await db.insert(schema.accounts).values([
      {
        id: 'acc_bank_out',
        entityId: 'ent_cat_out',
        code: '1100',
        name: 'Bank',
        type: 'asset',
        subtype: 'bank',
        normalSide: 'debit',
        currentBalance: '200',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'acc_bank_fees',
        entityId: 'ent_cat_out',
        code: '4650',
        name: 'Bank fees',
        type: 'expense',
        subtype: 'operating_expense',
        normalSide: 'debit',
        currentBalance: '0',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    await db.insert(schema.bankAccounts).values({
      id: 'ba_cat_out',
      entityId: 'ent_cat_out',
      name: 'PayPal',
      currency: 'EUR',
      currentBalance: '200.00',
      ledgerAccountId: 'acc_bank_out',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.bankTransactions).values({
      id: 'bt_cat_out',
      entityId: 'ent_cat_out',
      bankAccountId: 'ba_cat_out',
      date: new Date('2026-09-10'),
      amount: '-12.00',
      description: 'PayPal fee',
      status: 'unreconciled',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { request } = createTestApp('/api/bank-transactions', bankTransactionsRoutes, {
      context: { permissions: permissions('banking:update'), tenantDb: db },
    });
    const res = await request('/api/bank-transactions/bt_cat_out/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'manual', categoryAccountId: 'acc_bank_fees' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string; journalEntryId: string } };
    expect(body.data.status).toBe('reconciled');
    expect(body.data.journalEntryId).toMatch(/^je_/);

    const lines = await db
      .select()
      .from(schema.journalLines)
      .where(eq(schema.journalLines.journalEntryId, body.data.journalEntryId));
    const byAccount = Object.fromEntries(lines.map((l) => [l.accountId, l]));
    expect(byAccount.acc_bank_fees?.debit).toBe('12.00');
    expect(byAccount.acc_bank_out?.credit).toBe('12.00');
    expect(byAccount.acc_bank_fees?.credit).toBe('0.00');
    expect(byAccount.acc_bank_out?.debit).toBe('0.00');
  });

  it('POST /:id/reconcile type=manual without categoryAccountId returns 400', async () => {
    await seedBankAccount('ba_cat_manual_missing');
    await db.insert(schema.bankTransactions).values({
      id: 'bt_cat_missing',
      entityId: 'ent_manual_bt',
      bankAccountId: 'ba_cat_manual_missing',
      date: new Date('2026-09-10'),
      amount: '5.00',
      status: 'unreconciled',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { request } = createTestApp('/api/bank-transactions', bankTransactionsRoutes, {
      context: { permissions: permissions('banking:update'), tenantDb: db },
    });
    const res = await request('/api/bank-transactions/bt_cat_missing/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'manual' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST / returns 403 without banking:create', async () => {
    const { request } = createTestApp('/api/bank-transactions', bankTransactionsRoutes, {
      context: { permissions: permissions('banking:read'), tenantDb: db },
    });
    const res = await request('/api/bank-transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bankAccountId: 'ba_manual_in',
        date: '2026-08-15',
        amount: 10,
      }),
    });
    expect(res.status).toBe(403);
  });
});
