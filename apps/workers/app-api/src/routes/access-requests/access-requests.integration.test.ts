/**
 * Access requests may not become a side door around the grant ceiling
 * (TASK-625): only real permission keys can be requested, and approving one
 * needs the resolver to hold it. A refused approval leaves the request pending.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { accessRequestsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn() };
});

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = new Date();
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_req', userId: 'user_requester', email: 'r@example.com', role: 'MEMBER', status: 'ACTIVE', createdAt: now, updatedAt: now },
    { id: 'wm_admin', userId: 'user_admin', email: 'a@example.com', role: 'ADMIN', status: 'ACTIVE', createdAt: now, updatedAt: now },
  ] as (typeof schema.workspaceMembers.$inferInsert)[]);
}, 60_000);

function app(userId: string, ...keys: string[]) {
  return createTestApp('/api/access-requests', accessRequestsRoutes, {
    context: { userId, tenantDb: db, permissions: permissions(...keys) },
  });
}

function send(t: ReturnType<typeof app>, path: string, method: string, body: unknown) {
  return t.request(`/api/access-requests${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('access requests · grant ceiling', () => {
  it('refuses requests for the wildcard or an unknown key', async () => {
    for (const permission of ['*', '*:read', 'made:up']) {
      const res = await send(app('user_requester'), '', 'POST', { permission });
      expect(res.status).toBe(400);
    }
  });

  it("refuses an approval the resolver couldn't grant, and keeps the request pending", async () => {
    const created = await send(app('user_requester'), '', 'POST', { permission: 'billing:read' });
    expect(created.status).toBeLessThan(300);
    const [request] = await db.select().from(schema.accessRequests).where(eq(schema.accessRequests.requesterId, 'user_requester'));

    const refused = await send(app('user_admin', 'team:update'), `/${request!.id}`, 'PATCH', { status: 'approved' });
    expect(refused.status).toBe(403);
    const [still] = await db.select().from(schema.accessRequests).where(eq(schema.accessRequests.id, request!.id));
    expect(still!.status).toBe('pending');
    const [member] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.id, 'wm_req'));
    expect(member!.permissions ?? []).not.toContain('billing:read');

    const approved = await send(app('user_admin', 'team:update', 'billing:read'), `/${request!.id}`, 'PATCH', { status: 'approved' });
    expect(approved.status).toBe(200);
    const [after] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.id, 'wm_req'));
    expect(after!.permissions).toContain('billing:read');
  });
});

describe('access requests · my pending', () => {
  it("lists the caller's pending requests", async () => {
    const asked = await send(app('user_requester'), '', 'POST', { permission: 'team:read', pageLabel: 'Team' });
    expect(asked.status).toBe(201);
    const again = await send(app('user_requester'), '', 'POST', { permission: 'team:read' });
    expect(again.status).toBe(200);

    const res = await app('user_requester').request('/api/access-requests/me/pending');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ permission: string; status: string }>; pagination: { totalCount: number } };
    expect(body.data.map((r) => r.permission)).toContain('team:read');
    expect(body.data.every((r) => r.status === 'pending')).toBe(true);
    expect(body.pagination.totalCount).toBe(body.data.length);

    const other = await app('user_admin').request('/api/access-requests/me/pending');
    expect(((await other.json()) as { data: unknown[] }).data).toEqual([]);
  });
});
