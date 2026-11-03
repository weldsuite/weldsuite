/**
 * /api/bank-reconciliations (pglite): start a statement reconciliation,
 * tick lines (saved progress), the live report, finish at a zero difference
 * or by posting the difference, the stored report and history, undo of the
 * latest only, discarding, a credit card's flipped signs, an entry and its
 * reversal set aside together, and the refusals.
 *
 * The ledger lines come from bank lines posted straight to an account
 * (`POST /api/bank-transactions` with `categoryAccountId`).
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
import { bankReconciliationsRoutes } from './index';

let db: Database;
let entityId = '';
let headerEntity = '';
let bankId = '';
let cardId = '';
let looseId = '';
let incomeId = '';
let expenseId = '';
const lineOf: Record<string, string> = {};

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
  const json = text ? (JSON.parse(text) as { data?: any; error?: { message: string; details?: any }; pagination?: any }) : {};
  return { status: res.status, ...json };
}

const recs = (path = '', method = 'GET', body?: unknown, perms?: string[]) =>
  call('/api/bank-reconciliations', bankReconciliationsRoutes, `/api/bank-reconciliations${path}`, method, body, perms);

/** Post a bank line straight to an account; its ledger line on the bank ledger, by key. */
async function post(key: string, bankAccountId: string, date: string, amount: number, categoryAccountId: string) {
  const res = await call('/api/bank-transactions', bankTransactionsRoutes, '/api/bank-transactions', 'POST', {
    bankAccountId,
    date,
    amount,
    description: key,
    categoryAccountId,
  });
  expect(res.status).toBe(201);
  const [bank] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, bankAccountId)).limit(1);
  const [line] = await db
    .select()
    .from(schema.journalLines)
    .where(and(eq(schema.journalLines.journalEntryId, res.data.journalEntryId), eq(schema.journalLines.accountId, bank!.ledgerAccountId!)))
    .limit(1);
  lineOf[key] = line!.id;
  return res.data.id as string;
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
  const created = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', 'POST', {
    name: 'Reconcile BV',
    jurisdictionCode: 'NL',
    vatNumber: 'NL123456789B01',
    taxIdentifiers: { registrationNumber: '12345678' },
    bankDetails: { iban: 'NL91ABNA0417164300' },
    address: { line1: 'Damrak 1', postalCode: '1012 LG', city: 'Amsterdam', country: 'NL' },
  });
  entityId = created.data.id;
  headerEntity = entityId;
  incomeId = await accountOf('revenue');
  expenseId = await accountOf('expense');
  const ledger = await accountOf('asset', 'bank');
  bankId = (await call('/api/bank-accounts', bankAccountsRoutes, '/api/bank-accounts', 'POST', { name: 'Main', currency: 'EUR', ledgerAccountId: ledger })).data.id;
  cardId = (await call('/api/bank-accounts', bankAccountsRoutes, '/api/bank-accounts', 'POST', { name: 'Card', currency: 'EUR', accountType: 'credit_card' })).data.id;
  looseId = (await call('/api/bank-accounts', bankAccountsRoutes, '/api/bank-accounts', 'POST', { name: 'Loose', currency: 'EUR' })).data.id;

  await post('in500', bankId, '2026-01-05', 500, incomeId);
  await post('out120', bankId, '2026-01-10', -120, expenseId);
  await post('out30', bankId, '2026-01-20', -30, expenseId);
  await post('in80', bankId, '2026-02-05', 80, incomeId);
  await post('charge40', cardId, '2026-01-12', -40, expenseId);
}, 120_000);

