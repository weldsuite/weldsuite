/**
 * /api/invitations against a real master database (pglite) with Clerk as a
 * fetch stub: invitation details found through the caller's Clerk orgs, the
 * flags (expired, used), the 404 and 500, and accepting an invitation when
 * the member row was already linked (the first of the caller's orgs that is a
 * workspace). Conformance-ready (rust/conformance/suites.json).
 *
 * The workspaces here have no tenant database configured, so the tenant-DB
 * paths (the details fallback, linking a pending member) find nothing on both
 * backends: those writes go to another workspace's database, which the
 * harness does not share with the Rust server.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { clerkCalls, clerkError, stubClerk, type ClerkRoutes } from '../../test/fake-clerk';

// Conformance mode runs every write on both backends, each on a fresh copy.
vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getMasterDb: () => conformanceMasterDb(holder.master),
}));
// The session comes from the test context; the router's own Clerk check is skipped.
vi.mock('@weldsuite/worker-kit/middleware/clerk', () => ({
  clerkMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

import { invitationsRoutes } from './index';

const { workspaces } = masterSchema;
const USER = 'user_inv';
const IN_2100 = 4_102_444_800_000;
/** The tenant-DB lookup's cache: always a miss, so it reads the master row. */
const kv = { get: async () => null, put: async () => undefined, delete: async () => undefined };

let tenantDb: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
  await master.insert(workspaces).values([
    { id: 'ws_inv_a', clerkOrgId: 'org_inv_a', name: 'Inv A', slug: 'inv-a' },
    { id: 'ws_inv_b', clerkOrgId: 'org_inv_b', name: 'Inv B', slug: 'inv-b' },
  ]);
}, 180_000);

afterEach(() => {
  vi.unstubAllGlobals();
});

function membership(org: string, name: string, role = 'org:member') {
  return {
    id: `orgmem_${org}`,
    role,
    organization: { id: org, name, slug: org, image_url: null },
    public_user_data: { user_id: USER, identifier: 'invitee@example.com', first_name: 'In', last_name: 'Vitee', image_url: null },
  };
}

/** Clerk with the caller in `orgs`, and the invitations given per org. */
function clerk(orgs: ReturnType<typeof membership>[], invitations: Record<string, Record<string, unknown>> = {}): ClerkRoutes {
  return (method, path) => {
    if (method !== 'GET') return undefined;
    if (path === `/users/${USER}/organization_memberships?limit=100`) return { status: 200, body: { data: orgs, total_count: orgs.length } };
    const match = /^\/organizations\/([^/]+)\/invitations\/([^/?]+)$/.exec(path);
    const invitation = match ? invitations[`${match[1]}/${match[2]}`] : undefined;
    return invitation ? { status: 200, body: invitation } : undefined;
  };
}

function invitation(id: string, overrides: Record<string, unknown> = {}) {
  return { id, email_address: 'invitee@example.com', role: 'org:member', status: 'pending', created_at: 1, expires_at: IN_2100, ...overrides };
}

function app() {
  return createTestApp('/api/invitations', invitationsRoutes, {
    context: { userId: USER, orgId: null, tenantDb, masterDb: master },
    env: { WORKSPACE_CACHE: kv as unknown as KVNamespace },
  });
}

describe('GET /api/invitations/:token', () => {
  it("finds the invitation in one of the caller's orgs", async () => {
    const stub = stubClerk(
      clerk([membership('org_inv_x', 'Not a workspace'), membership('org_inv_a', 'Clerk A')], {
        'org_inv_a/inv_1': invitation('inv_1'),
      }),
    );
    const res = await app().request('/api/invitations/inv_1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        workspaceId: 'org_inv_a',
        workspaceName: 'Inv A',
        role: 'org:member',
        inviteeEmail: 'invitee@example.com',
        inviteeName: '',
        isExpired: false,
        isUsed: false,
        expiresAt: '2100-01-01T00:00:00.000Z',
      },
    });
    expect(clerkCalls(stub)).toContain('GET /organizations/org_inv_x/invitations/inv_1');
  });

  it('flags an expired or used invitation, and names an org without a workspace', async () => {
    stubClerk(
      clerk([membership('org_inv_x', 'Clerk X')], {
        'org_inv_x/inv_2': invitation('inv_2', { status: 'accepted', expires_at: 1_000 }),
        'org_inv_x/inv_3': invitation('inv_3', { status: 'revoked', expires_at: null }),
      }),
    );
    const used = (await (await app().request('/api/invitations/inv_2')).json()) as { data: Record<string, unknown> };
    expect(used.data).toMatchObject({ workspaceName: 'Clerk X', isExpired: true, isUsed: true, expiresAt: '1970-01-01T00:00:01.000Z' });
    const revoked = (await (await app().request('/api/invitations/inv_3')).json()) as { data: Record<string, unknown> };
    expect(revoked.data.isUsed).toBe(true);
    expect(revoked.data).not.toHaveProperty('expiresAt');
  });

  it('answers 404 when no org has it, Clerk refusing included', async () => {
    stubClerk(clerk([membership('org_inv_a', 'Clerk A')]));
    expect((await app().request('/api/invitations/inv_none')).status).toBe(404);
    stubClerk(() => clerkError(401, 'authentication_invalid'));
    expect((await app().request('/api/invitations/inv_none')).status).toBe(404);
  });

  it('answers 500 when Clerk cannot be reached', async () => {
    stubClerk(() => 'throw');
    expect((await app().request('/api/invitations/inv_1')).status).toBe(500);
  });
});

describe('POST /api/invitations/accept', () => {
  function accept(body: unknown) {
    return app().request('/api/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('needs a token', async () => {
    stubClerk(clerk([]));
    expect((await accept({})).status).toBe(400);
    expect((await accept({ token: '' })).status).toBe(400);
  });

  it('answers the first of the caller’s orgs that is a workspace', async () => {
    stubClerk(clerk([membership('org_inv_x', 'Clerk X'), membership('org_inv_b', 'Clerk B', 'org:admin'), membership('org_inv_a', 'Clerk A')]));
    const res = await accept({ token: 'inv_1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { workspaceId: 'org_inv_b', workspaceName: 'Inv B', role: 'ADMIN' } });
  });

  it('answers 404 without a workspace, and 500 when Clerk cannot be asked', async () => {
    stubClerk(clerk([membership('org_inv_x', 'Clerk X')]));
    expect((await accept({ token: 'inv_1' })).status).toBe(404);
    stubClerk(() => clerkError(503, 'unavailable'));
    expect((await accept({ token: 'inv_1' })).status).toBe(500);
    stubClerk(() => 'throw');
    expect((await accept({ token: 'inv_1' })).status).toBe(500);
  });
});

