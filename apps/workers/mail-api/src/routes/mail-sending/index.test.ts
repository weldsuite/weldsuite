/**
 * GET /api/mail-sending/usage: the workspace's view of its outbound sending
 * limits, from its ledger (docs/plans/weldmail-outbound-abuse.md). pglite
 * tenant and master databases; the ledger is a stub namespace.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { conformanceMasterDb } from '@weldsuite/worker-kit/testing/conformance';
import { masterSchema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { OUTBOUND_DEFAULT_LIMITS, type OutboundUsage } from '@weldsuite/app-api-client/schemas/outbound-mail';

let master: MasterDatabase;

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  const { eq, or } = await import('drizzle-orm');
  return {
    ...actual,
    getMasterDb: () => conformanceMasterDb(master),
    // The worker reads the workspace through its KV-cached master lookup.
    getWorkspaceForOrg: async (_env: unknown, ref: string) => {
      const { workspaces } = actual.masterSchema;
      const [row] = await conformanceMasterDb(master)
        .select({ id: workspaces.id, clerkOrgId: workspaces.clerkOrgId })
        .from(workspaces)
        .where(or(eq(workspaces.clerkOrgId, ref), eq(workspaces.id, ref)))
        .limit(1);
      if (!row) throw new Error('Workspace not found');
      return row;
    },
  };
});

import { mailSendingRoutes } from './index';

let tenantDb: Database;

const USAGE: OutboundUsage = {
  mode: 'shadow',
  trustLevel: 'standard',
  state: 'active',
  stateReason: null,
  limits: { ...OUTBOUND_DEFAULT_LIMITS.standard },
  workspace: {
    hour: 3,
    day: { used: 12, limit: 2000 },
    firstContactDay: { used: 4, limit: 200 },
    month: { used: 40, limit: null },
  },
  senders: [{ email: 'tom@acme.com', hour: { used: 3, limit: 100 }, day: { used: 12, limit: 500 } }],
  deliveries7d: { delivered: 30, hardBounces: 1, softBounces: 0, complaints: 0, rejected: 0 },
  coldOutreachCapped: false,
};

/** A stub `OUTBOUND_LEDGER`: every ledger answers `USAGE`; it records which one was asked. */
function ledgerStub() {
  const asked: string[] = [];
  return {
    asked,
    idFromName: (name: string) => name,
    get: (name: string) => ({
      usage: async () => {
        asked.push(name);
        return USAGE;
      },
    }),
  };
}

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db as MasterDatabase;
  await master
    .insert(masterSchema.workspaces)
    .values({ id: 'ws_test_default', name: 'Acme', slug: 'acme-usage', clerkOrgId: 'org_test_default' });
}, 60_000);

function app(env: Record<string, unknown> = {}, context: Record<string, unknown> = {}) {
  return createTestApp('/api/mail-sending', mailSendingRoutes, {
    context: { tenantDb, masterDb: master as unknown as Database, permissions: permissions('accounts:read'), ...context },
    env: env as never,
  });
}

describe('GET /api/mail-sending/usage', () => {
  it('answers null when the worker has no ledger', async () => {
    const res = await app().request('/api/mail-sending/usage');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: null });
  });

  it("answers the workspace ledger's usage", async () => {
    const ledger = ledgerStub();
    const res = await app({ OUTBOUND_LEDGER: ledger }).request('/api/mail-sending/usage');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: USAGE });
    expect(ledger.asked).toContain('ws:ws_test_default');
  });

  it('answers null when the workspace cannot be found', async () => {
    const res = await app({ OUTBOUND_LEDGER: ledgerStub() }, { orgId: 'org_unknown', clerkOrgId: 'org_unknown' }).request(
      '/api/mail-sending/usage',
    );
    expect(await res.json()).toEqual({ data: null });
  });

  it('needs a workspace', async () => {
    const res = await app({}, { orgId: null }).request('/api/mail-sending/usage');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'ORG_REQUIRED' } });
  });

  it('needs accounts:read', async () => {
    const res = await app({}, { permissions: permissions('messages:read') }).request('/api/mail-sending/usage');
    expect(res.status).toBe(403);
  });
});
