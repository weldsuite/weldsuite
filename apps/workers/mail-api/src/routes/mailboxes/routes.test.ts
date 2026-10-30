/**
 * GET /api/mailboxes across two workspaces: a master pglite with the user's
 * memberships and one tenant pglite per workspace (shared with the Rust
 * server through `tenantDbs`), plus a membership whose workspace database
 * cannot be found, which lists no accounts.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb, createSeparatePgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { conformanceMasterDb } from '@weldsuite/worker-kit/testing/conformance';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';

let master: MasterDatabase;
const tenants: Record<string, Database> = {};

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => conformanceMasterDb(master),
    getWorkspaceContextForOrg: async (_env: unknown, ref: string) => {
      const db = tenants[ref];
      if (!db) throw new Error(`Workspace ${ref} not found`);
      return { db, suspended: false };
    },
  };
});

import { mailboxesRoutes } from './index';

const USER = 'user_mbx';
const at = new Date('2026-05-01T08:00:00.000Z');

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db as MasterDatabase;
  await master.insert(masterSchema.users).values([{ id: USER, email: 'mbx@acme.test' }] as never);
  await master.insert(masterSchema.workspaces).values([
    { id: 'ws_mbx_acme', name: 'Acme', slug: 'acme-mbx', clerkOrgId: 'org_mbx_acme' },
    { id: 'ws_mbx_beta', name: 'Beta', slug: 'beta-mbx', clerkOrgId: 'org_mbx_beta' },
    { id: 'ws_mbx_gone', name: 'Gone', slug: 'gone-mbx', clerkOrgId: 'org_mbx_gone' },
    { id: 'ws_mbx_other', name: 'Other', slug: 'other-mbx', clerkOrgId: 'org_mbx_other' },
  ] as never);
  await master.insert(masterSchema.userWorkspaces).values([
    { id: 'uw_mbx_1', userId: USER, workspaceId: 'ws_mbx_acme', role: 'org:admin' },
    { id: 'uw_mbx_2', userId: USER, workspaceId: 'ws_mbx_beta', role: 'org:member' },
    { id: 'uw_mbx_3', userId: USER, workspaceId: 'ws_mbx_gone', role: 'org:member' },
  ] as never);

  tenants.org_mbx_acme = (await createSeparatePgliteDb()).db;
  tenants.org_mbx_beta = (await createSeparatePgliteDb()).db;
  await tenants.org_mbx_acme.insert(schema.workspaceMembers).values({
    id: 'wm_mbx_1', userId: USER, email: 'mbx@acme.test', role: 'ADMIN', status: 'ACTIVE',
  } as never);
  await tenants.org_mbx_acme.insert(schema.mailAccounts).values([
    { id: 'mail_mbx_1', name: 'Support', email: 'support@acme.test', displayName: 'Acme Support', isShared: true, isDefault: true, createdAt: at, updatedAt: at },
    { id: 'mail_mbx_2', name: 'Nobody', email: 'nobody@acme.test', isShared: false, assignedUserIds: [], createdAt: at, updatedAt: at },
    { id: 'mail_mbx_3', name: 'Theirs', email: 'theirs@acme.test', isShared: false, assignedUserIds: ['user_x'], createdAt: at, updatedAt: at },
  ] as never);
  await tenants.org_mbx_beta.insert(schema.workspaceMembers).values({
    id: 'wm_mbx_2', userId: USER, email: 'mbx@beta.test', role: 'MEMBER', status: 'ACTIVE',
  } as never);
  await tenants.org_mbx_beta.insert(schema.mailAccounts).values([
    { id: 'mail_mbx_4', name: 'Sales', email: 'sales@beta.test', isShared: true, provider: 'custom', createdAt: at, updatedAt: at },
    { id: 'mail_mbx_5', name: 'Private', email: 'private@beta.test', isShared: false, assignedUserIds: [], createdAt: at, updatedAt: at },
  ] as never);
}, 60_000);

describe('GET /api/mailboxes across workspaces', () => {
  it("lists each workspace's mailboxes the user can open", async () => {
    const tenantDb = (await createPgliteDb()).db;
    const { request } = createTestApp('/api/mailboxes', mailboxesRoutes, {
      context: { userId: USER, tenantDb, masterDb: master as unknown as Database, tenantDbs: tenants },
    });
    const res = await request('/api/mailboxes');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ workspaceId: string; accounts: Array<{ id: string }> }> };
    const byWorkspace = Object.fromEntries(data.map((g) => [g.workspaceId, g.accounts.map((a) => a.id)]));
    expect(byWorkspace.ws_mbx_acme?.sort()).toEqual(['mail_mbx_1', 'mail_mbx_2']);
    expect(byWorkspace.ws_mbx_beta).toEqual(['mail_mbx_4']);
    expect(byWorkspace.ws_mbx_gone).toEqual([]);
    expect(byWorkspace.ws_mbx_other).toBeUndefined();
  });

  it('lists nothing for a user without workspaces', async () => {
    const tenantDb = (await createPgliteDb()).db;
    const { request } = createTestApp('/api/mailboxes', mailboxesRoutes, {
      context: { userId: 'user_lonely', tenantDb, masterDb: master as unknown as Database, tenantDbs: tenants },
    });
    const res = await request('/api/mailboxes');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);
  });
});
