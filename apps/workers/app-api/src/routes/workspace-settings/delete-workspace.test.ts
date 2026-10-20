/**
 * `POST /workspace-settings/delete` marks the workspace deleted (`deleted_at`)
 * once Clerk has confirmed the org delete, and not when Clerk refused it:
 * workspace-worker's teardown retry sweep finds deleted workspaces whose
 * database is still there by that stamp. Real master schema (PGlite); Clerk
 * is a spy.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';

const holder = vi.hoisted(() => ({
  masterDb: null as unknown,
  deleteOrganization: vi.fn(),
}));

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getMasterDb: () => holder.masterDb,
}));
vi.mock('@clerk/backend', () => ({
  createClerkClient: () => ({ organizations: { deleteOrganization: holder.deleteOrganization } }),
}));
vi.mock('@weldsuite/entity-events', () => ({ publishEntityEvent: vi.fn() }));

import { workspaceSettingsRoutes } from './index';

const { workspaces } = masterSchema;
const env = { CLERK_SECRET_KEY: 'sk_test', WORKSPACE_CACHE: { delete: async () => {} } };

/** The caller's tenant membership, as getCallerRole reads it: an OWNER. */
const tenantDb = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ role: 'OWNER' }] }) }) }),
};

let master: Awaited<ReturnType<typeof createMasterPgliteDb>>;

beforeAll(async () => {
  master = await createMasterPgliteDb();
  holder.masterDb = master.db;
}, 180_000);

beforeEach(async () => {
  await master.db.delete(workspaces);
  await master.db.insert(workspaces).values({
    id: 'ws_1',
    clerkOrgId: 'org_1',
    name: 'Acme',
    slug: 'acme',
    neonProjectId: 'prj-shard',
  });
  holder.deleteOrganization.mockReset().mockResolvedValue({});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function deleteWorkspace() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('orgId' as never, 'org_1' as never);
    c.set('userId' as never, 'user_1' as never);
    c.set('tenantDb' as never, tenantDb as never);
    await next();
  });
  app.route('/', workspaceSettingsRoutes as never);
  return app.request(
    '/delete',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation: 'acme' }) },
    env as never,
  );
}

const workspaceRow = async () => (await master.db.select().from(workspaces).where(eq(workspaces.id, 'ws_1')))[0];

describe('POST /workspace-settings/delete', () => {
  it('marks the workspace deleted and inactive once Clerk confirmed the org delete', async () => {
    const res = await deleteWorkspace();

    expect(res.status).toBe(200);
    expect(holder.deleteOrganization).toHaveBeenCalledWith('org_1');
    expect(await workspaceRow()).toMatchObject({ isActive: false, deletedAt: expect.any(Date) });
  });

  it('keeps a deleted_at the organization.deleted webhook already wrote', async () => {
    const stampedAt = new Date('2026-10-20T12:00:00.000Z');
    await master.db.update(workspaces).set({ deletedAt: stampedAt }).where(eq(workspaces.id, 'ws_1'));

    expect((await deleteWorkspace()).status).toBe(200);
    expect((await workspaceRow())?.deletedAt).toEqual(stampedAt);
  });

  it('changes nothing when Clerk refuses the delete', async () => {
    holder.deleteOrganization.mockRejectedValue(new Error('Clerk is down'));

    const res = await deleteWorkspace();

    expect(res.status).toBe(500);
    expect(await workspaceRow()).toMatchObject({ isActive: true, deletedAt: null });
  });
});
