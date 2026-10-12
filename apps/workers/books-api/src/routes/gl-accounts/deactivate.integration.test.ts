/**
 * Accounts can be deactivated and reactivated through PATCH { isActive }.
 * System accounts and accounts that still carry a balance refuse (409), and
 * the account list filters on isActive for the pickers. TASK-1119.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { glAccountsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;
const ENTITY = 'ent_gl_deactivate';

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  await db.insert(schema.entities).values({
    id: ENTITY,
    name: 'GL Deactivate BV',
    jurisdictionCode: 'NL',
    baseCurrency: 'EUR',
  } as typeof schema.entities.$inferInsert);
}, 60_000);

function request(path: string, init?: { method?: string; body?: unknown; perms?: string[] }) {
  const { request: send } = createTestApp('/api/gl-accounts', glAccountsRoutes, {
    context: { permissions: permissions(...(init?.perms ?? ['accounts:read', 'accounts:update'])), tenantDb: db },
  });
  return send(path, {
    method: init?.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', 'x-accounting-entity-id': ENTITY },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function createAccount(code: string, extra: Partial<typeof schema.accounts.$inferInsert> = {}): Promise<string> {
  const id = generateId('acc');
  await db.insert(schema.accounts).values({
    id,
    entityId: ENTITY,
    code,
    name: `Account ${code}`,
    type: 'expense',
    normalSide: 'debit',
    ...extra,
  });
  return id;
}

async function postLine(accountId: string, debit: string, credit: string, status = 'posted') {
  const entryId = generateId('je');
  await db.insert(schema.journalEntries).values({ id: entryId, entityId: ENTITY, date: new Date('2026-02-01'), status });
  await db.insert(schema.journalLines).values({
    id: generateId('jl'),
    entityId: ENTITY,
    journalEntryId: entryId,
    accountId,
    debit,
    credit,
  });
}

async function errorOf(res: Response) {
  return ((await res.json()) as { error: { code: string; message: string; details?: { code?: string; balance?: string } } }).error;
}

describe('PATCH /api/gl-accounts/:id { isActive }', () => {
  it('deactivates an unused account and reactivates it', async () => {
    const id = await createAccount('6100');

    const off = await request(`/api/gl-accounts/${id}`, { method: 'PATCH', body: { isActive: false } });
    expect(off.status).toBe(200);
    const [row] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, id));
    expect(row?.isActive).toBe(false);

    const on = await request(`/api/gl-accounts/${id}`, { method: 'PATCH', body: { isActive: true } });
    expect(on.status).toBe(200);
    const [back] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, id));
    expect(back?.isActive).toBe(true);

    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, id));
    expect(audit.some((a) => a.action === 'updated')).toBe(true);
  });

  it('refuses a system account with a 409', async () => {
    const id = await createAccount('6110', { isSystemAccount: true });
    const res = await request(`/api/gl-accounts/${id}`, { method: 'PATCH', body: { isActive: false } });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).details).toMatchObject({ code: 'ACCOUNT_IS_SYSTEM' });
    const [row] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, id));
    expect(row?.isActive).toBe(true);
  });

  it('refuses an account with a ledger balance, naming the balance', async () => {
    const id = await createAccount('6120');
    await postLine(id, '125.50', '0');
    const res = await request(`/api/gl-accounts/${id}`, { method: 'PATCH', body: { isActive: false } });
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error.message).toContain('125.50');
    expect(error.details).toMatchObject({ code: 'ACCOUNT_HAS_BALANCE', balance: '125.50' });
  });

  it('refuses when the stored current balance is not zero', async () => {
    const id = await createAccount('6130', { currentBalance: '10.00' });
    const res = await request(`/api/gl-accounts/${id}`, { method: 'PATCH', body: { isActive: false } });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).details).toMatchObject({ code: 'ACCOUNT_HAS_BALANCE' });
  });

  it('allows an account whose bookings net to zero, and ignores draft entries', async () => {
    const netted = await createAccount('6140');
    await postLine(netted, '40.00', '0');
    await postLine(netted, '0', '40.00');
    expect((await request(`/api/gl-accounts/${netted}`, { method: 'PATCH', body: { isActive: false } })).status).toBe(200);

    const drafted = await createAccount('6150');
    await postLine(drafted, '99.00', '0', 'draft');
    expect((await request(`/api/gl-accounts/${drafted}`, { method: 'PATCH', body: { isActive: false } })).status).toBe(200);
  });

  it('can reactivate an account that has a balance', async () => {
    const id = await createAccount('6160', { isActive: false, currentBalance: '5.00' });
    expect((await request(`/api/gl-accounts/${id}`, { method: 'PATCH', body: { isActive: true } })).status).toBe(200);
  });

  it('does not touch other fields when only isActive is sent, and needs accounts:update', async () => {
    const id = await createAccount('6170');
    expect((await request(`/api/gl-accounts/${id}`, { method: 'PATCH', body: { isActive: false }, perms: ['accounts:read'] })).status).toBe(403);
    await request(`/api/gl-accounts/${id}`, { method: 'PATCH', body: { isActive: false } });
    const [row] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, id));
    expect(row).toMatchObject({ code: '6170', name: 'Account 6170', type: 'expense' });
  });
});

describe('GET /api/gl-accounts?isActive=', () => {
  it('lists only active accounts for pickers and everything without the filter', async () => {
    const active = await createAccount('6200');
    const inactive = await createAccount('6210', { isActive: false });

    const all = (await (await request('/api/gl-accounts')).json()) as { data: Array<{ id: string }> };
    expect(all.data.map((a) => a.id)).toEqual(expect.arrayContaining([active, inactive]));

    const pickers = (await (await request('/api/gl-accounts?isActive=true')).json()) as { data: Array<{ id: string }> };
    expect(pickers.data.map((a) => a.id)).toContain(active);
    expect(pickers.data.map((a) => a.id)).not.toContain(inactive);
  });
});
