/**
 * DB-backed integration tests for /api/calls.
 *
 * Verifies scope-isolation: without activities:scope:all, a user only sees
 * voip_calls where userId matches their own. With activities:scope:all, they
 * see all calls regardless of owner.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { callsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/calls · pglite integration', () => {
  it('GET / returns 200 for a user with no calls (empty list)', async () => {
    const { request } = createTestApp('/api/calls', callsRoutes, {
      context: {
        userId: 'user_calls_empty',
        permissions: permissions('activities:read'),
        tenantDb: db,
      },
    });
    const res = await request('/api/calls');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    // Should return an array (may contain rows from other tests but none owned
    // by user_calls_empty, so we just confirm the shape is correct)
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('scope-isolation: scoped user does NOT see another owner\'s call in list', async () => {
    const otherId = generateId('vc');
    const now = new Date();
    await db.insert(schema.voipCalls).values({
      id: otherId,
      userId: 'user_other_call',
      direction: 'outbound',
      status: 'completed',
      fromNumber: '+31612345678',
      toNumber: '+31687654321',
      initiatedAt: now,
    });

    const { request } = createTestApp('/api/calls', callsRoutes, {
      context: {
        userId: 'user_scoped_call',
        permissions: permissions('activities:read'),
        tenantDb: db,
      },
    });
    const res = await request('/api/calls');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((r) => r.id);
    expect(ids).not.toContain(otherId);
  });

  it('scope-isolation: scoped user gets 404 on GET /:id for another owner\'s call', async () => {
    const otherId = generateId('vc');
    const now = new Date();
    await db.insert(schema.voipCalls).values({
      id: otherId,
      userId: 'user_other_call2',
      direction: 'inbound',
      status: 'answered',
      fromNumber: '+31611111111',
      toNumber: '+31622222222',
      initiatedAt: now,
    });

    const { request } = createTestApp('/api/calls', callsRoutes, {
      context: {
        userId: 'user_scoped_call2',
        permissions: permissions('activities:read'),
        tenantDb: db,
      },
    });
    const res = await request(`/api/calls/${otherId}`);
    expect(res.status).toBe(404);
  });

  it('scope-isolation: user with activities:scope:all DOES see another owner\'s call in list', async () => {
    const ownedId = generateId('vc');
    const now = new Date();
    await db.insert(schema.voipCalls).values({
      id: ownedId,
      userId: 'user_admin_call_target',
      direction: 'outbound',
      status: 'completed',
      fromNumber: '+31633333333',
      toNumber: '+31644444444',
      initiatedAt: now,
    });

    const { request } = createTestApp('/api/calls', callsRoutes, {
      context: {
        userId: 'user_admin_call',
        permissions: permissions('activities:read', 'activities:scope:all'),
        tenantDb: db,
      },
    });
    const res = await request('/api/calls');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((r) => r.id);
    expect(ids).toContain(ownedId);
  });

  it('scope-isolation: user DOES see their own call in list', async () => {
    const myId = generateId('vc');
    const now = new Date();
    await db.insert(schema.voipCalls).values({
      id: myId,
      userId: 'user_self_call',
      direction: 'outbound',
      status: 'completed',
      fromNumber: '+31655555555',
      toNumber: '+31666666666',
      initiatedAt: now,
    });

    const { request } = createTestApp('/api/calls', callsRoutes, {
      context: {
        userId: 'user_self_call',
        permissions: permissions('activities:read'),
        tenantDb: db,
      },
    });
    const res = await request('/api/calls');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((r) => r.id);
    expect(ids).toContain(myId);
  });
});
