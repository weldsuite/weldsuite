/**
 * DB-backed integration tests for /api/slas.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { slasRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/slas · pglite integration', () => {
  it('POST / writes an SLA row', async () => {
    const { request } = createTestApp('/api/slas', slasRoutes, {
      context: { permissions: permissions('slas:create'), tenantDb: db },
    });

    const res = await request('/api/slas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Standard SLA',
        responseTimeMinutes: 60,
        resolutionTimeMinutes: 480,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBeTruthy();

    const [row] = await db
      .select()
      .from(schema.helpdeskSlas)
      .where(eq(schema.helpdeskSlas.id, body.data.id))
      .limit(1);
    expect(row?.name).toBe('Standard SLA');
  });

  it('POST / rejects empty name', async () => {
    const { request } = createTestApp('/api/slas', slasRoutes, {
      context: { permissions: permissions('slas:create'), tenantDb: db },
    });
    const res = await request('/api/slas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('/api/slas · policy payload', () => {
  const post = (body: unknown) => {
    const { request } = createTestApp('/api/slas', slasRoutes, {
      context: { permissions: permissions('slas:create'), tenantDb: db },
    });
    return request('/api/slas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  it('stores the targets, reminders, order and calendar the engine reads', async () => {
    const res = await post({
      name: 'Business hours SLA',
      priority: 3,
      conditions: [{ field: 'priority', operator: 'equals', value: 'urgent' }],
      firstResponseTime: [{ priority: 'urgent', time: 30 }],
      updateTime: [{ priority: 'urgent', time: 60 }],
      resolutionTime: [{ priority: 'urgent', time: 240 }],
      reminders: [{ type: 'before_breach', time: 10, recipients: ['assignee'] }],
      operationalHours: 'custom',
      businessHours: { timezone: 'UTC', monday: { isOpen: true, openTime: '09:00', closeTime: '17:00' } },
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const [row] = await db
      .select()
      .from(schema.helpdeskSlas)
      .where(eq(schema.helpdeskSlas.id, data.id))
      .limit(1);
    expect(row?.priority).toBe(3);
    expect(row?.firstResponseTime).toEqual([{ priority: 'urgent', time: 30 }]);
    expect(row?.reminders).toEqual([{ type: 'before_breach', time: 10, recipients: ['assignee'] }]);
    expect(row?.operationalHours).toBe('custom');
    expect(row?.businessHours?.timezone).toBe('UTC');
  });

  it('refuses a ticket priority as the policy order (an integer column)', async () => {
    expect((await post({ name: 'Bad order', priority: 'high' })).status).toBe(400);
  });
});
