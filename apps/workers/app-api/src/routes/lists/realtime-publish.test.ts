/**
 * Ensures list membership mutations fan out `customer_list` entity events
 * so WeldCRM list UIs live-update across users/tabs.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { listsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { createCompany } from '../../services/companies';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  return { ...actual, publishEntityEvent: vi.fn() };
});

import { publishEntityEvent } from '@weldsuite/entity-events';

const mockedPublish = publishEntityEvent as ReturnType<typeof vi.fn>;

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
});

async function seedCompanyList() {
  const listId = generateId('list');
  const now = new Date();
  await db.insert(schema.lists).values({
    id: listId,
    name: 'Publish Test List',
    kind: 'company',
    type: 'static',
    createdAt: now,
    updatedAt: now,
  });
  const company = await createCompany(db, { name: 'Acme Publish Co' });
  return { listId, companyId: company.id };
}

describe('/api/lists members · realtime publish', () => {
  it('POST /:id/members publishes customer_list updated when members are added', async () => {
    const { listId, companyId } = await seedCompanyList();
    const { request } = createTestApp('/api/lists', listsRoutes, {
      context: { permissions: permissions('companies:update'), tenantDb: db },
    });

    const res = await request(`/api/lists/${listId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityIds: [companyId] }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { added: number } };
    expect(body.data.added).toBe(1);

    expect(mockedPublish).toHaveBeenCalled();
    const call = mockedPublish.mock.calls.find(
      (c) => (c[0] as { entityType: string }).entityType === 'customer_list',
    )?.[0] as { entityType: string; action: string; entityId: string };
    expect(call).toBeDefined();
    expect(call.action).toBe('updated');
    expect(call.entityId).toBe(listId);
  });

  it('POST /:id/members does not publish when nothing new was added', async () => {
    const { listId, companyId } = await seedCompanyList();
    await db.insert(schema.listMembers).values({
      id: generateId('lm'),
      listId,
      entityId: companyId,
      addedAt: new Date(),
    });

    const { request } = createTestApp('/api/lists', listsRoutes, {
      context: { permissions: permissions('companies:update'), tenantDb: db },
    });

    const res = await request(`/api/lists/${listId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityIds: [companyId] }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { added: number } };
    expect(body.data.added).toBe(0);
    expect(mockedPublish).not.toHaveBeenCalled();
  });

  it('DELETE /:id/members/:entityId publishes customer_list updated', async () => {
    const { listId, companyId } = await seedCompanyList();
    await db.insert(schema.listMembers).values({
      id: generateId('lm'),
      listId,
      entityId: companyId,
      addedAt: new Date(),
    });

    const { request } = createTestApp('/api/lists', listsRoutes, {
      context: { permissions: permissions('companies:update'), tenantDb: db },
    });

    const res = await request(`/api/lists/${listId}/members/${companyId}`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(204);
    expect(mockedPublish).toHaveBeenCalledTimes(1);
    const call = mockedPublish.mock.calls[0]![0] as {
      entityType: string;
      action: string;
      entityId: string;
    };
    expect(call.entityType).toBe('customer_list');
    expect(call.action).toBe('updated');
    expect(call.entityId).toBe(listId);

    const remaining = await db
      .select()
      .from(schema.listMembers)
      .where(eq(schema.listMembers.listId, listId));
    expect(remaining).toHaveLength(0);
  });
});
