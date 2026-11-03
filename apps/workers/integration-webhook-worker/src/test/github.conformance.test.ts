/**
 * `POST /webhooks/github` end to end, through the worker's own `fetch`: the
 * App's HMAC, the installation's workspace (KV, else a scan of the master
 * workspaces' tenant databases), the connection status on installation
 * events and the `GITHUB_PROJECT_SYNC` runs a board or issue change starts.
 * Run on both backends by the `integrations: github` conformance suite.
 */

import { createHmac } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@weldsuite/db/schema';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { conformanceMasterDb, conformanceTenantDb } from '@weldsuite/worker-kit/testing/conformance';
import { createWebhookTestApp } from './harness';

const holder = vi.hoisted(() => ({ masterDb: null as unknown, tenantDb: null as unknown }));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getMasterDb: () => conformanceMasterDb(holder.masterDb),
  getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenantDb),
}));

type Db = Awaited<ReturnType<typeof createPgliteDb>>['db'];
let tenantDb: Db;
let masterDb: Awaited<ReturnType<typeof createMasterPgliteDb>>['db'];

const SECRET = 'gh-app-webhook-secret';
const ORG = 'org_github';
const INSTALLATION = 4242;

function memoryKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  };
}

function syncBinding() {
  return {
    create: vi.fn(async (options: { id?: string }) => ({ id: options?.id ?? 'instance' })),
    get: vi.fn(async () => ({})),
  };
}

function signature(body: string, secret = SECRET) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  masterDb = (await createMasterPgliteDb()).db;
  holder.tenantDb = tenantDb;
  holder.masterDb = masterDb;
}, 60_000);

