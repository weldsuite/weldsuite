/**
 * /api/calls on pglite: creating a call (an outbound one needs a minute's
 * credits in the prepaid wallet), reading one, updating it (its end settles
 * the minutes once, forcing the wallet negative when it ran dry), deleting
 * it, and the list's filters and keyset pages. The wallet lives in a master
 * pglite, shared with the Rust server in conformance mode.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const holder = vi.hoisted(() => ({ master: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => conformanceMasterDb(holder.master) };
});

import { callsRoutes } from './index';

const BASE = '/api/calls';
const ALL = ['activities:read', 'activities:create', 'activities:update', 'activities:delete'];

let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;

function app(options: { userId?: string; workspaceId?: string; grants?: string[] } = {}) {
  return createTestApp(BASE, callsRoutes, {
    context: {
      userId: options.userId ?? 'user_writer',
      workspaceId: options.workspaceId ?? 'ws_test_default',
      tenantDb: db,
      masterDb: master,
      permissions: permissions(...(options.grants ?? ALL)),
    },
  });
}

function send(method: string, path: string, body?: unknown, options: Parameters<typeof app>[0] = {}) {
  return app(options).request(`${BASE}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

async function balance(workspaceId: string): Promise<number> {
  const [row] = await master
    .select({ balance: masterSchema.workspaceCredits.currentBalance })
    .from(masterSchema.workspaceCredits)
    .where(eq(masterSchema.workspaceCredits.workspaceId, workspaceId));
  return row?.balance ?? 0;
}

async function seedCall(id: string, values: Partial<typeof schema.voipCalls.$inferInsert> = {}) {
  await db.insert(schema.voipCalls).values({
    id,
    userId: 'user_writer',
    direction: 'outbound',
    status: 'initiated',
    fromNumber: '+31200000001',
    toNumber: '+31600000001',
    initiatedAt: new Date('2026-10-01T09:00:00Z'),
    ...values,
  });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
  await master.insert(masterSchema.workspaces).values([
    { id: 'ws_test_default', clerkOrgId: 'org_test_default', name: 'Calls', slug: 'calls' },
    { id: 'ws_calls_broke', clerkOrgId: 'org_calls_broke', name: 'Broke', slug: 'broke' },
    { id: 'ws_calls_short', clerkOrgId: 'org_calls_short', name: 'Short', slug: 'short' },
  ] as (typeof masterSchema.workspaces.$inferInsert)[]);
  const now = new Date();
  await master.insert(masterSchema.workspaceCredits).values([
    { id: 'wcr_calls', workspaceId: 'ws_test_default', currentBalance: 100, periodStart: now, periodEnd: now },
    { id: 'wcr_short', workspaceId: 'ws_calls_short', currentBalance: 4, periodStart: now, periodEnd: now },
  ]);
}, 180_000);

describe('POST /api/calls', () => {
  it('validates the body', async () => {
    const missing = await send('POST', '', { direction: 'sideways', fromNumber: '' });
    expect(missing.status).toBe(400);
    const notJson = await app().request(BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    expect(notJson.status).toBe(400);
  });

  it('refuses an outbound call when the wallet cannot pay a minute', async () => {
    const res = await send('POST', '', { direction: 'outbound', fromNumber: '+31200000002', toNumber: '+31600000002' }, { workspaceId: 'ws_calls_broke' });
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({
      error: {
        code: 'INSUFFICIENT_CREDITS',
        message: 'Insufficient credits. Top up your workspace balance to continue.',
        details: { currentBalance: 0, required: 3, shortfall: 3 },
      },
    });
  });

  it('creates an outbound call, and an inbound one without a credit check', async () => {
    const res = await send('POST', '', {
      direction: 'outbound',
      fromNumber: '+31200000003',
      toNumber: '+31600000003',
      toNumberFormatted: '06 0000 0003',
      contactId: 'per_call_1',
      notes: 'Follow-up',
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const got = await send('GET', `/${data.id}`);
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({
      data: { id: data.id, provider: 'telnyx', status: 'initiated', isRecorded: true, notes: 'Follow-up' },
    });

    const inbound = await send('POST', '', {
      direction: 'inbound',
      fromNumber: '+31600000004',
      toNumber: '+31200000004',
      provider: '',
      isRecorded: false,
    }, { workspaceId: 'ws_calls_broke' });
    expect(inbound.status).toBe(201);
  });
});

describe('PUT /api/calls/:id', () => {
  it('answers 404 for an unknown call and validates the body', async () => {
    expect((await send('PUT', '/vcall_missing', { notes: 'x' })).status).toBe(404);
    await seedCall('vcall_put_bad');
    expect((await send('PUT', '/vcall_put_bad', { duration: -1 })).status).toBe(400);
    expect((await send('PUT', '/vcall_put_bad', { duration: 1.5 })).status).toBe(400);
  });

  it('updates fields and echoes what was sent', async () => {
    await seedCall('vcall_put_fields');
    const res = await send('PUT', '/vcall_put_fields', {
      status: 'ringing',
      answeredAt: '2026-10-01T09:00:05Z',
      customerId: null,
      notes: 'Ringing',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { id: 'vcall_put_fields', status: 'ringing', answeredAt: '2026-10-01T09:00:05Z', customerId: null, notes: 'Ringing' },
    });
    const got = (await (await send('GET', '/vcall_put_fields')).json()) as { data: Record<string, unknown> };
    expect(got.data).toMatchObject({ status: 'ringing', answeredAt: '2026-10-01T09:00:05.000Z', creditsConsumed: 0 });
  });

  it('settles a finished call once, per started minute', async () => {
    await seedCall('vcall_put_settle');
    const before = await balance('ws_test_default');
    const res = await send('PUT', '/vcall_put_settle', { status: 'completed', endedAt: '2026-10-01T09:02:00Z', duration: 61 });
    expect(res.status).toBe(200);
    expect(await balance('ws_test_default')).toBe(before - 6);
    const got = (await (await send('GET', '/vcall_put_settle')).json()) as { data: Record<string, unknown> };
    expect(got.data).toMatchObject({ creditsConsumed: 6, status: 'completed' });
    expect(got.data.creditTransactionId).toEqual(expect.any(String));

    // Already settled: nothing more is taken.
    await send('PUT', '/vcall_put_settle', { duration: 300 });
    expect(await balance('ws_test_default')).toBe(before - 6);
  });

  it('forces the wallet negative when it ran dry during the call', async () => {
    await seedCall('vcall_put_debt');
    const res = await send('PUT', '/vcall_put_debt', { endedAt: '2026-10-01T09:05:00Z', duration: 120 }, { workspaceId: 'ws_calls_short' });
    expect(res.status).toBe(200);
    expect(await balance('ws_calls_short')).toBe(-2);
    const [ledger] = await master
      .select()
      .from(masterSchema.creditTransactions)
      .where(eq(masterSchema.creditTransactions.idempotencyKey, 'voip:vcall_put_debt'));
    expect(ledger).toMatchObject({ type: 'adjustment', amount: -6, balanceAfter: -2, userId: 'user_writer' });
  });

  it('fails on a date it cannot write', async () => {
    await seedCall('vcall_put_date');
    const res = await send('PUT', '/vcall_put_date', { endedAt: 'not a date' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update call' } });
  });
});

describe('DELETE /api/calls/:id', () => {
  it('deletes a call', async () => {
    await seedCall('vcall_delete');
    expect((await send('DELETE', '/vcall_delete')).status).toBe(204);
    expect((await send('DELETE', '/vcall_delete')).status).toBe(404);
  });

  it('needs its permission', async () => {
    await seedCall('vcall_delete_denied');
    expect((await send('DELETE', '/vcall_delete_denied', undefined, { grants: ['activities:read'] })).status).toBe(403);
  });
});

describe('GET /api/calls filters and pages', () => {
  beforeAll(async () => {
    await db.insert(schema.voipCalls).values(
      [1, 2, 3, 4, 5].map((n) => ({
        id: `vcall_page_${n}`,
        userId: 'user_pager',
        direction: n % 2 === 0 ? 'inbound' : 'outbound',
        status: n === 5 ? 'completed' : 'initiated',
        fromNumber: `+3120000010${n}`,
        toNumber: `+3160000010${n}`,
        notes: n === 3 ? 'needle here' : null,
        initiatedAt: new Date(`2026-09-0${n}T10:00:00Z`),
      })),
    );
  });

  const list = async (query: string) => {
    const res = await send('GET', query, undefined, { userId: 'user_pager' });
    return { status: res.status, body: (await res.json()) as { data: Array<{ id: string }>; pagination: Record<string, unknown> } };
  };

  it('filters by status, direction, search and dates', async () => {
    expect((await list('?status=completed')).body.data.map((r) => r.id)).toEqual(['vcall_page_5']);
    expect((await list('?direction=inbound')).body.data.map((r) => r.id)).toEqual(['vcall_page_4', 'vcall_page_2']);
    expect((await list('?search=needle')).body.data.map((r) => r.id)).toEqual(['vcall_page_3']);
    expect((await list('?from=2026-09-02&to=2026-09-03T23:00:00Z')).body.data.map((r) => r.id)).toEqual([
      'vcall_page_3',
      'vcall_page_2',
    ]);
    expect((await list('?from=nonsense')).status).toBe(500);
  });

  it('pages newest first with a keyset cursor', async () => {
    const first = await list('?limit=2');
    expect(first.body.data.map((r) => r.id)).toEqual(['vcall_page_5', 'vcall_page_4']);
    expect(first.body.pagination).toEqual({ totalCount: 5, hasMore: true, cursor: 'vcall_page_4' });
    const second = await list('?limit=2&cursor=vcall_page_4');
    expect(second.body.data.map((r) => r.id)).toEqual(['vcall_page_3', 'vcall_page_2']);
    expect(second.body.pagination).toEqual({ totalCount: 5, hasMore: true, cursor: 'vcall_page_2' });
    // An unknown cursor drops the last filter from the count, as the worker does.
    const unknown = await list('?direction=inbound&cursor=vcall_nope');
    expect(unknown.body.pagination).toMatchObject({ totalCount: 5, hasMore: false });
    expect((await list('?limit=500')).body.data).toHaveLength(5);
  });
});