describe('a statement reconciliation', () => {
  let firstId = '';
  let secondId = '';

  it('starts with the open lines up to the statement date', async () => {
    const res = await recs('', 'POST', { bankAccountId: bankId, statementDate: '2026-01-31', statementEndingBalance: '350.00', beginningBalance: 0 });
    expect(res.status).toBe(201);
    firstId = res.data.id;
    expect(res.data).toMatchObject({ status: 'in_progress', beginningBalance: '0.00', statementEndingBalance: '350.00', clearedBalance: '0.00', difference: '350.00', accountKind: 'bank', bankAccountName: 'Main' });
    expect(res.data.inflows.map((l: { id: string }) => l.id)).toEqual([lineOf.in500]);
    expect(res.data.outflows.map((l: { id: string }) => l.id)).toEqual([lineOf.out120, lineOf.out30]);
    expect(res.data.inflows[0].document).toMatchObject({ type: 'bank_transaction' });
  });

  it('refuses a second open one, and bad starts', async () => {
    const conflict = await recs('', 'POST', { bankAccountId: bankId, statementDate: '2026-01-31', statementEndingBalance: 1 });
    expect(conflict.status).toBe(409);
    expect(conflict.error?.details).toEqual({ reconciliationId: firstId });
    expect((await recs('', 'POST', { bankAccountId: looseId, statementDate: '2026-01-31', statementEndingBalance: 1 })).status).toBe(400);
    expect((await recs('', 'POST', { bankAccountId: 'ba_missing', statementDate: '2026-01-31', statementEndingBalance: 1 })).status).toBe(400);
    expect((await recs('', 'POST', { bankAccountId: bankId, statementDate: '31-01-2026', statementEndingBalance: '1.234' })).status).toBe(400);
    expect((await recs('', 'POST', { bankAccountId: bankId, statementDate: '2026-01-31', statementEndingBalance: true })).status).toBe(400);
    expect((await recs('', 'POST', { bankAccountId: bankId, statementDate: '2026-01-31', statementEndingBalance: 1 }, ['banking:read'])).status).toBe(403);
  });

  it('saves the ticked lines and shows the live report', async () => {
    const saved = await recs(`/${firstId}`, 'PATCH', { clearedLineIds: [lineOf.in500, lineOf.out120, lineOf.in500] });
    expect(saved.status).toBe(200);
    expect(saved.data).toMatchObject({ clearedBalance: '380.00', difference: '-30.00', clearedLineIds: [lineOf.in500, lineOf.out120] });
    expect(saved.data.totals.outflows).toMatchObject({ count: 2, clearedCount: 1, clearedTotal: 120 });
    const unknown = await recs(`/${firstId}`, 'PATCH', { clearedLineIds: [lineOf.in80] });
    expect(unknown.status).toBe(400);
    const moved = await recs(`/${firstId}`, 'PATCH', { statementEndingBalance: 350, statementDate: '2026-01-30' });
    expect(moved.data.statementDate).toBe('2026-01-30');
    const preview = await recs(`/${firstId}/report`);
    expect(preview.status).toBe(200);
    expect(preview.data).toMatchObject({ status: 'in_progress', preview: true, version: 1 });
    expect(preview.data.summary.unclearedAfterStatementInflows.count).toBe(1);
    const read = await recs(`/${firstId}`);
    expect(read.data.clearedLineIds).toHaveLength(2);
  });

  it('finishes only at a zero difference, then stores the report', async () => {
    const short = await recs(`/${firstId}/complete`, 'POST', {});
    expect(short.status).toBe(400);
    expect(short.error?.message).toBe('The difference is -30.00. It must be 0.00 to finish: tick the lines that cleared, or post the difference to an account.');
    const done = await recs(`/${firstId}/complete`, 'POST', { clearedLineIds: [lineOf.in500, lineOf.out120, lineOf.out30] });
    expect(done.status).toBe(200);
    expect(done.data).toMatchObject({ status: 'completed', clearedBalance: '350.00', difference: '0.00', adjustmentJournalEntryId: null });
    const [stamped] = await db.select().from(schema.journalLines).where(eq(schema.journalLines.id, lineOf.out30)).limit(1);
    expect(stamped?.reconciliationId).toBe(firstId);
    const report = await recs(`/${firstId}/report`);
    expect(report.data).toMatchObject({ status: 'completed', version: 1, summary: { clearedBalance: 350, difference: 0 } });
    expect((await recs(`/${firstId}/complete`, 'POST', {})).status).toBe(400);
    expect((await recs(`/${firstId}`, 'PATCH', { clearedLineIds: [] })).status).toBe(400);
  });

  it('starts the next one where the last ended, and posts a difference to an account', async () => {
    expect((await recs('', 'POST', { bankAccountId: bankId, statementDate: '2026-01-15', statementEndingBalance: 1 })).status).toBe(400);
    const next = await recs('', 'POST', { bankAccountId: bankId, statementDate: '2026-02-28', statementEndingBalance: '400', beginningBalance: 999 });
    expect(next.status).toBe(201);
    secondId = next.data.id;
    expect(next.data.beginningBalance).toBe('350.00');
    expect((await recs(`/${secondId}`, 'PATCH', { statementDate: '2026-01-20' })).status).toBe(400);
    expect((await recs(`/${secondId}/complete`, 'POST', { adjustment: { accountId: 'acc_missing' } })).status).toBe(400);
    const done = await recs(`/${secondId}/complete`, 'POST', { clearedLineIds: [lineOf.in80], adjustment: { accountId: expenseId, memo: ' Bank fee ' } });
    expect(done.status).toBe(200);
    expect(done.data).toMatchObject({ status: 'completed', clearedBalance: '400.00', adjustmentJournalEntryId: expect.stringMatching(/^je_/) });
    const report = await recs(`/${secondId}/report`);
    expect(report.data.adjustment).toMatchObject({ amount: 30, difference: -30, accountId: expenseId, memo: 'Bank fee' });
  });

  it('lists the history without the reports', async () => {
    const list = await recs(`?bankAccountId=${bankId}&status=completed&pageSize=1`);
    expect(list.status).toBe(200);
    expect(list.data[0]).toMatchObject({ id: secondId, hasReport: true });
    expect(list.data[0].report).toBeUndefined();
    expect(list.pagination).toMatchObject({ totalCount: 2, hasMore: true, cursor: null });
    const page2 = await recs('?page=2&pageSize=1');
    expect(page2.data).toHaveLength(1);
  });

  it('undoes only the latest one, and only with banking:manage', async () => {
    const older = await recs(`/${firstId}/undo`, 'POST');
    expect(older.status).toBe(400);
    expect((await recs(`/${secondId}/undo`, 'POST', undefined, ['banking:update'])).status).toBe(403);
    const undone = await recs(`/${secondId}/undo`, 'POST');
    expect(undone.status).toBe(200);
    expect(undone.data.status).toBe('undone');
    expect((await recs(`/${secondId}/undo`, 'POST')).status).toBe(400);
    expect((await recs(`/${secondId}/report`)).data.status).toBe('undone');
  });

  it('discards an unfinished one only', async () => {
    const open = await recs('', 'POST', { bankAccountId: bankId, statementDate: '2026-03-31', statementEndingBalance: 1 });
    expect((await recs(`/${open.data.id}`, 'DELETE')).status).toBe(204);
    expect((await recs(`/${open.data.id}`)).status).toBe(404);
    expect((await recs(`/${firstId}`, 'DELETE')).status).toBe(400);
  });

  it('flips the signs for a credit card', async () => {
    const card = await recs('', 'POST', { bankAccountId: cardId, statementDate: '2026-01-31', statementEndingBalance: 40 });
    expect(card.status).toBe(201);
    expect(card.data.accountKind).toBe('credit_card');
    const done = await recs(`/${card.data.id}/complete`, 'POST', { clearedLineIds: [lineOf.charge40] });
    expect(done.data).toMatchObject({ status: 'completed', clearedBalance: '40.00' });
  });

  it('sets an entry and its reversal aside together', async () => {
    const lineId = await post('reversed', bankId, '2026-04-02', 25, incomeId);
    const undone = await call('/api/bank-transactions', bankTransactionsRoutes, `/api/bank-transactions/${lineId}/unreconcile`, 'POST');
    expect(undone.status).toBe(200);
    const far = await recs('', 'POST', { bankAccountId: bankId, statementDate: '2099-12-31', statementEndingBalance: 430 });
    // This line and its reversal, and the undone adjustment and its reversal.
    expect(far.data.nettedLineCount).toBe(4);
    const done = await recs(`/${far.data.id}/complete`, 'POST', { clearedLineIds: [lineOf.in80] });
    expect(done.status).toBe(200);
    const [stamped] = await db.select().from(schema.journalLines).where(eq(schema.journalLines.id, lineOf.reversed)).limit(1);
    expect(stamped?.reconciliationId).toBe(far.data.id);
  });

  it('answers 404 and 400 for unknown ids and entities', async () => {
    for (const [path, method] of [['/brec_missing', 'GET'], ['/brec_missing/report', 'GET'], ['/brec_missing', 'PATCH'], ['/brec_missing/complete', 'POST'], ['/brec_missing/undo', 'POST'], ['/brec_missing', 'DELETE']] as const) {
      expect((await recs(path, method, method === 'GET' || method === 'DELETE' ? undefined : {})).status).toBe(404);
    }
    headerEntity = 'ent_missing';
    expect((await recs('')).data).toEqual([]);
    expect((await recs('/brec_missing')).status).toBe(400);
    expect((await recs('', 'POST', { bankAccountId: bankId, statementDate: '2026-05-31', statementEndingBalance: 1 })).status).toBe(400);
    headerEntity = entityId;
    expect((await recs(`/${firstId}`, 'PATCH', { clearedLineIds: 'all' })).status).toBe(400);
    expect((await recs(`/${firstId}/complete`, 'POST', { adjustment: { accountId: '' } })).status).toBe(400);
  });
});
