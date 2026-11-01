/**
 * /api/bank-deposits (pglite): received checks and cash waiting in
 * Undeposited Funds, one deposit posting them to the bank (with other lines
 * on the slip), the list with its cursor and filters, the detail, the memo,
 * voiding (entry reversed, payments and the bank line released), and the
 * refusals.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingEntitiesRoutes } from '../accounting-entities';
import { bankAccountsRoutes } from '../bank-accounts';
import { bankTransactionsRoutes } from '../bank-transactions';
import { bankDepositsRoutes } from './index';
import { recordPayment } from '../../services/accounting-payments';

let db: Database;
let entityId = '';
let bareEntityId = '';
let headerEntity = '';
let bankId = '';
let dollarBankId = '';
let looseBankId = '';
let incomeId = '';
let expenseId = '';
const paymentIds: string[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(mount: string, routes: Hono<any>, path: string, method = 'GET', body?: unknown, perms: string[] = ['*']) {
  const { request } = createTestApp(mount, routes, { context: { permissions: permissions(...perms), tenantDb: db } });
  const res = await request(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(headerEntity ? { 'X-Accounting-Entity-Id': headerEntity } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = res.status === 204 ? '' : await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = text ? (JSON.parse(text) as { data?: any; error?: { message: string }; pagination?: any }) : {};
  return { status: res.status, ...json };
}

const deposits = (path = '', method = 'GET', body?: unknown, perms?: string[]) =>
  call('/api/bank-deposits', bankDepositsRoutes, `/api/bank-deposits${path}`, method, body, perms);

async function entity(name: string) {
  const created = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', 'POST', {
    name,
    jurisdictionCode: 'NL',
    vatNumber: 'NL123456789B01',
    taxIdentifiers: { registrationNumber: '12345678' },
    bankDetails: { iban: 'NL91ABNA0417164300' },
    address: { line1: 'Damrak 1', postalCode: '1012 LG', city: 'Amsterdam', country: 'NL' },
  });
  expect(created.status).toBe(201);
  return created.data.id as string;
}

async function accountOf(type: string, subtype?: string) {
  const [row] = await db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.entityId, entityId), eq(schema.accounts.type, type), ...(subtype ? [eq(schema.accounts.subtype, subtype)] : [])))
    .limit(1);
  return row!.id;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  entityId = await entity('Deposits BV');
  bareEntityId = await entity('No Undeposited BV');
  headerEntity = entityId;
  const now = new Date();
  await db.insert(schema.accounts).values({
    id: 'acc_dep_undeposited',
    entityId,
    code: '1155',
    name: 'Undeposited Funds',
    type: 'asset',
    subtype: 'current_assets',
    normalSide: 'debit',
    isSystemAccount: true,
    metadata: { systemRole: 'undeposited_funds' },
    currency: 'EUR',
    createdAt: now,
    updatedAt: now,
  });
  incomeId = await accountOf('revenue');
  expenseId = await accountOf('expense');
  const ledger = await accountOf('asset', 'bank');
  bankId = (await call('/api/bank-accounts', bankAccountsRoutes, '/api/bank-accounts', 'POST', { name: 'Main', currency: 'EUR', ledgerAccountId: ledger, autoReconcile: false })).data.id;
  dollarBankId = (await call('/api/bank-accounts', bankAccountsRoutes, '/api/bank-accounts', 'POST', { name: 'Dollars', currency: 'USD', ledgerAccountId: ledger })).data.id;
  looseBankId = (await call('/api/bank-accounts', bankAccountsRoutes, '/api/bank-accounts', 'POST', { name: 'Loose', currency: 'EUR' })).data.id;

  await db.insert(schema.parties).values([
    { id: 'pty_dep_a', kind: 'company', displayName: 'Alpha Retail', createdAt: now, updatedAt: now },
    { id: 'pty_dep_b', kind: 'company', displayName: 'Beta Shop', createdAt: now, updatedAt: now },
  ]);
  for (const [amount, method, check, contact, day] of [
    [100, 'check', '501', 'pty_dep_a', '2026-03-01'],
    [100, 'check', '502', 'pty_dep_b', '2026-03-02'],
    [45.5, 'cash', null, 'pty_dep_a', '2026-03-03'],
  ] as const) {
    const recorded = await recordPayment(db, {
      entityId,
      type: 'received',
      amount,
      currency: 'EUR',
      date: new Date(`${day}T00:00:00Z`),
      paymentMethod: method,
      checkNumber: check,
      contactId: contact,
      allocations: [],
      userId: null,
    });
    paymentIds.push(recorded.paymentId);
  }
}, 120_000);

describe('undeposited funds', () => {
  it('lists the received payments waiting to be deposited', async () => {
    const res = await deposits('/undeposited');
    expect(res.status).toBe(200);
    expect(res.data.map((p: { paymentId: string }) => p.paymentId)).toEqual(paymentIds);
    expect(res.data[0]).toMatchObject({ amount: 100, checkNumber: '501', contactName: 'Alpha Retail', paymentMethod: 'check' });
    expect(res.pagination).toEqual({ totalCount: 3, hasMore: false, cursor: null });
  });

  it('is empty without an Undeposited Funds account or an entity', async () => {
    headerEntity = bareEntityId;
    expect((await deposits('/undeposited')).data).toEqual([]);
    const refused = await deposits('', 'POST', { bankAccountId: bankId, date: '2026-03-05', paymentIds: [paymentIds[0]] });
    expect(refused.status).toBe(400);
    expect(refused.error?.message).toBe('This accounting entity has no Undeposited Funds account');
    headerEntity = 'ent_missing';
    expect((await deposits('/undeposited')).data).toEqual([]);
    expect((await deposits('')).data).toEqual([]);
    expect((await deposits('', 'POST', { bankAccountId: bankId, date: '2026-03-05' })).status).toBe(400);
    expect((await deposits('/dep_x')).status).toBe(400);
    expect((await deposits('/dep_x', 'PATCH', { memo: null })).status).toBe(400);
    expect((await deposits('/dep_x', 'DELETE')).status).toBe(400);
    headerEntity = entityId;
  });
});

describe('making a deposit', () => {
  let depositId = '';

  it('refuses what cannot be deposited', async () => {
    const empty = await deposits('', 'POST', { bankAccountId: bankId, date: '2026-03-05' });
    expect(empty.error?.message).toBe('Pick at least one payment to deposit');
    const unknown = await deposits('', 'POST', { bankAccountId: bankId, date: '2026-03-05', paymentIds: ['pay_missing'] });
    expect(unknown.status).toBe(400);
    expect((await deposits('', 'POST', { bankAccountId: looseBankId, date: '2026-03-05', paymentIds })).status).toBe(400);
    expect((await deposits('', 'POST', { bankAccountId: dollarBankId, date: '2026-03-05', paymentIds })).status).toBe(400);
    expect((await deposits('', 'POST', { bankAccountId: 'ba_missing', date: '2026-03-05', paymentIds })).status).toBe(400);
    const badLine = await deposits('', 'POST', { bankAccountId: bankId, date: '2026-03-05', otherLines: [{ accountId: 'acc_missing', amount: 5 }] });
    expect(badLine.status).toBe(400);
    const selfLine = await deposits('', 'POST', { bankAccountId: bankId, date: '2026-03-05', otherLines: [{ accountId: 'acc_dep_undeposited', amount: 5 }] });
    expect(selfLine.status).toBe(400);
    const zero = await deposits('', 'POST', { bankAccountId: bankId, date: '2026-03-05', otherLines: [{ accountId: incomeId, amount: 0 }] });
    expect(zero.error?.message).toBe('Other deposit lines need a non-zero amount');
    const negative = await deposits('', 'POST', { bankAccountId: bankId, date: '2026-03-05', otherLines: [{ accountId: expenseId, amount: -5 }] });
    expect(negative.error?.message).toBe('The deposit total must be greater than zero');
  });

  it('validates the body and the permission', async () => {
    expect((await deposits('', 'POST', { bankAccountId: bankId, date: '03/05/2026', paymentIds })).status).toBe(400);
    expect((await deposits('', 'POST', { bankAccountId: '', date: '2026-03-05', paymentIds: [''], otherLines: [{ accountId: incomeId, amount: 'x' }] })).status).toBe(400);
    expect((await deposits('', 'POST', { bankAccountId: bankId, date: '2026-03-05', paymentIds }, ['banking:read'])).status).toBe(403);
  });

  it('posts the slip: the bank for the total, Undeposited Funds per payment, the other lines', async () => {
    const res = await deposits('', 'POST', {
      bankAccountId: bankId,
      date: '2026-03-05T09:00:00',
      paymentIds: [paymentIds[0], paymentIds[1], paymentIds[0]],
      otherLines: [
        { accountId: incomeId, amount: 20, description: 'Refund from supplier' },
        { accountId: expenseId, amount: -5 },
      ],
      memo: ' Friday run ',
    });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ amount: '215.00', journalEntryId: expect.stringMatching(/^je_/) });
    depositId = res.data.id;
    const waiting = await deposits('/undeposited');
    expect(waiting.data.map((p: { paymentId: string }) => p.paymentId)).toEqual([paymentIds[2]]);
  });

  it('reads the deposit with its payments and other lines', async () => {
    const res = await deposits(`/${depositId}`);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ id: depositId, amount: '215.00', memo: 'Friday run', bankAccountName: 'Main', status: 'posted', date: '2026-03-05' });
    expect(res.data.payments).toHaveLength(2);
    expect(res.data.otherLines[0]).toMatchObject({ accountId: incomeId, amount: 20, description: 'Refund from supplier' });
    expect(res.data.otherLines[1].accountName).toBeTruthy();
    expect((await deposits('/dep_missing')).status).toBe(404);
  });

  it('pages the deposits with a cursor and filters them', async () => {
    const second = await deposits('', 'POST', { bankAccountId: bankId, date: '2026-03-06', paymentIds: [paymentIds[2]] });
    expect(second.status).toBe(201);
    const first = await deposits('?limit=1');
    expect(first.data).toHaveLength(1);
    expect(first.pagination).toMatchObject({ totalCount: 2, hasMore: true });
    const next = await deposits(`?limit=1&cursor=${first.pagination.cursor}`);
    expect(next.data[0].id).toBe(depositId);
    expect(next.pagination.hasMore).toBe(false);
    expect((await deposits('?cursor=@@@')).status).toBe(400);
    const filtered = await deposits(`?bankAccountId=${bankId}&status=posted&from=2026-03-06&to=2026-03-31&limit=0`);
    expect(filtered.data.map((d: { id: string }) => d.id)).toEqual([second.data.id]);
    expect((await deposits('', 'GET', undefined, ['invoices:read'])).status).toBe(403);
  });

  it('changes only the memo', async () => {
    const res = await deposits(`/${depositId}`, 'PATCH', { memo: '  Monday run ' });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ id: depositId, memo: 'Monday run', amount: '215.00' });
    const cleared = await deposits(`/${depositId}`, 'PATCH', { memo: null });
    expect(cleared.data.memo).toBeNull();
    expect((await deposits(`/${depositId}`, 'PATCH', {})).status).toBe(400);
    expect((await deposits('/dep_missing', 'PATCH', { memo: 'x' })).status).toBe(404);
    expect((await deposits(`/${depositId}`, 'PATCH', { memo: 'x' }, ['banking:read'])).status).toBe(403);
  });

  it('voids: entry reversed, payments back in Undeposited Funds, the bank line released', async () => {
    const line = await call('/api/bank-transactions', bankTransactionsRoutes, '/api/bank-transactions', 'POST', {
      bankAccountId: bankId,
      date: '2026-03-07',
      amount: 215,
      description: 'Deposit',
    });
    const matched = await call('/api/bank-transactions', bankTransactionsRoutes, `/api/bank-transactions/${line.data.id}/match-deposit`, 'POST', { depositId });
    expect(matched.status).toBe(200);

    expect((await deposits(`/${depositId}`, 'DELETE')).status).toBe(204);
    const [released] = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.id, line.data.id)).limit(1);
    expect(released?.status).toBe('unreconciled');
    const waiting = await deposits('/undeposited');
    expect(waiting.data).toHaveLength(2);
    const again = await deposits(`/${depositId}`, 'DELETE');
    expect(again.status).toBe(400);
    expect(again.error?.message).toBe('This deposit has already been voided');
    expect((await deposits('/dep_missing', 'DELETE')).status).toBe(404);
  });
});
