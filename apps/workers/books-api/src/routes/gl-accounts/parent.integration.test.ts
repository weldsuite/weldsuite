/**
 * The parent of an account must be a live account of the same entity and
 * type, never the account itself or one of its sub-accounts, and null (or "")
 * clears it. TASK-1056.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { glAccountsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;
const ENTITY = 'ent_gl_parent';
const OTHER_ENTITY = 'ent_gl_parent_other';

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  for (const id of [ENTITY, OTHER_ENTITY]) {
    await db.insert(schema.entities).values({
      id,
      name: `GL Parent ${id}`,
      jurisdictionCode: 'NL',
      baseCurrency: 'EUR',
    } as typeof schema.entities.$inferInsert);
  }
}, 60_000);

function request(path: string, init?: { method?: string; body?: unknown }) {
  const { request: send } = createTestApp('/api/gl-accounts', glAccountsRoutes, {
    context: {
      permissions: permissions('accounts:read', 'accounts:create', 'accounts:update'),
      tenantDb: db,
    },
  });
  return send(path, {
    method: init?.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', 'x-accounting-entity-id': ENTITY },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

function patch(id: string, body: unknown) {
  return request(`/api/gl-accounts/${id}`, { method: 'PATCH', body });
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

async function parentOf(id: string) {
  const [row] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, id));
  return row?.parentAccountId;
}

async function detailsCode(res: Response) {
  return ((await res.json()) as { error: { details?: { code?: string } } }).error.details?.code;
}

describe('PATCH /api/gl-accounts/:id { parentAccountId }', () => {
  it('sets a parent of the same entity and type', async () => {
    const parent = await createAccount('4000');
    const child = await createAccount('4010');
    expect((await patch(child, { parentAccountId: parent })).status).toBe(200);
    expect(await parentOf(child)).toBe(parent);
  });

  it('refuses the account as its own parent', async () => {
    const id = await createAccount('4100');
    const res = await patch(id, { parentAccountId: id });
    expect(res.status).toBe(400);
    expect(await detailsCode(res)).toBe('PARENT_IS_SELF');
    expect(await parentOf(id)).toBeNull();
  });

  it('refuses a sub-account as the parent, directly or further down', async () => {
    const top = await createAccount('4200');
    const middle = await createAccount('4210', { parentAccountId: top });
    const bottom = await createAccount('4211', { parentAccountId: middle });

    const direct = await patch(top, { parentAccountId: middle });
    expect(direct.status).toBe(400);
    expect(await detailsCode(direct)).toBe('PARENT_CYCLE');

    const deep = await patch(top, { parentAccountId: bottom });
    expect(deep.status).toBe(400);
    expect(await detailsCode(deep)).toBe('PARENT_CYCLE');
    expect(await parentOf(top)).toBeNull();
  });

  it('clears the parent with null, and treats "" as null', async () => {
    const parent = await createAccount('4300');
    const a = await createAccount('4310', { parentAccountId: parent });
    const b = await createAccount('4320', { parentAccountId: parent });

    expect((await patch(a, { parentAccountId: null })).status).toBe(200);
    expect(await parentOf(a)).toBeNull();

    expect((await patch(b, { parentAccountId: '' })).status).toBe(200);
    expect(await parentOf(b)).toBeNull();
  });

  it('refuses a parent of another type', async () => {
    const asset = await createAccount('1000', { type: 'asset' });
    const expense = await createAccount('4400');
    const res = await patch(expense, { parentAccountId: asset });
    expect(res.status).toBe(400);
    expect(await detailsCode(res)).toBe('PARENT_TYPE_MISMATCH');
  });

  it('refuses a parent from another entity, a deleted one, or one that does not exist', async () => {
    const child = await createAccount('4500');
    const foreign = await createAccount('4501', { entityId: OTHER_ENTITY });
    const deleted = await createAccount('4502', { deletedAt: new Date() });

    for (const parentAccountId of [foreign, deleted, 'acc_missing']) {
      const res = await patch(child, { parentAccountId });
      expect(res.status).toBe(400);
      expect(await detailsCode(res)).toBe('PARENT_NOT_FOUND');
    }
    expect(await parentOf(child)).toBeNull();
  });

  it('refuses a type change that no longer fits the parent or the sub-accounts', async () => {
    const parent = await createAccount('4600');
    const child = await createAccount('4610', { parentAccountId: parent });

    const underParent = await patch(child, { type: 'revenue', normalSide: 'credit' });
    expect(underParent.status).toBe(400);
    expect(await detailsCode(underParent)).toBe('PARENT_TYPE_MISMATCH');

    const withChildren = await patch(parent, { type: 'revenue', normalSide: 'credit' });
    expect(withChildren.status).toBe(400);
    expect(await detailsCode(withChildren)).toBe('ACCOUNT_HAS_SUB_ACCOUNTS');

    // Moving out and changing type in one request is fine.
    expect((await patch(child, { parentAccountId: null, type: 'revenue', normalSide: 'credit' })).status).toBe(200);
  });

  it('leaves the parent alone when other fields change', async () => {
    const parent = await createAccount('4700');
    const child = await createAccount('4710', { parentAccountId: parent });
    expect((await patch(child, { name: 'Renamed' })).status).toBe(200);
    expect(await parentOf(child)).toBe(parent);
  });
});

describe('POST /api/gl-accounts { parentAccountId }', () => {
  it('creates an account under a valid parent', async () => {
    const parent = await createAccount('4800');
    const res = await request('/api/gl-accounts', {
      method: 'POST',
      body: { code: '4810', name: 'Sub', type: 'expense', normalSide: 'debit', parentAccountId: parent },
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    expect(await parentOf(data.id)).toBe(parent);
  });

  it('refuses a parent of another type or entity, and stores "" as null', async () => {
    const asset = await createAccount('1100', { type: 'asset' });
    const mismatch = await request('/api/gl-accounts', {
      method: 'POST',
      body: { code: '4820', name: 'Sub', type: 'expense', normalSide: 'debit', parentAccountId: asset },
    });
    expect(mismatch.status).toBe(400);
    expect(await detailsCode(mismatch)).toBe('PARENT_TYPE_MISMATCH');

    const empty = await request('/api/gl-accounts', {
      method: 'POST',
      body: { code: '4830', name: 'Top', type: 'expense', normalSide: 'debit', parentAccountId: '' },
    });
    expect(empty.status).toBe(201);
    const { data } = (await empty.json()) as { data: { id: string } };
    expect(await parentOf(data.id)).toBeNull();
  });
});
