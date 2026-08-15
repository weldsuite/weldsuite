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
});