beforeEach(async () => {
  await tenantDb.delete(schema.githubIssueSyncMap);
  await tenantDb.delete(schema.githubProjectLinks);
  await tenantDb.delete(schema.githubConnections);
  await masterDb.delete(masterSchema.workspaces).where(eq(masterSchema.workspaces.id, 'ws_github'));
  const now = new Date('2026-10-01T09:00:00.000Z');
  await tenantDb.insert(schema.githubConnections).values({
    id: 'ghc_1',
    workspaceId: ORG,
    installationId: INSTALLATION,
    appSlug: 'weldsuite',
    ownerType: 'org',
    ownerLogin: 'acme',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  await tenantDb.insert(schema.githubProjectLinks).values([
    {
      id: 'ghpl_both',
      workspaceId: ORG,
      connectionId: 'ghc_1',
      projectId: 'prj_both',
      projectV2NodeId: 'PVT_both',
      projectV2Number: 1,
      ownerType: 'org',
      ownerLogin: 'acme',
      syncDirection: 'bidirectional' as const,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'ghpl_out',
      workspaceId: ORG,
      connectionId: 'ghc_1',
      projectId: 'prj_out',
      projectV2NodeId: 'PVT_out',
      projectV2Number: 2,
      ownerType: 'org',
      ownerLogin: 'acme',
      syncDirection: 'outbound' as const,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await tenantDb.insert(schema.githubIssueSyncMap).values({
    id: 'ghsm_1',
    workspaceId: ORG,
    projectLinkId: 'ghpl_both',
    taskId: 'tsk_1',
    projectItemNodeId: 'PVTI_1',
    issueNodeId: 'I_mapped',
    issueNumber: 7,
    repoId: 99,
    createdAt: now,
    updatedAt: now,
  });
});

function app(options: { kv?: ReturnType<typeof memoryKv>; sync?: ReturnType<typeof syncBinding>; env?: Record<string, unknown> } = {}) {
  return createWebhookTestApp({
    masterDb,
    tenantDb,
    env: {
      GITHUB_WEBHOOK_SECRET: SECRET,
      DATABASE_ENCRYPTION_KEY: 'conformance-key',
      WORKSPACE_CACHE: options.kv ?? memoryKv({ [`gh-install:${INSTALLATION}`]: ORG }),
      ...(options.sync ? { GITHUB_PROJECT_SYNC: options.sync } : {}),
      ...options.env,
    },
  });
}

function deliver(target: ReturnType<typeof app>, event: string, payload: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify(payload);
  return target.request('/webhooks/github', {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': event,
      'X-GitHub-Delivery': 'delivery-1',
      'X-Hub-Signature-256': signature(body),
      ...headers,
    },
  });
}

describe('POST /webhooks/github', () => {
  it('acknowledges a ping and an event without an installation, and refuses JSON it cannot read', async () => {
    const target = app();
    const ping = await deliver(target, 'ping', { zen: 'Keep it logically awesome.', hook_id: 1 });
    expect(ping.status).toBe(202);
    expect(await ping.json()).toEqual({ received: true });

    const bad = await target.request('/webhooks/github', { method: 'POST', body: '{not json', headers: { 'X-GitHub-Event': 'issues' } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } });
  });

  it('refuses a delivery without the encryption key, without a secret, or with a wrong signature', async () => {
    const payload = { action: 'created', installation: { id: INSTALLATION } };

    const noKey = await deliver(app({ env: { DATABASE_ENCRYPTION_KEY: undefined } }), 'installation', payload);
    expect(noKey.status).toBe(401);
    expect(await noKey.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });

    const noSecret = await deliver(app({ env: { GITHUB_WEBHOOK_SECRET: undefined } }), 'installation', payload);
    expect(noSecret.status).toBe(401);

    const forged = await deliver(app(), 'installation', payload, { 'X-Hub-Signature-256': signature(JSON.stringify(payload), 'wrong') });
    expect(forged.status).toBe(401);

    const unsigned = await deliver(app(), 'installation', payload, { 'X-Hub-Signature-256': 'sha1=abc' });
    expect(unsigned.status).toBe(401);
  });

  it('ignores an installation no workspace has (after scanning the workspaces)', async () => {
    const res = await deliver(app({ kv: memoryKv() }), 'installation', { action: 'created', installation: { id: 999 } });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ received: true });
  });

  it('finds the workspace of an uncached installation by scanning, caches it, and keeps the connection status', async () => {
    await masterDb
      .insert(masterSchema.workspaces)
      .values({ id: 'ws_github', clerkOrgId: ORG, name: 'GitHub', slug: 'github' } as typeof masterSchema.workspaces.$inferInsert);
    const kv = memoryKv();

    const suspend = await deliver(app({ kv }), 'installation', { action: 'suspend', installation: { id: INSTALLATION } });
    expect(suspend.status).toBe(202);
    expect(await kv.get(`gh-install:${INSTALLATION}`)).toBe(ORG);
    const [suspended] = await tenantDb.select().from(schema.githubConnections).where(eq(schema.githubConnections.id, 'ghc_1'));
    expect(suspended?.status).toBe('suspended');

    const deleted = await deliver(app({ kv }), 'installation', { action: 'deleted', installation: { id: INSTALLATION } });
    expect(deleted.status).toBe(202);
    const [revoked] = await tenantDb.select().from(schema.githubConnections).where(eq(schema.githubConnections.id, 'ghc_1'));
    expect(revoked?.status).toBe('revoked');
    expect(revoked?.revokedAt).not.toBeNull();

    const back = await deliver(app({ kv }), 'installation', { action: 'unsuspend', installation: { id: INSTALLATION } });
    expect(back.status).toBe(202);
    const [active] = await tenantDb.select().from(schema.githubConnections).where(eq(schema.githubConnections.id, 'ghc_1'));
    expect(active?.status).toBe('active');
  });

  it('starts one inbound project sync for a board change on a linked project', async () => {
    const sync = syncBinding();
    const res = await deliver(app({ sync }), 'projects_v2_item', {
      action: 'edited',
      installation: { id: INSTALLATION },
      projects_v2_item: { id: 1, node_id: 'PVTI_x', project_node_id: 'PVT_both' },
    });

    expect(res.status).toBe(202);
    expect(sync.create).toHaveBeenCalledTimes(1);
    const [options] = sync.create.mock.calls[0] as unknown as [{ id: string; params: unknown }];
    expect(options.id).toMatch(/^github-project-sync-ghpl_both-\d+$/);
    expect(options.params).toEqual({ workspaceId: ORG, projectLinkId: 'ghpl_both', inboundOnly: true });
  });

  it('starts nothing for an unlinked project, an outbound-only link, or an item without its project', async () => {
    const sync = syncBinding();
    const target = app({ sync });
    for (const item of [{ project_node_id: 'PVT_other' }, { project_node_id: 'PVT_out' }, { id: 5 }]) {
      const res = await deliver(target, 'projects_v2_item', { action: 'edited', installation: { id: INSTALLATION }, projects_v2_item: item });
      expect(res.status).toBe(202);
    }
    const other = await deliver(target, 'projects_v2', { action: 'edited', installation: { id: INSTALLATION } });
    expect(other.status).toBe(202);
    const unknown = await deliver(target, 'pull_request', { action: 'opened', installation: { id: INSTALLATION } });
    expect(unknown.status).toBe(202);
    expect(sync.create).not.toHaveBeenCalled();
  });

  it('starts an inbound sync for an edit of a mapped issue, by node id or by number and repository', async () => {
    const sync = syncBinding();
    const target = app({ sync });

    const byNode = await deliver(target, 'issues', {
      action: 'edited',
      installation: { id: INSTALLATION },
      issue: { node_id: 'I_mapped', number: 7 },
      repository: { id: 99 },
    });
    expect(byNode.status).toBe(202);

    const byNumber = await deliver(target, 'issues', {
      action: 'closed',
      installation: { id: INSTALLATION },
      issue: { node_id: 'I_renamed', number: 7 },
      repository: { id: 99 },
    });
    expect(byNumber.status).toBe(202);

    const unmapped = await deliver(target, 'issues', {
      action: 'opened',
      installation: { id: INSTALLATION },
      issue: { node_id: 'I_new', number: 8 },
      repository: { id: 99 },
    });
    expect(unmapped.status).toBe(202);

    const noNode = await deliver(target, 'issues', { action: 'opened', installation: { id: INSTALLATION }, issue: { number: 9 } });
    expect(noNode.status).toBe(202);

    expect(sync.create).toHaveBeenCalledTimes(2);
    for (const [options] of sync.create.mock.calls as unknown as Array<[{ params: unknown }]>) {
      expect(options.params).toEqual({ workspaceId: ORG, projectLinkId: 'ghpl_both', inboundOnly: true });
    }
  });

  it('acknowledges an installation whose connection the workspace no longer has', async () => {
    await tenantDb.update(schema.githubConnections).set({ deletedAt: new Date() }).where(eq(schema.githubConnections.id, 'ghc_1'));
    const res = await deliver(app(), 'installation', { action: 'created', installation: { id: INSTALLATION } });
    expect(res.status).toBe(202);
  });
});
