/**
 * /api/gl-accounts (pglite): read one account, its posted transactions
 * (paged), update through PUT, delete, and the refusals: system accounts,
 * duplicate codes, accounts with bookings, unknown ids, permissions.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { glAccountsRoutes } from './index';

let db: Database;
const ENTITY = 'ent_gl';

async function call(path: string, opts: { method?: string; body?: unknown; perms?: string[]; entity?: string | null } = {}) {
  const { request } = createTestApp('/api/gl-accounts', glAccountsRoutes, {
    context: { permissions: permissions(...(opts.perms ?? ['*'])), tenantDb: db },
  });
  const entity = opts.entity === undefined ? ENTITY : opts.entity;
  const res = await request(`/api/gl-accounts${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(entity ? { 'X-Accounting-Entity-Id': entity } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = res.status === 204 ? '' : await res.text();
  const json = text ? (JSON.parse(text) as { data?: any; pagination?: any; error?: { message: string } }) : {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { status: res.status, ...json };
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.entities).values({ id: ENTITY, name: 'Accounts BV', jurisdictionCode: 'NL', baseCurrency: 'EUR' });
  await db.insert(schema.accounts).values([
    { id: 'acc_bank', entityId: ENTITY, code: '1100', name: 'Bank', type: 'asset', normalSide: 'debit', currentBalance: '50.00' },
    { id: 'acc_sales', entityId: ENTITY, code: '8000', name: 'Sales', type: 'revenue', normalSide: 'credit', currentBalance: '-50.00' },
    { id: 'acc_ar', entityId: ENTITY, code: '1300', name: 'Receivables', type: 'asset', normalSide: 'debit', isSystemAccount: true },
    { id: 'acc_spare', entityId: ENTITY, code: '4999', name: 'Spare', type: 'expense', normalSide: 'debit' },
  ]);
  await db.insert(schema.journalEntries).values([
    { id: 'je_1', entityId: ENTITY, entryNumber: 'JE-0001', date: new Date('2026-01-10'), status: 'posted', description: 'Sale one' },
    { id: 'je_2', entityId: ENTITY, entryNumber: 'JE-0002', date: new Date('2026-02-10'), status: 'posted', description: 'Sale two' },
    { id: 'je_3', entityId: ENTITY, entryNumber: 'JE-0003', date: new Date('2026-03-10'), status: 'draft', description: 'Draft' },
  ]);
  await db.insert(schema.journalLines).values([
    { id: 'jl_1', entityId: ENTITY, journalEntryId: 'je_1', accountId: 'acc_bank', debit: '20.00', credit: '0' },
    { id: 'jl_2', entityId: ENTITY, journalEntryId: 'je_2', accountId: 'acc_bank', debit: '30.00', credit: '0' },
    { id: 'jl_3', entityId: ENTITY, journalEntryId: 'je_3', accountId: 'acc_bank', debit: '99.00', credit: '0' },
  ]);
}, 60_000);

describe('GL accounts', () => {
  it('reads one account and 404s an unknown one', async () => {
    const res = await call('/acc_bank');
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ id: 'acc_bank', code: '1100', currentBalance: '50.00' });
    expect((await call('/acc_missing')).status).toBe(404);
  });

  it('lists the posted transactions of an account, newest first, paged', async () => {
    const all = await call('/acc_bank/transactions');
    expect(all.status).toBe(200);
    expect(all.data.map((l: { id: string }) => l.id)).toEqual(['jl_2', 'jl_1']);
    expect(all.data[0]).toMatchObject({ entryNumber: 'JE-0002', debit: '30.00', entryDescription: 'Sale two', entryDate: '2026-02-10T00:00:00.000Z' });
    expect(all.pagination).toEqual({ totalCount: 2, hasMore: false, cursor: null });
    const first = await call('/acc_bank/transactions?page=1&pageSize=1');
    expect(first.pagination.hasMore).toBe(true);
    const second = await call('/acc_bank/transactions?page=2&pageSize=1');
    expect(second.data.map((l: { id: string }) => l.id)).toEqual(['jl_1']);
  });

  it('updates through PUT, and refuses a system account change and a duplicate code', async () => {
    const res = await call('/acc_spare', { method: 'PUT', body: { name: 'Spare costs', description: 'Odds and ends' } });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ name: 'Spare costs', description: 'Odds and ends', code: '4999' });
    const system = await call('/acc_ar', { method: 'PUT', body: { code: '1301' } });
    expect(system.status).toBe(400);
    expect(system.error?.message).toBe('Cannot change code, type, or normalSide of a system account');
    const dup = await call('/acc_spare', { method: 'PUT', body: { code: '8000' } });
    expect(dup.status).toBe(409);
    expect((await call('/acc_missing', { method: 'PUT', body: { name: 'x' } })).status).toBe(404);
    expect((await call('/acc_spare', { method: 'PUT', body: { type: 'other' } })).status).toBe(400);
    expect((await call('/acc_spare', { method: 'PUT', body: { taxLine: 'sch_c.8' } })).status).toBe(400);
  });

  it('refuses to delete a system account or one with bookings, then deletes', async () => {
    expect((await call('/acc_ar', { method: 'DELETE' })).error?.message).toBe('Cannot delete a system account');
    expect((await call('/acc_bank', { method: 'DELETE' })).error?.message).toBe('Account has bookings — deactivate it instead');
    expect((await call('/acc_spare', { method: 'DELETE', perms: ['accounts:read'] })).status).toBe(403);
    expect((await call('/acc_spare', { method: 'DELETE' })).status).toBe(204);
    expect((await call('/acc_spare')).status).toBe(404);
    expect((await call('/acc_missing', { method: 'DELETE' })).status).toBe(404);
  });

  it('lists with filters and refuses without an entity', async () => {
    const search = await call('?search=Bank&type=asset&isActive=true');
    expect(search.data.map((a: { id: string }) => a.id)).toEqual(['acc_bank']);
    const none = await call('?taxLine=none');
    expect(none.data.map((a: { id: string }) => a.id)).toEqual(['acc_sales']);
    expect((await call('', { entity: null })).status).toBe(400);
    expect((await call('/tax-lines')).status).toBe(400);
    expect((await call('', { method: 'POST', entity: null, body: { code: '1', name: 'x', type: 'asset', normalSide: 'debit' } })).status).toBe(400);
    expect((await call('/acc_bank/transactions', { perms: ['invoices:read'] })).status).toBe(403);
  });
});
