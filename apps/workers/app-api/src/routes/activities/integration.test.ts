/**
 * DB-backed integration tests for /api/activities.
 *
 * Like the companies + people integration tests, this exercises the
 * full request path including the SQL the route emits — pglite stands
 * in for Neon.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { activitiesRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';

// Stub the entity-event publisher — there's a dedicated test below
// that verifies the call shape, and an unstubbed publish would warn
// noisily about missing queue bindings on every other test.
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

describe('/api/activities · pglite integration', () => {
  it('POST / writes the row and publishes activity.created', async () => {
    mockedPublish.mockClear();
    const { request } = createTestApp('/api/activities', activitiesRoutes, {
      context: {
        permissions: permissions('activities:create'),
        tenantDb: db,
      },
    });

    const res = await request('/api/activities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'task',
        subject: 'Follow up with Acme',
        assignedToId: 'user_test',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^act_/);

    const [row] = await db
      .select()
      .from(schema.crmActivities)
      .where(eq(schema.crmActivities.id, body.data.id))
      .limit(1);
    expect(row?.subject).toBe('Follow up with Acme');
    expect(row?.type).toBe('task');

    expect(mockedPublish).toHaveBeenCalledTimes(1);
    const call = mockedPublish.mock.calls[0]![0] as {
      entityType: string;
      action: string;
    };
    expect(call.entityType).toBe('activity');
    expect(call.action).toBe('created');
  });

  it('GET /:id returns 404 for a missing activity', async () => {
    const { request } = createTestApp('/api/activities', activitiesRoutes, {
      context: {
        permissions: permissions('activities:read'),
        tenantDb: db,
      },
    });
    const res = await request('/api/activities/act_missing_123');
    expect(res.status).toBe(404);
  });

  // Note: the route's `assignedToId required` 400 path is unreachable
  // when userId is set (assignedToId defaults to userId). When userId
  // isn't set, requirePermission's 401 fires first — that's already
  // covered in routes/_auth-gates.test.ts.

  // ---------------------------------------------------------------------------
  // Owner-scoping tests
  // ---------------------------------------------------------------------------

  it('scope-isolation: scoped user does NOT see another owner\'s activity in list', async () => {
    // Seed an activity owned by 'user_other'
    const otherId = generateId('act');
    const now = new Date();
    await db.insert(schema.crmActivities).values({
      id: otherId,
      type: 'note',
      subject: 'Other user note',
      assignedToId: 'user_other',
      status: 'planned',
      priority: 'medium',
      createdAt: now,
      updatedAt: now,
    });

    // Request as 'user_scoped' without scope:all — should NOT see user_other's row
    const { request } = createTestApp('/api/activities', activitiesRoutes, {
      context: {
        userId: 'user_scoped',
        permissions: permissions('activities:read'),
        tenantDb: db,
      },
    });
    const res = await request('/api/activities');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((r) => r.id);
    expect(ids).not.toContain(otherId);
  });

  it('scope-isolation: scoped user gets 404 on GET /:id for another owner\'s activity', async () => {
    // Seed an activity owned by 'user_other2'
    const otherId = generateId('act');
    const now = new Date();
    await db.insert(schema.crmActivities).values({
      id: otherId,
      type: 'call',
      subject: 'Another call',
      assignedToId: 'user_other2',
      status: 'planned',
      priority: 'medium',
      createdAt: now,
      updatedAt: now,
    });

    const { request } = createTestApp('/api/activities', activitiesRoutes, {
      context: {
        userId: 'user_scoped2',
        permissions: permissions('activities:read'),
        tenantDb: db,
      },
    });
    const res = await request(`/api/activities/${otherId}`);
    expect(res.status).toBe(404);
  });

  it('scope-isolation: user with activities:scope:all DOES see another owner\'s activity in list', async () => {
    // Seed an activity owned by 'user_admin_target'
    const ownedId = generateId('act');
    const now = new Date();
    await db.insert(schema.crmActivities).values({
      id: ownedId,
      type: 'email',
      subject: 'Admin visible activity',
      assignedToId: 'user_admin_target',
      status: 'planned',
      priority: 'medium',
      createdAt: now,
      updatedAt: now,
    });

    // Admin user with scope:all
    const { request } = createTestApp('/api/activities', activitiesRoutes, {
      context: {
        userId: 'user_admin',
        permissions: permissions('activities:read', 'activities:scope:all'),
        tenantDb: db,
      },
    });
    const res = await request('/api/activities');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((r) => r.id);
    expect(ids).toContain(ownedId);
  });

  it('scope-isolation: scoped user DOES see their own activity in list', async () => {
    const myId = generateId('act');
    const now = new Date();
    await db.insert(schema.crmActivities).values({
      id: myId,
      type: 'meeting',
      subject: 'My own activity',
      assignedToId: 'user_self',
      status: 'planned',
      priority: 'medium',
      createdAt: now,
      updatedAt: now,
    });

    const { request } = createTestApp('/api/activities', activitiesRoutes, {
      context: {
        userId: 'user_self',
        permissions: permissions('activities:read'),
        tenantDb: db,
      },
    });
    const res = await request('/api/activities');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((r) => r.id);
    expect(ids).toContain(myId);
  });
});
