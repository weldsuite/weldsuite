/**
 * /api/ad-accounts on pglite: the account list and choosing which accounts
 * sync, which keeps the master sync index (a master pglite, shared with the
 * Rust server in conformance mode) in step.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const WORKSPACE_ID = 'ws_test_default';
const ORG_ID = 'org_test_default';

const holder = vi.hoisted(() => ({ master: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => conformanceMasterDb(holder.master),
    getWorkspaceForOrg: async (_env: unknown, orgId: string) => ({ id: 'ws_test_default', clerkOrgId: orgId }),
  };
});

import { adAccountsRoutes } from './index';

const { adPlatformConnections: connections, adAccounts: accounts } = schema;
const BASE = '/api/ad-accounts';

let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;

function app({ orgId = ORG_ID as string | null, grants = ['ad_accounts:read', 'ad_accounts:update'] } = {}) {
  return createTestApp(BASE, adAccountsRoutes, {
    context: { tenantDb: db, masterDb: master, orgId, permissions: permissions(...grants) },
  });
}

function patch(id: string, body: unknown, options: Parameters<typeof app>[0] = {}) {
  return app(options).request(`${BASE}/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function syncIndex(connectionId: string) {
  const [row] = await master
    .select()
    .from(masterSchema.adSyncIndex)
    .where(and(eq(masterSchema.adSyncIndex.workspaceId, WORKSPACE_ID), eq(masterSchema.adSyncIndex.connectionId, connectionId)));
  return row as typeof masterSchema.adSyncIndex.$inferSelect | undefined;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
  await master
    .insert(masterSchema.workspaces)
    .values({ id: WORKSPACE_ID, clerkOrgId: ORG_ID, name: 'Ads', slug: 'ads' } as typeof masterSchema.workspaces.$inferInsert);

  const now = new Date();
  await db.insert(connections).values([
    { id: 'adcn_a', platform: 'facebook', status: 'active', createdAt: now, updatedAt: now },
    { id: 'adcn_b', platform: 'facebook', status: 'active', createdAt: now, updatedAt: now },
    { id: 'adcn_gone', platform: 'facebook', status: 'error', createdAt: now, updatedAt: now, deletedAt: now },
  ]);
  await db.insert(accounts).values([
    { id: 'adac_a1', connectionId: 'adcn_a', platformAccountId: 'act_1', name: 'A one', currency: 'EUR', createdAt: now, updatedAt: now },
    { id: 'adac_a2', connectionId: 'adcn_a', platformAccountId: 'act_2', name: 'A two', isSelected: true, createdAt: now, updatedAt: now },
    { id: 'adac_b1', connectionId: 'adcn_b', platformAccountId: 'act_3', name: 'B one', timezone: 'UTC', createdAt: now, updatedAt: now },
    { id: 'adac_deleted', connectionId: 'adcn_a', platformAccountId: 'act_4', name: 'Deleted', createdAt: now, updatedAt: now, deletedAt: now },
    { id: 'adac_orphan', connectionId: 'adcn_gone', platformAccountId: 'act_5', name: 'Orphan', createdAt: now, updatedAt: now },
  ]);
}, 180_000);

describe('GET /api/ad-accounts', () => {
  it('lists the live accounts', async () => {
    const res = await app().request(BASE);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ id: string }> };
    expect(data.map((row) => row.id).sort()).toEqual(['adac_a1', 'adac_a2', 'adac_b1', 'adac_orphan']);
  });

  it('filters on a connection', async () => {
    const res = await app().request(`${BASE}?connectionId=adcn_a`);
    const { data } = (await res.json()) as { data: Array<{ id: string; isSelected: boolean }> };
    expect(data.map((row) => [row.id, row.isSelected]).sort()).toEqual([
      ['adac_a1', false],
      ['adac_a2', true],
    ]);
    const all = (await (await app().request(`${BASE}?connectionId=`)).json()) as { data: unknown[] };
    expect(all.data).toHaveLength(4);
  });

  it('needs ad_accounts:read', async () => {
    const res = await app({ grants: ['ad_campaigns:read'] }).request(BASE);
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/ad-accounts/:id', () => {
  it('selects an account and enables the connection in the sync index', async () => {
    const res = await patch('adac_b1', { isSelected: true });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ id: 'adac_b1', isSelected: true, timezone: 'UTC', deletedAt: null });
    const index = await syncIndex('adcn_b');
    expect(index).toMatchObject({ clerkOrgId: ORG_ID, isEnabled: true, metricsIntervalHours: 6, webhookSubscribedAt: null });
    expect(index!.nextMetricsSyncAt!.getTime()).toBeGreaterThan(Date.now() + 5 * 60 * 60 * 1000);
  });

  it('keeps the connection enabled while another account is selected', async () => {
    const res = await patch('adac_a1', { isSelected: false });
    expect(res.status).toBe(200);
    expect(await syncIndex('adcn_a')).toMatchObject({ isEnabled: true });
  });

  it('disables the connection once no account is selected', async () => {
    await master
      .update(masterSchema.adSyncIndex)
      .set({ webhookSubscribedAt: new Date('2026-03-01T00:00:00Z') })
      .where(eq(masterSchema.adSyncIndex.connectionId, 'adcn_b'));
    const res = await patch('adac_b1', { isSelected: false });
    expect(res.status).toBe(200);
    const index = await syncIndex('adcn_b');
    // A null webhook time leaves the stored one alone on an update.
    expect(index).toMatchObject({
      isEnabled: false,
      nextMetricsSyncAt: null,
      webhookSubscribedAt: new Date('2026-03-01T00:00:00Z'),
    });
  });

  it('answers 404 for an unknown or deleted account', async () => {
    for (const id of ['adac_missing', 'adac_deleted']) {
      const res = await patch(id, { isSelected: true });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: `Ad account with ID '${id}' not found` } });
    }
  });

  it('answers 404 when the account’s connection is gone', async () => {
    const res = await patch('adac_orphan', { isSelected: true });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Ad connection with ID 'adcn_gone' not found" } });
  });

  it('refuses a request without an active workspace', async () => {
    const res = await patch('adac_a2', { isSelected: true }, { orgId: null });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'No active workspace' } });
  });

  it('validates the body', async () => {
    for (const body of [{}, { isSelected: 'yes' }, { isSelected: null }]) {
      const res = await patch('adac_a2', body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { success: boolean }).success).toBe(false);
    }
  });

  it('needs ad_accounts:update', async () => {
    const res = await patch('adac_a2', { isSelected: true }, { grants: ['ad_accounts:read'] });
    expect(res.status).toBe(403);
  });
});
