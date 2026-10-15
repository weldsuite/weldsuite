import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, type MasterDatabase } from '@weldsuite/worker-kit/db';

let master: MasterDatabase;

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => master };
});

import { internalOutboundRoutes } from './index';
import type { Env } from '../../types';

const SECRET = 'x'.repeat(40);
const refreshPolicy = vi.fn();
const requestReview = vi.fn().mockResolvedValue(true);
const names: string[] = [];

const env = {
  OUTBOUND_ADMIN_SECRET: SECRET,
  OUTBOUND_LEDGER: {
    idFromName: (n: string) => (names.push(n), n),
    get: () => ({ refreshPolicy, requestReview }),
  },
} as unknown as Env;

const headers = { 'x-admin-secret': SECRET, 'x-admin-email': 'Ops@WeldSuite.org', 'content-type': 'application/json' };

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db as MasterDatabase;
  await master.insert(masterSchema.workspaces).values({ id: 'ws_admin', name: 'Admin test', slug: 'admin-test', clerkOrgId: 'org_admin' });
}, 60_000);

describe('/internal/outbound', () => {
  it('is closed without a configured secret', async () => {
    const res = await internalOutboundRoutes.request('/platform', { headers }, { ...env, OUTBOUND_ADMIN_SECRET: 'short' });
    expect(res.status).toBe(503);
  });

  it('refuses a wrong secret and a missing admin identity', async () => {
    expect((await internalOutboundRoutes.request('/platform', { headers: { ...headers, 'x-admin-secret': 'y'.repeat(40) } }, env)).status).toBe(401);
    expect((await internalOutboundRoutes.request('/platform', { headers: { 'x-admin-secret': SECRET } }, env)).status).toBe(400);
  });

  it('reloads a workspace ledger', async () => {
    const res = await internalOutboundRoutes.request('/refresh', { method: 'POST', headers, body: JSON.stringify({ workspaceId: 'ws_admin' }) }, env);
    expect(res.status).toBe(200);
    expect(refreshPolicy).toHaveBeenCalled();
    expect(names).toContain('ws:ws_admin');
  });

  it('queues a staff review and 404s an unknown workspace', async () => {
    const ok = await internalOutboundRoutes.request('/review', { method: 'POST', headers, body: JSON.stringify({ workspaceId: 'ws_admin' }) }, env);
    expect(await ok.json()).toEqual({ data: { queued: true } });
    const missing = await internalOutboundRoutes.request('/review', { method: 'POST', headers, body: JSON.stringify({ workspaceId: 'ws_nope' }) }, env);
    expect(missing.status).toBe(404);
  });
});
