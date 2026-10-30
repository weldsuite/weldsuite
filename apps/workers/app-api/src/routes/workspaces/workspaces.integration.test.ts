/**
 * GET /api/workspaces against a real master database (pglite): only active
 * memberships of active workspaces, the org id as `id` with the workspace id
 * as the fallback. Conformance-ready (rust/conformance/suites.json).
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';

// Conformance mode runs every write on both backends, each on a fresh copy.
vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getMasterDb: () => conformanceMasterDb(holder.master),
}));

import { workspacesRoutes } from './index';

const { users, userWorkspaces, workspaces } = masterSchema;

let tenantDb: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
  await master.insert(users).values([
    { id: 'user_wsl', email: 'wsl@example.com' },
    { id: 'user_wsl_other', email: 'other@example.com' },
  ]);
  await master.insert(workspaces).values([
    { id: 'ws_wsl_a', clerkOrgId: 'org_wsl_a', name: 'Alpha', slug: 'wsl-alpha', imageUrl: 'https://img/a.png' },
    { id: 'ws_wsl_b', clerkOrgId: null, name: 'Beta', slug: 'wsl-beta' },
    { id: 'ws_wsl_gone', clerkOrgId: 'org_wsl_gone', name: 'Gone', slug: 'wsl-gone', isActive: false },
    { id: 'ws_wsl_pending', clerkOrgId: 'org_wsl_pending', name: 'Pending', slug: 'wsl-pending' },
  ]);
  await master.insert(userWorkspaces).values([
    { id: 'uw_wsl_a', userId: 'user_wsl', workspaceId: 'ws_wsl_a', role: 'org:admin' },
    { id: 'uw_wsl_b', userId: 'user_wsl', workspaceId: 'ws_wsl_b', role: 'org:member' },
    { id: 'uw_wsl_gone', userId: 'user_wsl', workspaceId: 'ws_wsl_gone', role: 'org:admin' },
    { id: 'uw_wsl_pending', userId: 'user_wsl', workspaceId: 'ws_wsl_pending', status: 'PENDING' },
    { id: 'uw_wsl_other', userId: 'user_wsl_other', workspaceId: 'ws_wsl_a' },
  ]);
}, 180_000);

function app(userId: string) {
  return createTestApp('/api/workspaces', workspacesRoutes, {
    context: { userId, tenantDb, masterDb: master },
  });
}

describe('GET /api/workspaces (pglite)', () => {
  it("lists the caller's active workspaces", async () => {
    const res = await app('user_wsl').request('/api/workspaces');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    const byName = Object.fromEntries(body.data.map((w) => [w.name, w]));
    expect(Object.keys(byName).sort()).toEqual(['Alpha', 'Beta']);
    expect(byName.Alpha).toEqual({
      id: 'org_wsl_a',
      workspaceId: 'ws_wsl_a',
      name: 'Alpha',
      slug: 'wsl-alpha',
      imageUrl: 'https://img/a.png',
      role: 'org:admin',
    });
    // No Clerk org: the workspace id stands in.
    expect(byName.Beta?.id).toBe('ws_wsl_b');
  });

  it('is empty for a user without memberships', async () => {
    const res = await app('user_nobody').request('/api/workspaces');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });
});
