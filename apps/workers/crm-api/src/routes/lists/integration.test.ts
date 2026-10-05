/**
 * DB-backed integration tests for /api/lists.
 *
 * Lists target a single identity kind (company | person | lead).
 * Permissions are `companies:*` because lists are a CRM management
 * surface, not a permission surface of their own.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { listsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/lists · pglite integration', () => {
  it('POST / writes a list row with the kind discriminator', async () => {
    const { request } = createTestApp('/api/lists', listsRoutes, {
      context: { permissions: permissions('companies:create'), tenantDb: db },
    });

    const res = await request('/api/lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'VIP Customers',
        kind: 'company',
        color: 'bg-green-500',
        icon: 'Star',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; name: string } };
    expect(body.data.id).toMatch(/^list_/);
    expect(body.data.name).toBe('VIP Customers');

    const [row] = await db
      .select()
      .from(schema.lists)
      .where(eq(schema.lists.id, body.data.id))
      .limit(1);
    expect(row?.kind).toBe('company');
    expect(row?.icon).toBe('Star');
  });

  it('POST / rejects empty name', async () => {
    const { request } = createTestApp('/api/lists', listsRoutes, {
      context: { permissions: permissions('companies:create'), tenantDb: db },
    });
    const res = await request('/api/lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', kind: 'company' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST / rejects invalid kind', async () => {
    const { request } = createTestApp('/api/lists', listsRoutes, {
      context: { permissions: permissions('companies:create'), tenantDb: db },
    });
    const res = await request('/api/lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bad kind', kind: 'unicorn' }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /:id returns 404 for missing list', async () => {
    const { request } = createTestApp('/api/lists', listsRoutes, {
      context: { permissions: permissions('companies:read'), tenantDb: db },
    });
    const res = await request('/api/lists/list_missing');
    expect(res.status).toBe(404);
  });

  it('memberCount reflects actual membership on both GET / and GET /:id', async () => {
    const { request } = createTestApp('/api/lists', listsRoutes, {
      context: {
        permissions: permissions('companies:create', 'companies:read', 'companies:update'),
        tenantDb: db,
      },
    });

    const createRes = await request('/api/lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Member Count List', kind: 'company' }),
    });
    const created = (await createRes.json()) as { data: { id: string } };
    const listId = created.data.id;

    const companyId = generateId('cust');
    await db.insert(schema.companies).values({
      id: companyId,
      name: 'Acme',
      displayName: 'Acme',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await request(`/api/lists/${listId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityIds: [companyId] }),
    });

    const listRes = await request('/api/lists?kind=company');
    const listBody = (await listRes.json()) as { data: Array<{ id: string; memberCount: number }> };
    expect(listBody.data.find((row) => row.id === listId)?.memberCount).toBe(1);

    const detailRes = await request(`/api/lists/${listId}`);
    const detailBody = (await detailRes.json()) as { data: { memberCount: number } };
    expect(detailBody.data.memberCount).toBe(1);
  });
});
