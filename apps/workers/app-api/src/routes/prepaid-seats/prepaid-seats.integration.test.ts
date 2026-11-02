/**
 * GET /api/prepaid-seats against pglite (tenant + master) and a stubbed Clerk:
 * the seats paid for (plan's included users plus purchased seats, or a
 * partner licence's cap), the seats in use from Clerk (removed members left
 * out, guest invitations not counted) with the DB count as fallback, and the
 * refusals.
 *
 * Clerk answers by URL (src/test/fake-clerk-scenario.ts), so the conformance
 * suite can run these against the Rust backend too.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { stubClerk, type ClerkScenario } from '../../test/fake-clerk-scenario';

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

import { prepaidSeatsRoutes } from './index';

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
    { id: 'plan_ps_free', name: 'Free', slug: 'ps-free', maxUsers: 1 },
    { id: 'plan_ps_seat', name: 'Pro', slug: 'ps-pro', pricePerUser: '12.00', includedUsers: 2 },
    { id: 'plan_ps_flat', name: 'Flat', slug: 'ps-flat', includedUsers: null },
  ]);
  await master.insert(masterSchema.partners).values({
    id: 'ptr_ps',
    name: 'Acme Partner',
    billingEmail: 'billing@partner.test',
  });
  await master.insert(masterSchema.workspaces).values([
    { id: 'ws_ps_free', clerkOrgId: 'org_ps_free', name: 'Free WS', slug: 'ps-free-ws', planId: 'plan_ps_free' },
    { id: 'ws_ps_seat', clerkOrgId: 'org_ps_seat', name: 'Seat WS', slug: 'ps-seat-ws', planId: 'plan_ps_seat', purchasedSeats: 3 },
    { id: 'ws_ps_flat', clerkOrgId: 'org_ps_flat', name: 'Flat WS', slug: 'ps-flat-ws', planId: 'plan_ps_flat', purchasedSeats: 1 },
    { id: 'ws_ps_none', clerkOrgId: 'org_ps_none', name: 'No plan WS', slug: 'ps-none-ws', purchasedSeats: 2 },
    { id: 'ws_ps_over', clerkOrgId: 'org_ps_over', name: 'Over WS', slug: 'ps-over-ws', planId: 'plan_ps_free' },
    { id: 'ws_ps_partner', clerkOrgId: 'org_ps_partner', name: 'Partner WS', slug: 'ps-partner-ws', billingMode: 'partner', partnerId: 'ptr_ps' },
    { id: 'ws_ps_open', clerkOrgId: 'org_ps_open', name: 'Open partner WS', slug: 'ps-open-ws', billingMode: 'partner', partnerId: 'ptr_ps' },
    { id: 'ws_ps_nolicence', clerkOrgId: 'org_ps_nolicence', name: 'No licence WS', slug: 'ps-nolicence-ws', billingMode: 'partner', partnerId: 'ptr_ps' },
  ]);
  await master.insert(masterSchema.workspaceLicences).values([
    { id: 'wsl_ps', workspaceId: 'ws_ps_partner', partnerId: 'ptr_ps', maxSeats: 2, resalePricing: {} },
    { id: 'wsl_ps_open', workspaceId: 'ws_ps_open', partnerId: 'ptr_ps', maxSeats: null, resalePricing: {} },
  ]);
  await master.insert(masterSchema.users).values([
    { id: 'user_ps_a', email: 'a@ps.test' },
    { id: 'user_ps_b', email: 'b@ps.test' },
    { id: 'user_ps_x', email: 'x@ps.test' },
    { id: 'user_ps_y', email: 'y@ps.test' },
  ]);
  // One seat each in the DB, matching Clerk below, so no background re-sync runs.
  await master.insert(masterSchema.userWorkspaces).values([
    { id: 'uw_ps_free', userId: 'user_ps_a', workspaceId: 'ws_ps_free', status: 'ACTIVE' },
    { id: 'uw_ps_seat', userId: 'user_ps_a', workspaceId: 'ws_ps_seat', status: 'ACTIVE' },
    { id: 'uw_ps_flat_a', userId: 'user_ps_a', workspaceId: 'ws_ps_flat', status: 'ACTIVE' },
    { id: 'uw_ps_flat_b', userId: 'user_ps_b', workspaceId: 'ws_ps_flat', status: 'PENDING' },
    { id: 'uw_ps_none', userId: 'user_ps_a', workspaceId: 'ws_ps_none', status: 'ACTIVE' },
    { id: 'uw_ps_partner', userId: 'user_ps_a', workspaceId: 'ws_ps_partner', status: 'ACTIVE' },
    { id: 'uw_ps_open', userId: 'user_ps_a', workspaceId: 'ws_ps_open', status: 'ACTIVE' },
    { id: 'uw_ps_nolicence', userId: 'user_ps_a', workspaceId: 'ws_ps_nolicence', status: 'ACTIVE' },
    { id: 'uw_ps_over_a', userId: 'user_ps_a', workspaceId: 'ws_ps_over', status: 'ACTIVE' },
    { id: 'uw_ps_over_x', userId: 'user_ps_x', workspaceId: 'ws_ps_over', status: 'ACTIVE' },
    { id: 'uw_ps_over_y', userId: 'user_ps_y', workspaceId: 'ws_ps_over', status: 'ACTIVE' },
  ]);

  const now = new Date();
  await tenant.insert(schema.workspaceMembers).values([
    { id: 'wm_ps_live', userId: 'user_ps_a', email: 'a@ps.test', role: 'OWNER', status: 'ACTIVE', createdAt: now, updatedAt: now },
    { id: 'wm_ps_gone', userId: 'user_ps_gone', email: 'gone@ps.test', role: 'MEMBER', status: 'ACTIVE', deletedAt: now, createdAt: now, updatedAt: now },
  ] as (typeof schema.workspaceMembers.$inferInsert)[]);
}, 60_000);

beforeEach(() => {
  clerk = stubClerk().scenario;
  clerk.memberships = [
    { id: 'orgmem_a', public_user_data: { user_id: 'user_ps_a', identifier: 'a@ps.test' } },
  ];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function get(orgId: string | null, perms = permissions('general:read')) {
  const t = createTestApp('/api/prepaid-seats', prepaidSeatsRoutes, {
    context: { tenantDb: tenant, masterDb: master, orgId, permissions: perms },
  });
  return t.request('/api/prepaid-seats');
}

describe('GET /api/prepaid-seats', () => {
  it('needs an organization', async () => {
    const res = await get(null);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ORG_REQUIRED');
  });

  it('needs general:read', async () => {
    const res = await get('org_ps_free', permissions('team:read'));
    expect(res.status).toBe(403);
  });

  it('is a 404 for an org without a workspace', async () => {
    const res = await get('org_ps_missing');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } });
  });

  it('looks the workspace up by its Clerk organization only', async () => {
    const res = await get('ws_ps_free');
    expect(res.status).toBe(404);
  });

  it('a plan without included users has one seat: the Free workspace is full with one member', async () => {
    const res = await get('org_ps_free');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { prepaidSeats: 1, usedSeats: 1, availableSeats: 0, canAddMore: false },
    });
  });

  it('included plus purchased seats; removed members and guest invitations do not count', async () => {
    clerk.memberships = [
      { id: 'orgmem_a', public_user_data: { user_id: 'user_ps_a', identifier: 'a@ps.test' } },
      // Removed in WeldSuite, still in Clerk: not a seat, and taken out of Clerk.
      { id: 'orgmem_gone', public_user_data: { user_id: 'user_ps_gone', identifier: 'gone@ps.test' } },
    ];
    clerk.invitations = [
      { id: 'orginv_guest', public_metadata: { member_type: 'EXTERNAL_GUEST' } },
      { id: 'orginv_teammate', public_metadata: {} },
    ];
    const res = await get('org_ps_seat');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { prepaidSeats: 5, usedSeats: 2, availableSeats: 3, canAddMore: true },
    });
  });

  it('pending DB rows count when Clerk is down, and the plan’s null included users is one', async () => {
    clerk.memberships = { status: 500 };
    clerk.invitations = { status: 500 };
    const res = await get('org_ps_flat');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { prepaidSeats: 2, usedSeats: 2, availableSeats: 0, canAddMore: false },
    });
  });

  it('Clerk unreachable: the DB count, and no pending invitations', async () => {
    clerk.memberships = { status: 0 };
    clerk.invitations = { status: 0 };
    const res = await get('org_ps_seat');
    expect(await res.json()).toEqual({
      data: { prepaidSeats: 5, usedSeats: 1, availableSeats: 4, canAddMore: true },
    });
  });

  it('a workspace without a plan: one included seat plus the purchased ones', async () => {
    const res = await get('org_ps_none');
    expect(await res.json()).toEqual({
      data: { prepaidSeats: 3, usedSeats: 1, availableSeats: 2, canAddMore: true },
    });
  });

  it('more members than seats leaves none available, never a negative count', async () => {
    clerk.memberships = [
      { id: 'orgmem_a', public_user_data: { user_id: 'user_ps_a', identifier: 'a@ps.test' } },
      { id: 'orgmem_x', public_user_data: { user_id: 'user_ps_x', identifier: 'x@ps.test' } },
      { id: 'orgmem_y', public_user_data: { user_id: 'user_ps_y', identifier: 'y@ps.test' } },
    ];
    // A seat cap lowered in the DB after the members joined.
    const res = await get('org_ps_over');
    expect(await res.json()).toEqual({
      data: { prepaidSeats: 1, usedSeats: 3, availableSeats: 0, canAddMore: false },
    });
  });

  it("a partner-managed workspace takes its licence's seat cap", async () => {
    clerk.invitations = [{ id: 'orginv_teammate', public_metadata: {} }];
    const res = await get('org_ps_partner');
    expect(await res.json()).toEqual({
      data: { prepaidSeats: 2, usedSeats: 2, availableSeats: 0, canAddMore: false },
    });
  });

  it('a partner licence without a cap is unlimited', async () => {
    const res = await get('org_ps_open');
    expect(await res.json()).toEqual({
      data: { prepaidSeats: 1, usedSeats: 1, availableSeats: 0, canAddMore: true },
    });
  });

  it('a partner-managed workspace without a licence is unlimited too', async () => {
    const res = await get('org_ps_nolicence');
    expect(await res.json()).toEqual({
      data: { prepaidSeats: 1, usedSeats: 1, availableSeats: 0, canAddMore: true },
    });
  });
});
