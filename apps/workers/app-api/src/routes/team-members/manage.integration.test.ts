/**
 * The managing half of /api/team-members against pglite (tenant + master) and
 * a stubbed Clerk: POST /sync, POST /invite, PATCH /:id, DELETE /:id and
 * POST /:id/resend-invite, with every refusal.
 *
 * Clerk answers by URL from a scenario (src/test/fake-clerk-scenario.ts), never by call
 * order: in conformance mode the Rust backend's Clerk calls reach the same stub,
 * and the calls each backend made are compared. So assertions on the recorded
 * calls check that a call was made, not how often.
 *
 * The /sync tests come last: a sync touches every member row in the database.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { SYSTEM_ROLES } from '@weldsuite/permissions';
import type { ResolvedPermissions } from '@weldsuite/permissions/types';
import { stubClerk, type ClerkCall, type ClerkScenario } from '../../test/fake-clerk-scenario';

const state = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => state.master,
    getTenantDbForWorkspace: async () => state.tenant,
  };
});

import { teamMembersRoutes } from './index';

const { workspaceMembers, apiKeys } = schema;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for postgres-js
let master: any;
let db: Database;
let clerk: ClerkScenario;
let calls: ClerkCall[];

const MEMBER_PERMISSIONS = SYSTEM_ROLES.MEMBER!.permissions;
const ADMIN: ResolvedPermissions = permissions('*');

type MemberInsert = typeof workspaceMembers.$inferInsert;

async function seedMembers(rows: Array<Partial<MemberInsert> & { id: string; userId: string }>) {
  const now = new Date();
  await db
    .insert(workspaceMembers)
    .values(rows.map((row) => ({ role: 'MEMBER', status: 'ACTIVE', createdAt: now, updatedAt: now, ...row })) as MemberInsert[]);
}

async function memberRow(id: string) {
  const [row] = await db.select().from(workspaceMembers).where(eq(workspaceMembers.id, id));
  return row;
}

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db;
  db = (await createPgliteDb()).db;
  state.master = master;
  state.tenant = db;

  await master.insert(masterSchema.plans).values([
    { id: 'plan_tm_free', name: 'Free', slug: 'tm-free', maxUsers: 1 },
    { id: 'plan_tm_seat', name: 'Team', slug: 'tm-team', pricePerUser: '9.00', includedUsers: 2 },
  ]);
  await master.insert(masterSchema.partners).values({ id: 'ptr_tm', name: 'Reseller BV', billingEmail: 'b@reseller.test' });
  await master.insert(masterSchema.workspaces).values([
    { id: 'ws_tm_seat', clerkOrgId: 'org_tm_seat', name: 'Seat', slug: 'tm-seat', planId: 'plan_tm_seat', purchasedSeats: 3 },
    { id: 'ws_tm_free', clerkOrgId: 'org_tm_free', name: 'Free', slug: 'tm-free', planId: 'plan_tm_free' },
    { id: 'ws_tm_partner', clerkOrgId: 'org_tm_partner', name: 'Partner', slug: 'tm-partner', billingMode: 'partner', partnerId: 'ptr_tm' },
  ]);
  await master.insert(masterSchema.workspaceLicences).values({
    id: 'wsl_tm',
    workspaceId: 'ws_tm_partner',
    partnerId: 'ptr_tm',
    maxSeats: 1,
    resalePricing: {},
  });
  await master.insert(masterSchema.users).values({ id: 'user_tm_owner', email: 'owner@tm.test' });
  await master.insert(masterSchema.userWorkspaces).values([
    { id: 'uw_tm_seat', userId: 'user_tm_owner', workspaceId: 'ws_tm_seat', status: 'ACTIVE' },
    { id: 'uw_tm_free', userId: 'user_tm_owner', workspaceId: 'ws_tm_free', status: 'ACTIVE' },
    { id: 'uw_tm_partner', userId: 'user_tm_owner', workspaceId: 'ws_tm_partner', status: 'ACTIVE' },
  ]);

  const now = new Date();
  await db.insert(schema.roles).values([
    { id: 'role_tm_support', name: 'Support', permissions: ['tickets:read'], createdAt: now, updatedAt: now },
    { id: 'role_tm_boss', name: 'Admin', permissions: ['billing:manage'], createdAt: now, updatedAt: now },
    { id: 'role_tm_viewer', name: 'viewer', permissions: [], createdAt: now, updatedAt: now },
    { id: 'role_tm_roles', name: 'Role keeper', permissions: ['roles:delete'], createdAt: now, updatedAt: now },
  ]);
  await seedMembers([
    { id: 'wm_tm_owner', userId: 'user_tm_owner', email: 'owner@tm.test', role: 'OWNER', clerkMembershipId: 'orgmem_owner' },
    { id: 'wm_tm_taken', userId: 'invited_Taken@tm.test', status: 'PENDING' },
    { id: 'wm_tm_active', userId: 'user_tm_active', email: 'active@tm.test' },
    { id: 'wm_tm_pending', userId: 'invited_pending@tm.test', email: 'pending@tm.test', status: 'PENDING', clerkInvitationId: 'orginv_pending' },
  ]);
}, 60_000);

beforeEach(() => {
  ({ scenario: clerk, calls } = stubClerk());
  clerk.memberships = [{ id: 'orgmem_owner', public_user_data: { user_id: 'user_tm_owner', identifier: 'owner@tm.test' } }];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function app(perms: ResolvedPermissions = ADMIN, orgId: string | null = 'org_tm_seat') {
  return createTestApp('/api/team-members', teamMembersRoutes, {
    context: { tenantDb: db, masterDb: master, orgId, userId: 'user_tm_owner', permissions: perms },
  });
}

function send(method: string, path: string, body?: unknown, perms?: ResolvedPermissions, orgId?: string | null) {
  return app(perms, orgId === undefined ? 'org_tm_seat' : orgId).request(`/api/team-members${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function errorOf(res: Response) {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

const clerkCall = (method: string, suffix: string) =>
  calls.some((call) => call.method === method && call.url.endsWith(suffix));

// ───────────────────────────────────────────────────────────────────────────
// POST /invite
// ───────────────────────────────────────────────────────────────────────────

describe('POST /invite', () => {
  it('refuses a body that does not parse or validate', async () => {
    for (const body of ['not json', { email: 'nope', name: 'X' }, { email: 'a@tm.test', name: '' }, { email: 'a@tm.test', name: 'A', memberType: 'BOSS' }]) {
      const res = await send('POST', '/invite', body);
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toEqual({ code: 'BAD_REQUEST', message: 'Invalid request body' });
    }
  });

  it('needs an organization', async () => {
    const res = await send('POST', '/invite', { email: 'x@tm.test', name: 'X' }, ADMIN, null);
    expect(res.status).toBe(400);
  });

  it('needs team:create for a teammate and team:invite_external for a guest', async () => {
    const internal = await send('POST', '/invite', { email: 'x@tm.test', name: 'X' }, permissions('team:invite_external'));
    expect(internal.status).toBe(403);
    expect((await errorOf(internal)).message).toBe('Missing required permission: team:create');
    const guest = await send('POST', '/invite', { email: 'x@tm.test', name: 'X', memberType: 'EXTERNAL_GUEST' }, permissions('team:create'));
    expect(guest.status).toBe(403);
    expect((await errorOf(guest)).message).toBe('Missing required permission: team:invite_external');
  });

  it('is a 404 for an unknown role', async () => {
    const res = await send('POST', '/invite', { email: 'x@tm.test', name: 'X', roleId: 'role_missing' });
    expect(res.status).toBe(404);
    expect((await errorOf(res)).message).toBe("Role with ID 'role_missing' not found");
  });

  it('refuses a role that grants more than the inviter holds', async () => {
    const res = await send('POST', '/invite', { email: 'ceiling@tm.test', name: 'X', roleId: 'role_tm_roles' }, permissions('team:create', ...MEMBER_PERMISSIONS));
    expect(res.status).toBe(403);
    expect((await errorOf(res)).message).toBe('You cannot grant permissions you do not hold yourself');
  });

  it('refuses an address that is already a member or invited', async () => {
    const active = await send('POST', '/invite', { email: 'Active@tm.test', name: 'A' });
    expect(active.status).toBe(409);
    expect((await errorOf(active)).message).toBe('This email address is already a member of this workspace.');
    const pending = await send('POST', '/invite', { email: 'pending@tm.test', name: 'P' });
    expect(pending.status).toBe(409);
    expect((await errorOf(pending)).message).toBe('An invitation has already been sent to this email address.');
  });

  it("refuses a teammate when the plan's seats are taken", async () => {
    const res = await send('POST', '/invite', { email: 'full@tm.test', name: 'X' }, ADMIN, 'org_tm_free');
    expect(res.status).toBe(403);
    expect((await errorOf(res)).message).toBe(
      'Your Free plan includes 1 member. Upgrade your plan to invite more people.',
    );
  });

  it("names the partner when a licence's seats are taken", async () => {
    const res = await send('POST', '/invite', { email: 'licence@tm.test', name: 'X', memberType: 'EMPLOYEE' }, ADMIN, 'org_tm_partner');
    expect(res.status).toBe(403);
    expect((await errorOf(res)).message).toBe('Your licence includes 1 member. Ask Reseller BV to add more seats.');
  });

  it('invites a teammate: raises a stale Clerk cap, sends the invitation, writes the PENDING row', async () => {
    clerk.organization = { max_allowed_memberships: 1 };
    clerk.invitations = [{ id: 'orginv_guest', public_metadata: { member_type: 'EXTERNAL_GUEST' } }];
    clerk.invite = { status: 200, body: { id: 'orginv_newbie' } };
    const res = await send('POST', '/invite', { email: 'Newbie@tm.test', name: 'New Bie', roleId: 'role_tm_support' });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { memberId: string; memberType: string; activated: boolean } };
    expect(data).toMatchObject({ memberType: 'INTERNAL', activated: false });

    // Cap 1, five paid seats plus one guest invitation.
    expect(calls.some((c) => c.method === 'PATCH' && JSON.stringify(c.body) === '{"max_allowed_memberships":6}')).toBe(true);
    const invite = calls.find((c) => c.method === 'POST' && c.url.endsWith('/organizations/org_tm_seat/invitations'));
    expect(invite?.body).toEqual({
      email_address: 'Newbie@tm.test',
      role: 'org:member',
      redirect_url: 'https://app-test.weldsuite.org/invite?org_id=org_tm_seat',
    });

    const row = await memberRow(data.memberId);
    expect(row).toMatchObject({
      userId: 'invited_Newbie@tm.test',
      email: 'newbie@tm.test',
      name: 'New Bie',
      role: 'SUPPORT',
      roleId: 'role_tm_support',
      status: 'PENDING',
      memberType: 'INTERNAL',
      clerkInvitationId: 'orginv_newbie',
      invitedBy: 'user_tm_owner',
      permissions: [],
    });
  });

  it('invites an EMPLOYEE member on VIEWER without a role', async () => {
    const res = await send('POST', '/invite', { email: 'staff@tm.test', name: 'Staff', roleId: 'role_tm_boss', memberType: 'EMPLOYEE' });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { memberId: string } };
    expect(await memberRow(data.memberId)).toMatchObject({ role: 'VIEWER', roleId: null, memberType: 'EMPLOYEE' });
  });

  it('adds a guest who already has a Clerk account straight to the organization', async () => {
    clerk.organization = { max_allowed_memberships: 1 };
    clerk.users = { 'guest@tm.test': ['user_tm_guest'] };
    clerk.addMembership = { status: 200, body: { id: 'orgmem_guest' } };
    const res = await send('POST', '/invite', { email: 'guest@tm.test', name: 'Guest', memberType: 'EXTERNAL_GUEST' }, permissions('team:invite_external'));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { memberId: string; memberType: string; activated: boolean } };
    expect(data).toMatchObject({ memberType: 'EXTERNAL_GUEST', activated: true });
    // Full at one membership: the cap goes up by one first.
    expect(calls.some((c) => c.method === 'PATCH' && JSON.stringify(c.body) === '{"max_allowed_memberships":2}')).toBe(true);
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/memberships'))?.body).toEqual({
      user_id: 'user_tm_guest',
      role: 'org:member',
      public_metadata: { member_type: 'EXTERNAL_GUEST' },
    });
    expect(await memberRow(data.memberId)).toMatchObject({
      userId: 'user_tm_guest',
      role: 'VIEWER',
      status: 'ACTIVE',
      memberType: 'EXTERNAL_GUEST',
      clerkMembershipId: 'orgmem_guest',
      permissions: ['channels:read', 'channels:create_message', 'channels:update_own'],
    });
  });

  it('invites a guest without a Clerk account by email, tagged as a guest', async () => {
    clerk.invite = { status: 200, body: { id: 'orginv_ext' } };
    const res = await send('POST', '/invite', { email: 'outsider@tm.test', name: 'Out', memberType: 'EXTERNAL_GUEST' }, permissions('team:invite_external'));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { memberId: string } };
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/invitations'))?.body).toMatchObject({
      public_metadata: { member_type: 'EXTERNAL_GUEST' },
    });
    expect(await memberRow(data.memberId)).toMatchObject({
      role: 'VIEWER',
      status: 'PENDING',
      memberType: 'EXTERNAL_GUEST',
      permissions: ['channels:read', 'channels:create_message', 'channels:update_own'],
    });
  });

  it("maps Clerk's refusals of a direct guest add", async () => {
    clerk.users = { 'guest2@tm.test': ['user_tm_guest2'] };
    const guest = { email: 'guest2@tm.test', name: 'G', memberType: 'EXTERNAL_GUEST' };
    const cases: Array<[unknown, number, string]> = [
      [{ errors: [{ code: 'organization_membership_quota_exceeded' }] }, 403, "This workspace's member limit prevents adding this guest. Upgrade your plan or remove a member or pending invitation, then try again."],
      [{ errors: [{ code: 'already_a_member_in_organization' }] }, 409, 'This person is already a member of this workspace.'],
      [{ errors: [{ code: 'form_param_invalid', long_message: 'Bad role', message: 'bad' }] }, 500, 'Failed to add guest to Clerk organization: Bad role'],
      [{}, 500, 'Failed to add guest to Clerk organization'],
    ];
    for (const [body, status, message] of cases) {
      clerk.addMembership = { status: 400, body };
      const res = await send('POST', '/invite', guest, ADMIN);
      expect(res.status).toBe(status);
      expect((await errorOf(res)).message).toBe(message);
    }
  });

  it("maps Clerk's refusals of an invitation", async () => {
    const cases: Array<[number, unknown, number, string]> = [
      [403, { errors: [{ code: 'organization_membership_quota_exceeded' }] }, 403, 'Your plan has no seats left. Upgrade your plan, or remove a member or pending invitation, then try again.'],
      [400, { errors: [{ code: 'duplicate_record' }] }, 409, 'An invitation for this email already exists in Clerk.'],
      [422, {}, 409, 'An invitation for this email already exists in Clerk.'],
      [500, {}, 500, 'Failed to create Clerk invitation'],
    ];
    for (const [clerkStatus, body, status, message] of cases) {
      clerk.invite = { status: clerkStatus, body };
      const res = await send('POST', '/invite', { email: 'refused@tm.test', name: 'R' });
      expect(res.status).toBe(status);
      expect((await errorOf(res)).message).toBe(message);
    }
  });

  it('revokes the invitation when the PENDING row cannot be written', async () => {
    clerk.invite = { status: 200, body: { id: 'orginv_orphan' } };
    const res = await send('POST', '/invite', { email: 'Taken@tm.test', name: 'T' });
    expect(res.status).toBe(500);
    expect((await errorOf(res)).message).toBe('Failed to create invitation');
    expect(clerkCall('POST', '/invitations/orginv_orphan/revoke')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// PATCH /:id
// ───────────────────────────────────────────────────────────────────────────

describe('PATCH /:id', () => {
  beforeAll(async () => {
    await seedMembers([
      { id: 'wm_tm_p_role', userId: 'user_tm_p_role', email: 'role@tm.test', clerkMembershipId: 'orgmem_p_role' },
      { id: 'wm_tm_p_fields', userId: 'user_tm_p_fields', email: 'fields@tm.test', permissions: ['tickets:read'], permissionDenies: ['companies:read'] },
      { id: 'wm_tm_p_pending', userId: 'invited_p@tm.test', status: 'PENDING' },
      { id: 'wm_tm_p_employee', userId: 'user_tm_p_employee', memberType: 'EMPLOYEE' },
    ]);
  });

  it('needs team:update, an organization and a valid body', async () => {
    expect((await send('PATCH', '/wm_tm_p_role', { name: 'X' }, permissions('team:read'))).status).toBe(403);
    expect((await send('PATCH', '/wm_tm_p_role', { name: 'X' }, ADMIN, null)).status).toBe(400);
    for (const body of ['nope', { role: 'ADMIN', roleId: 'role_tm_support' }, { role: 'OWNER' }, { name: '' }, { permissions: [1] }]) {
      const res = await send('PATCH', '/wm_tm_p_role', body);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).message).toBe('Invalid request body');
    }
  });

  it('is a 404 for an unknown member', async () => {
    const res = await send('PATCH', '/wm_missing', { name: 'X' });
    expect(res.status).toBe(404);
    expect((await errorOf(res)).message).toBe("Member with ID 'wm_missing' not found");
  });

  it('refuses extras and lifted denies the caller does not hold', async () => {
    const caller = permissions('team:update', 'tickets:read');
    const extras = await send('PATCH', '/wm_tm_p_fields', { permissions: ['tickets:read', 'billing:manage'] }, caller);
    expect(extras.status).toBe(403);
    expect((await errorOf(extras)).message).toBe('You cannot grant permissions you do not hold yourself');
    const lift = await send('PATCH', '/wm_tm_p_fields', { permissionDenies: [] }, caller);
    expect(lift.status).toBe(403);
    expect((await errorOf(lift)).message).toBe('You cannot lift a deny on a permission you do not hold yourself');
  });

  it('guards the role: owner, not active, employee, unknown role, grant ceiling', async () => {
    const owner = await send('PATCH', '/wm_tm_owner', { role: 'ADMIN' });
    expect([owner.status, (await errorOf(owner)).message]).toEqual([403, 'Cannot change the role of the workspace owner.']);
    const pending = await send('PATCH', '/wm_tm_p_pending', { role: 'ADMIN' });
    expect([pending.status, (await errorOf(pending)).message]).toEqual([400, 'Can only update role of an active member.']);
    const employee = await send('PATCH', '/wm_tm_p_employee', { role: 'ADMIN' });
    expect(employee.status).toBe(400);
    const unknown = await send('PATCH', '/wm_tm_p_role', { roleId: 'role_missing' });
    expect([unknown.status, (await errorOf(unknown)).message]).toEqual([404, "Role with ID 'role_missing' not found"]);
    const ceiling = await send('PATCH', '/wm_tm_p_role', { role: 'ADMIN' }, permissions('team:update', ...MEMBER_PERMISSIONS));
    expect([ceiling.status, (await errorOf(ceiling)).message]).toEqual([403, 'You cannot grant permissions you do not hold yourself']);
  });

  it('answers 500 when Clerk refuses the role change, and leaves the row', async () => {
    clerk.setRole = { status: 500 };
    const res = await send('PATCH', '/wm_tm_p_role', { role: 'ADMIN' });
    expect([res.status, (await errorOf(res)).message]).toEqual([500, 'Failed to update role in Clerk']);
    expect((await memberRow('wm_tm_p_role'))?.role).toBe('MEMBER');
  });

  it('changes the role in Clerk and the database; a custom role maps onto its tier', async () => {
    const res = await send('PATCH', '/wm_tm_p_role', { roleId: 'role_tm_boss' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'wm_tm_p_role' } });
    expect(calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/memberships/user_tm_p_role'))?.body).toEqual({ role: 'org:admin' });
    expect(await memberRow('wm_tm_p_role')).toMatchObject({ role: 'ADMIN', roleId: 'role_tm_boss' });

    const back = await send('PATCH', '/wm_tm_p_role', { roleId: 'role_tm_viewer' });
    expect(back.status).toBe(200);
    expect(await memberRow('wm_tm_p_role')).toMatchObject({ role: 'VIEWER', roleId: 'role_tm_viewer' });
  });

  it('writes the name, extras, denies and hours without touching the role or Clerk', async () => {
    const res = await send('PATCH', '/wm_tm_p_fields', {
      name: 'Renamed',
      permissions: ['tickets:read', 'tickets:update'],
      permissionDenies: ['companies:read', 'leads:read'],
      hoursPerWeek: '32.5',
    });
    expect(res.status).toBe(200);
    expect(await memberRow('wm_tm_p_fields')).toMatchObject({
      name: 'Renamed',
      role: 'MEMBER',
      permissions: ['tickets:read', 'tickets:update'],
      permissionDenies: ['companies:read', 'leads:read'],
      hoursPerWeek: '32.50',
    });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// DELETE /:id
// ───────────────────────────────────────────────────────────────────────────

describe('DELETE /:id', () => {
  beforeAll(async () => {
    await seedMembers([
      { id: 'wm_tm_d_leaver', userId: 'user_tm_d_leaver', email: 'leaver@tm.test', clerkMembershipId: 'orgmem_d_leaver' },
      { id: 'wm_tm_d_ghost', userId: 'user_tm_d_ghost', email: 'ghost@tm.test', clerkMembershipId: 'orgmem_d_ghost' },
      { id: 'wm_tm_d_stuck', userId: 'user_tm_d_stuck', email: 'stuck@tm.test', clerkMembershipId: 'orgmem_d_stuck' },
      { id: 'wm_tm_d_invite', userId: 'invited_d@tm.test', email: 'd@tm.test', status: 'PENDING', clerkInvitationId: 'orginv_d' },
      { id: 'wm_tm_d_invite2', userId: 'invited_d2@tm.test', email: 'd2@tm.test', status: 'PENDING', clerkInvitationId: 'orginv_d2' },
    ]);
    const key = (id: string, userId: string) =>
      ({ id, name: id, keyHash: `hash_${id}`, keyPrefix: 'wsk_test', userId }) as typeof apiKeys.$inferInsert;
    await db.insert(apiKeys).values([key('ak_tm_leaver', 'user_tm_d_leaver'), key('ak_tm_owner', 'user_tm_owner')]);
    await master.insert(masterSchema.apiKeyRegistry).values([
      { id: 'akr_tm_leaver', keyHash: 'reg_leaver', keyType: 'personal', workspaceId: 'ws_tm_seat', tenantKeyId: 'ak_tm_leaver' },
      { id: 'akr_tm_owner', keyHash: 'reg_owner', keyType: 'personal', workspaceId: 'ws_tm_seat', tenantKeyId: 'ak_tm_owner' },
    ]);
  });

  it('needs team:delete and an organization; 404 for an unknown member; never the owner', async () => {
    expect((await send('DELETE', '/wm_tm_d_leaver', undefined, permissions('team:update'))).status).toBe(403);
    expect((await send('DELETE', '/wm_tm_d_leaver', undefined, ADMIN, null)).status).toBe(400);
    expect((await send('DELETE', '/wm_missing')).status).toBe(404);
    const owner = await send('DELETE', '/wm_tm_owner');
    expect([owner.status, (await errorOf(owner)).message]).toEqual([403, 'Cannot remove the workspace owner.']);
  });

  it('keeps the member when Clerk will not remove them', async () => {
    clerk.removeMembership = { status: 500 };
    const res = await send('DELETE', '/wm_tm_d_stuck');
    expect([res.status, (await errorOf(res)).message]).toEqual([500, 'Failed to remove member from Clerk organization']);
    expect((await memberRow('wm_tm_d_stuck'))?.deletedAt).toBeNull();
  });

  it('removes a member from Clerk by user id, soft-deletes them and revokes their API keys', async () => {
    const res = await send('DELETE', '/wm_tm_d_leaver');
    expect(res.status).toBe(204);
    expect(clerkCall('DELETE', '/organizations/org_tm_seat/memberships/user_tm_d_leaver')).toBe(true);
    expect((await memberRow('wm_tm_d_leaver'))?.deletedAt).not.toBeNull();
    const live = await db.select().from(apiKeys).where(and(eq(apiKeys.userId, 'user_tm_d_leaver'), isNull(apiKeys.deletedAt)));
    expect(live).toEqual([]);
    const registry = await master.select().from(masterSchema.apiKeyRegistry);
    expect(registry.map((r: { tenantKeyId: string }) => r.tenantKeyId)).toEqual(['ak_tm_owner']);
  });

  it('treats a member Clerk no longer has as removed', async () => {
    clerk.removeMembership = { status: 404 };
    expect((await send('DELETE', '/wm_tm_d_ghost')).status).toBe(204);
    expect((await memberRow('wm_tm_d_ghost'))?.deletedAt).not.toBeNull();
  });

  it('cancels an invitation: revoked in Clerk (404 is fine), refused on another failure', async () => {
    clerk.revoke = { status: 500 };
    const refused = await send('DELETE', '/wm_tm_d_invite2');
    expect([refused.status, (await errorOf(refused)).message]).toEqual([500, 'Failed to revoke invitation in Clerk']);

    clerk.revoke = { status: 404 };
    expect((await send('DELETE', '/wm_tm_d_invite')).status).toBe(204);
    expect(clerkCall('POST', '/invitations/orginv_d/revoke')).toBe(true);
    expect((await memberRow('wm_tm_d_invite'))?.deletedAt).not.toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /:id/resend-invite
// ───────────────────────────────────────────────────────────────────────────

describe('POST /:id/resend-invite', () => {
  beforeAll(async () => {
    await seedMembers([
      { id: 'wm_tm_r_admin', userId: 'invited_r@tm.test', email: 'r@tm.test', role: 'ADMIN', status: 'PENDING', clerkInvitationId: 'orginv_r_old' },
      { id: 'wm_tm_r_noemail', userId: 'invited_noemail', status: 'PENDING' },
    ]);
  });

  it('needs team:update and an organization; 404 for an unknown member', async () => {
    expect((await send('POST', '/wm_tm_r_admin/resend-invite', undefined, permissions('team:read'))).status).toBe(403);
    expect((await send('POST', '/wm_tm_r_admin/resend-invite', undefined, ADMIN, null)).status).toBe(400);
    expect((await send('POST', '/wm_missing/resend-invite')).status).toBe(404);
  });

  it('only resends to a pending member with an email address', async () => {
    const active = await send('POST', '/wm_tm_active/resend-invite');
    expect([active.status, (await errorOf(active)).message]).toEqual([400, 'Can only resend invite to a pending member.']);
    const noEmail = await send('POST', '/wm_tm_r_noemail/resend-invite');
    expect([noEmail.status, (await errorOf(noEmail)).message]).toEqual([400, 'Pending member has no email address.']);
  });

  it('answers 500 when Clerk will not create the new invitation', async () => {
    clerk.invite = { status: 500 };
    const res = await send('POST', '/wm_tm_r_admin/resend-invite');
    expect([res.status, (await errorOf(res)).message]).toEqual([500, 'Failed to resend invitation via Clerk']);
    expect((await memberRow('wm_tm_r_admin'))?.clerkInvitationId).toBe('orginv_r_old');
  });

  it('revokes the old invitation (failure ignored) and stores the new one', async () => {
    clerk.revoke = { status: 500 };
    clerk.invite = { status: 200, body: { id: 'orginv_r_new' } };
    const res = await send('POST', '/wm_tm_r_admin/resend-invite');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { success: true } });
    expect(clerkCall('POST', '/invitations/orginv_r_old/revoke')).toBe(true);
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/invitations'))?.body).toEqual({
      email_address: 'r@tm.test',
      role: 'org:admin',
      redirect_url: 'https://app-test.weldsuite.org/invite?org_id=org_tm_seat',
    });
    expect((await memberRow('wm_tm_r_admin'))?.clerkInvitationId).toBe('orginv_r_new');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /sync (last: it touches every row)
// ───────────────────────────────────────────────────────────────────────────

describe('POST /sync', () => {
  beforeAll(async () => {
    await seedMembers([
      { id: 'wm_tm_s_stays', userId: 'user_tm_s_stays', email: 'stays@tm.test', clerkMembershipId: 'orgmem_s_stays' },
      { id: 'wm_tm_s_left', userId: 'user_tm_s_left', email: 'left@tm.test', clerkMembershipId: 'orgmem_s_left' },
      { id: 'wm_tm_s_waiting', userId: 'invited_wait@tm.test', status: 'PENDING', clerkInvitationId: 'orginv_s_waiting' },
      { id: 'wm_tm_s_expired', userId: 'invited_exp@tm.test', status: 'PENDING', clerkInvitationId: 'orginv_s_expired' },
    ]);
    await db.insert(apiKeys).values({ id: 'ak_tm_s_left', name: 'left', keyHash: 'hash_s_left', keyPrefix: 'wsk_test', userId: 'user_tm_s_left' } as typeof apiKeys.$inferInsert);
  });

  it('needs team:read and an organization', async () => {
    expect((await send('POST', '/sync', undefined, permissions('team:update'))).status).toBe(403);
    expect((await send('POST', '/sync', undefined, ADMIN, null)).status).toBe(400);
  });

  it('answers 500 when Clerk refuses or cannot be reached', async () => {
    clerk.memberships = { status: 500 };
    const refused = await send('POST', '/sync');
    expect([refused.status, (await errorOf(refused)).message]).toEqual([500, 'Failed to fetch data from Clerk']);
    clerk.memberships = [];
    clerk.invitations = { status: 0 };
    const down = await send('POST', '/sync');
    expect([down.status, (await errorOf(down)).message]).toEqual([500, 'Failed to sync team from Clerk']);
  });

  it('drops members who left Clerk (and their keys) and invitations no longer pending', async () => {
    clerk.memberships = [
      { id: 'orgmem_owner', public_user_data: { user_id: 'user_tm_owner', identifier: 'owner@tm.test' } },
      { id: 'orgmem_s_stays', public_user_data: { user_id: 'user_tm_s_stays', identifier: 'stays@tm.test' } },
    ];
    clerk.invitations = [{ id: 'orginv_s_waiting' }];
    const res = await send('POST', '/sync');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { synced: true } });
    expect((await memberRow('wm_tm_s_stays'))?.deletedAt).toBeNull();
    expect((await memberRow('wm_tm_s_left'))?.deletedAt).not.toBeNull();
    expect((await memberRow('wm_tm_s_waiting'))?.deletedAt).toBeNull();
    expect((await memberRow('wm_tm_s_expired'))?.deletedAt).not.toBeNull();
    // Provisioned without Clerk: left alone.
    expect((await memberRow('wm_tm_active'))?.deletedAt).toBeNull();
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, 'ak_tm_s_left'));
    expect(key?.deletedAt).not.toBeNull();
  });

  it('with no pending invitation left in Clerk, every invited row goes', async () => {
    clerk.memberships = [];
    clerk.invitations = [];
    expect((await send('POST', '/sync')).status).toBe(200);
    expect((await memberRow('wm_tm_s_waiting'))?.deletedAt).not.toBeNull();
    // An empty membership list removes nobody.
    expect((await memberRow('wm_tm_s_stays'))?.deletedAt).toBeNull();
  });
});
