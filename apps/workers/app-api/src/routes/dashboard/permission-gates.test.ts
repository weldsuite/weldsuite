/**
 * /api/dashboard/* sections are gated on the object they read (TASK-626): a
 * member without `activities:read` gets an empty activity feed, and the chart
 * and order/ticket badges stay empty/zero without `orders:read` / `tickets:read`.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { dashboardRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.crmActivities).values({
    id: 'act_1',
    type: 'note',
    subject: 'Quarterly numbers',
    assignedToId: 'user_sales',
  } as typeof schema.crmActivities.$inferInsert);
}, 60_000);

function get(path: string, ...keys: string[]) {
  return createTestApp('/api/dashboard', dashboardRoutes, {
    context: { tenantDb: db, permissions: permissions(...keys) },
  }).request(`/api/dashboard${path}`);
}

describe('dashboard permission gates', () => {
  it('hides the activity feed without activities:read', async () => {
    const res = await get('/activity');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it('shows the activity feed with activities:read', async () => {
    const res = await get('/activity', 'activities:read');
    const { data } = (await res.json()) as { data: Array<{ id: string }> };
    expect(data.map((a) => a.id)).toEqual(['act_1']);
  });

  it('returns no chart points without orders:read or tickets:read', async () => {
    const res = await get('/chart');
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it('reports zero ticket and order badges without the permissions', async () => {
    const res = await get('/sidebar-badges');
    const { data } = (await res.json()) as { data: { openTickets: number; pendingOrders: number } };
    expect(data.openTickets).toBe(0);
    expect(data.pendingOrders).toBe(0);
  });
});
