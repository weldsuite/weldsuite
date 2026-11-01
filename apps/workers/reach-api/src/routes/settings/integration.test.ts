/**
 * /api/reach/settings: lazy creation with defaults, partial updates, onboarding
 * completion, validation and permissions.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { resetReachTenant } from '../../lib/mailpool/testing-db';
import { approvedAccess } from '../../lib/mailpool/testing-routes';
import { default as settingsRoutes } from './index';

let db: Database;

function api(keys: string[]) {
  return createTestApp('/api/reach/settings', settingsRoutes, {
    context: { permissions: permissions(...keys), tenantDb: db, appAccess: approvedAccess() },
  }).request;
}
const patch = (body: unknown): RequestInit => ({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 120_000);

beforeEach(async () => {
  await resetReachTenant(db);
});

describe('GET /api/reach/settings', () => {
  it('creates the single row with the defaults on first read, and reuses it afterwards', async () => {
    const first = await api(['reach_settings:read'])('/api/reach/settings');
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      data: {
        id: 'rset_default',
        senderCompanyName: null,
        senderAddress: null,
        optOutText: null,
        defaultTimezone: 'Europe/Amsterdam',
        defaultSendDays: [1, 2, 3, 4, 5],
        defaultWindowStart: '09:00',
        defaultWindowEnd: '17:00',
        defaultMailboxDailyCap: 30,
        stopOnReplyScope: 'prospect',
        onboardingCompletedAt: null,
      },
    });

    await api(['reach_settings:read'])('/api/reach/settings');
    expect(await db.select().from(schema.reachSettings)).toHaveLength(1);
  });

  it('survives concurrent first reads without creating a second row', async () => {
    const read = api(['reach_settings:read']);
    const results = await Promise.all([read('/api/reach/settings'), read('/api/reach/settings'), read('/api/reach/settings')]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await db.select().from(schema.reachSettings)).toHaveLength(1);
  });

  it('needs reach_settings:read', async () => {
    expect((await api(['reach_settings:update'])('/api/reach/settings')).status).toBe(403);
  });
});

describe('PATCH /api/reach/settings', () => {
  it('updates only the fields sent', async () => {
    const res = await api(['reach_settings:update'])(
      '/api/reach/settings',
      patch({ senderCompanyName: 'Acme BV', senderAddress: 'Main St 1, Amsterdam', defaultMailboxDailyCap: 25, stopOnReplyScope: 'company' }),
    );

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      senderCompanyName: 'Acme BV',
      senderAddress: 'Main St 1, Amsterdam',
      defaultMailboxDailyCap: 25,
      stopOnReplyScope: 'company',
      defaultTimezone: 'Europe/Amsterdam',
      onboardingCompletedAt: null,
    });

    const again = await api(['reach_settings:update'])('/api/reach/settings', patch({ defaultWindowStart: '08:30' }));
    expect(((await again.json()) as { data: Record<string, unknown> }).data).toMatchObject({ senderCompanyName: 'Acme BV', defaultWindowStart: '08:30' });
  });

  it('completeOnboarding stamps the time once', async () => {
    const first = await api(['reach_settings:update'])('/api/reach/settings', patch({ completeOnboarding: true }));
    const stamped = ((await first.json()) as { data: { onboardingCompletedAt: string } }).data.onboardingCompletedAt;
    expect(Date.parse(stamped)).not.toBeNaN();

    const second = await api(['reach_settings:update'])('/api/reach/settings', patch({ completeOnboarding: true, senderCompanyName: 'X' }));
    expect(((await second.json()) as { data: { onboardingCompletedAt: string } }).data.onboardingCompletedAt).toBe(stamped);
  });

  it('rejects invalid values with 400', async () => {
    const update = api(['reach_settings:update']);
    expect((await update('/api/reach/settings', patch({ defaultMailboxDailyCap: 51 }))).status).toBe(400);
    expect((await update('/api/reach/settings', patch({ defaultWindowStart: '9am' }))).status).toBe(400);
    expect((await update('/api/reach/settings', patch({ stopOnReplyScope: 'everyone' }))).status).toBe(400);
    expect((await update('/api/reach/settings', patch({ defaultSendDays: [] }))).status).toBe(400);
  });

  it('needs reach_settings:update', async () => {
    expect((await api(['reach_settings:read'])('/api/reach/settings', patch({ senderCompanyName: 'X' }))).status).toBe(403);
  });
});
