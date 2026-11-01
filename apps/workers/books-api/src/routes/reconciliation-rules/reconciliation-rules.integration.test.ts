/**
 * /api/reconciliation-rules (pglite): create, list by priority, read, update
 * (PUT and PATCH), delete, and the refusals: permissions, validation, no
 * entity, unknown ids.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { reconciliationRulesRoutes } from './index';

const ENTITY = 'ent_rr';
let db: Database;

async function call(path: string, opts: { method?: string; body?: unknown; perms?: string[]; entity?: string | null } = {}) {
  const { request } = createTestApp('/api/reconciliation-rules', reconciliationRulesRoutes, {
    context: { permissions: permissions(...(opts.perms ?? ['*'])), tenantDb: db },
  });
  const entity = opts.entity === undefined ? ENTITY : opts.entity;
  const res = await request(`/api/reconciliation-rules${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(entity ? { 'X-Accounting-Entity-Id': entity } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = res.status === 204 ? '' : await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = text ? (JSON.parse(text) as { data?: any; error?: { message: string } }) : {};
  return { status: res.status, ...json };
}

const feeRule = {
  name: 'Bank fees',
  priority: 10,
  matchMode: 'any',
  conditions: [
    { field: 'description', operator: 'contains', value: 'fee', extra: 'dropped' },
    { field: 'amount', operator: 'between', value: -50, value2: -1 },
  ],
  actions: { categoryAccountId: 'acc_fees', description: 'Bank fee', other: 'dropped' },
};

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.entities).values({ id: ENTITY, name: 'Rules BV', jurisdictionCode: 'NL', baseCurrency: 'EUR', locale: 'nl-NL' });
}, 60_000);

describe('reconciliation rules', () => {
  let feeId = '';
  let rentId = '';

  it('creates rules, keeping only the schema\'s fields', async () => {
    const fee = await call('', { method: 'POST', body: feeRule });
    expect(fee.status).toBe(201);
    expect(fee.data).toMatchObject({ name: 'Bank fees', priority: 10, matchMode: 'any', isActive: true, matchCount: 0, entityId: ENTITY });
    expect(fee.data.conditions[0]).toEqual({ field: 'description', operator: 'contains', value: 'fee' });
    expect(fee.data.actions).toEqual({ categoryAccountId: 'acc_fees', description: 'Bank fee' });
    feeId = fee.data.id;

    const rent = await call('', { method: 'POST', body: { name: 'Rent', conditions: [{ field: 'counterpartyName', operator: 'equals', value: 'Landlord' }], actions: {} } });
    expect(rent.status).toBe(201);
    rentId = rent.data.id;
    const [row] = await db.select().from(schema.reconciliationRules).where(eq(schema.reconciliationRules.id, rentId)).limit(1);
    expect(row?.priority).toBe(0);
  });

  it('lists highest priority first and reads one', async () => {
    const list = await call('');
    expect(list.status).toBe(200);
    expect(list.data.map((r: { id: string }) => r.id)).toEqual([feeId, rentId]);
    const one = await call(`/${feeId}`);
    expect(one.data).toMatchObject({ id: feeId, name: 'Bank fees' });
    expect((await call('/rr_missing')).status).toBe(404);
  });

  it('updates with PATCH and PUT', async () => {
    const patched = await call(`/${rentId}`, { method: 'PATCH', body: { priority: 20, matchMode: 'all' } });
    expect(patched.status).toBe(200);
    expect(patched.data).toMatchObject({ id: rentId, priority: 20, matchMode: 'all', name: 'Rent' });
    const put = await call(`/${rentId}`, { method: 'PUT', body: { name: 'Office rent', conditions: [{ field: 'reference', operator: 'starts_with', value: 'HUUR' }] } });
    expect(put.status).toBe(200);
    expect(put.data.conditions).toEqual([{ field: 'reference', operator: 'starts_with', value: 'HUUR' }]);
    const empty = await call(`/${rentId}`, { method: 'PATCH', body: {} });
    expect(empty.status).toBe(200);
    expect((await call('/rr_missing', { method: 'PATCH', body: { name: 'X' } })).status).toBe(404);
  });

  it('validates bodies', async () => {
    expect((await call('', { method: 'POST', body: { name: '' } })).status).toBe(400);
    expect(
      (await call('', { method: 'POST', body: { name: 'X', matchMode: 'some', conditions: [{ field: 'iban', operator: 'like', value: true }, 'x'], actions: { categoryAccountId: 5 } } })).status,
    ).toBe(400);
    expect((await call(`/${rentId}`, { method: 'PATCH', body: { conditions: 'all' } })).status).toBe(400);
  });

  it('needs an entity and the banking permissions', async () => {
    expect((await call('', { entity: null })).status).toBe(400);
    expect((await call('', { method: 'POST', body: feeRule, entity: 'ent_missing' })).status).toBe(400);
    expect((await call('', { perms: ['invoices:read'] })).status).toBe(403);
    expect((await call('', { method: 'POST', body: feeRule, perms: ['banking:read'] })).status).toBe(403);
    expect((await call(`/${rentId}`, { method: 'PUT', body: {}, perms: ['banking:read'] })).status).toBe(403);
    expect((await call(`/${rentId}`, { method: 'DELETE', perms: ['banking:update'] })).status).toBe(403);
  });

  it('soft-deletes', async () => {
    expect((await call(`/${rentId}`, { method: 'DELETE' })).status).toBe(204);
    expect((await call(`/${rentId}`)).status).toBe(404);
    expect((await call(`/${rentId}`, { method: 'DELETE' })).status).toBe(404);
    const list = await call('');
    expect(list.data.map((r: { id: string }) => r.id)).toEqual([feeId]);
  });
});
