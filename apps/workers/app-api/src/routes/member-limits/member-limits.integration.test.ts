/**
 * GET /api/member-limits against pglite (tenant + master) and a stubbed Clerk:
 * the plan's limit (hard cap, per-seat, unlimited, partner licence), the seats
 * in use from Clerk (removed members left out, guest invitations not counted)
 * with the DB count as fallback, and the refusals.
 *
 * Clerk answers by URL (src/test/fake-clerk.ts), so the conformance suite can
 * run these against the Rust backend too.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { stubClerk, type ClerkScenario } from '../../test/fake-clerk';

const state = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => state.master,
    // The workspace asked about is the caller's: its tenant DB is the test's.
    getTenantDbForWorkspace: async () => state.tenant,
  };
});

import { memberLimitsRoutes } from './index';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for postgres-js
let master: any;
let tenant: Database;
let clerk: ClerkScenario;

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db;
  tenant = (await createPgliteDb()).db;
  state.master = master;
  state.tenant = tenant;

  await master.insert(masterSchema.plans).values([
    { id: 'plan_ml_free', name: 'Free', slug: 'ml-free', maxUsers: 1 },
    { id: 'plan_ml_seat', name: 'Pro', slug: 'ml-pro', pricePerUser: '12.00', includedUsers: 2 },
    { id: 'plan_ml_flat', name: 'Flat', slug: 'ml-flat' },
  ]);
  await master.insert(masterSchema.partners).values({
    id: 'ptr_ml',
    name: 'Acme Partner',
    billingEmail: 'billing@partner.test',
  });
  await master.insert(masterSchema.workspaces).values([
    { id: 'ws_ml_free', clerkOrgId: 'org_ml_free', name: 'Free WS', slug: 'ml-free-ws', planId: 'plan_ml_free' },
    { id: 'ws_ml_seat', clerkOrgId: 'org_ml_seat', name: 'Seat WS', slug: 'ml-seat-ws', planId: 'plan_ml_seat', purchasedSeats: 3 },
    { id: 'ws_ml_flat', clerkOrgId: 'org_ml_flat', name: 'Flat WS', slug: 'ml-flat-ws', planId: 'plan_ml_flat' },
    { id: 'ws_ml_none', clerkOrgId: 'org_ml_none', name: 'No plan WS', slug: 'ml-none-ws' },
    { id: 'ws_ml_partner', clerkOrgId: 'org_ml_partner', name: 'Partner WS', slug: 'ml-partner-ws', billingMode: 'partner', partnerId: 'ptr_ml' },
  ]);
  await master.insert(masterSchema.workspaceLicences).values({
    id: 'wsl_ml',
    workspaceId: 'ws_ml_partner',
    partnerId: 'ptr_ml',
    maxSeats: 3,
    resalePricing: {},
  });
  await master.insert(masterSchema.users).values([
    { id: 'user_ml_a', email: 'a@ml.test' },
    { id: 'user_ml_b', email: 'b@ml.test' },
  ]);
  // One seat each in the DB, matching Clerk below, so no background re-sync runs.
  await master.insert(masterSchema.userWorkspaces).values([
    { id: 'uw_ml_free', userId: 'user_ml_a', workspaceId: 'ws_ml_free', status: 'ACTIVE' },
    { id: 'uw_ml_seat', userId: 'user_ml_a', workspaceId: 'ws_ml_seat', status: 'ACTIVE' },
    { id: 'uw_ml_flat_a', userId: 'user_ml_a', workspaceId: 'ws_ml_flat', status: 'ACTIVE' },
    { id: 'uw_ml_flat_b', userId: 'user_ml_b', workspaceId: 'ws_ml_flat', status: 'PENDING' },
    { id: 'uw_ml_partner', userId: 'user_ml_a', workspaceId: 'ws_ml_partner', status: 'ACTIVE' },
  ]);

  const now = new Date();
  await tenant.insert(schema.workspaceMembers).values([
    { id: 'wm_ml_live', userId: 'user_ml_a', email: 'a@ml.test', role: 'OWNER', status: 'ACTIVE', createdAt: now, updatedAt: now },
    { id: 'wm_ml_gone', userId: 'user_ml_gone', email: 'gone@ml.test', role: 'MEMBER', status: 'ACTIVE', deletedAt: now, createdAt: now, updatedAt: now },
  ] as (typeof schema.workspaceMembers.$inferInsert)[]);
}, 60_000);

beforeEach(() => {
  clerk = stubClerk().scenario;
  clerk.memberships = [
    { id: 'orgmem_a', public_user_data: { user_id: 'user_ml_a', identifier: 'a@ml.test' } },
  ];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function get(orgId: string | null, perms = permissions('general:read')) {
  const t = createTestApp('/api/member-limits', memberLimitsRoutes, {
    context: { tenantDb: tenant, masterDb: master, orgId, permissions: perms },
  });
  return t.request('/api/member-limits');
}

describe('GET /api/member-limits', () => {
  it('needs an organization', async () => {
    const res = await get(null);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ORG_REQUIRED');
  });

  it('needs general:read', async () => {
    const res = await get('org_ml_free', permissions('team:read'));
    expect(res.status).toBe(403);
  });

  it('is a 404 for an org without a workspace', async () => {
    const res = await get('org_ml_missing');
    expect(res.status).toBe(404);
  });

  it("a plan's hard cap: the Free workspace is full with one member", async () => {
    const res = await get('org_ml_free');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { limit: 1, current: 1, atLimit: true, planName: 'Free' } });
  });

  it('a per-seat plan: included plus purchased; removed members and guest invitations do not count', async () => {
    clerk.memberships = [
      { id: 'orgmem_a', public_user_data: { user_id: 'user_ml_a', identifier: 'a@ml.test' } },
      // Removed in WeldSuite, still in Clerk: not a seat, and taken out of Clerk.
      { id: 'orgmem_gone', public_user_data: { user_id: 'user_ml_gone', identifier: 'gone@ml.test' } },
    ];
    clerk.invitations = [
      { id: 'orginv_guest', public_metadata: { member_type: 'EXTERNAL_GUEST' } },
      { id: 'orginv_teammate', public_metadata: {} },
    ];
    const res = await get('org_ml_seat');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { limit: 5, current: 2, atLimit: false, planName: 'Pro' } });
  });

  it('a plan without a cap is unlimited; pending DB rows count when Clerk is down', async () => {
    clerk.memberships = { status: 500 };
    clerk.invitations = { status: 500 };
    const res = await get('org_ml_flat');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { limit: null, current: 2, atLimit: false, planName: 'Flat' } });
  });

  it('a workspace without a plan is Free and unlimited', async () => {
    clerk.memberships = [];
    const res = await get('org_ml_none');
    expect(await res.json()).toEqual({ data: { limit: null, current: 0, atLimit: false, planName: 'Free' } });
  });

  it("a partner-managed workspace takes its licence's seats and names the partner", async () => {
    const res = await get('org_ml_partner');
    expect(await res.json()).toEqual({
      data: { limit: 3, current: 1, atLimit: false, planName: 'Licence', managedBy: 'Acme Partner' },
    });
  });

  it('finds the workspace by its own id too', async () => {
    const res = await get('ws_ml_free');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { planName: string } }).data.planName).toBe('Free');
  });
});
