/**
 * Every /api/workspace-api-keys route against real pglite tenant and master
 * databases, refusals included: the per-method `apikeys:*` gates (with the
 * catalog gap that leaves `apikeys:update` to wildcard holders), the shared,
 * unowned key list, and the master `api_key_registry` writes on mint and
 * revoke.
 *
 * Nothing is mocked but `getMasterDb`, which hands out the test's master
 * database through `conformanceMasterDb`, so the conformance suite runs these
 * against the Rust backend too.
 */

import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const state = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  const { conformanceMasterDb } = await import('@weldsuite/worker-kit/testing/conformance');
  return { ...actual, getMasterDb: () => conformanceMasterDb(state.master) };
});

import { workspaceApiKeysRoutes } from './index';

const { apiKeyRegistry, workspaces } = masterSchema;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
let tenant: Database;

const ORG = 'org_wak';
const ADMIN = 'user_wak_admin';
/** What an ADMIN role resolves to: the catalog's `apikeys` actions, no `update`. */
const ADMIN_KEYS = permissions('apikeys:read', 'apikeys:create', 'apikeys:delete');

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db;
  state.master = master;
  tenant = (await createPgliteDb()).db;

  await master.insert(workspaces).values({ id: 'ws_wak', clerkOrgId: ORG, name: 'Shared Keys', slug: 'wak-ws' });
  await tenant.insert(schema.workspaceApiKeys).values([
    {
      id: 'wak_zapier',
      name: 'Zapier',
      keyHash: 'hash_zapier',
      keyPrefix: 'wsk_10000001',
      scopes: ['crm:read'],
      createdBy: 'user_wak_owner',
      createdAt: new Date('2026-01-01T10:00:00.000Z'),
      updatedAt: new Date('2026-01-01T10:00:00.000Z'),
    },
    {
      id: 'wak_erp',
      name: 'ERP sync',
      description: 'Nightly',
      keyHash: 'hash_erp',
      keyPrefix: 'wsk_10000002',
      createdBy: 'user_wak_member',
      lastUsedAt: new Date('2026-04-01T00:00:00.000Z'),
      createdAt: new Date('2026-02-01T10:00:00.000Z'),
      updatedAt: new Date('2026-02-01T10:00:00.000Z'),
    },
    {
      id: 'wak_revoked',
      name: 'Old integration',
      keyHash: 'hash_revoked',
      keyPrefix: 'wsk_10000003',
      createdBy: 'user_wak_owner',
      createdAt: new Date('2026-03-01T10:00:00.000Z'),
      updatedAt: new Date('2026-03-01T10:00:00.000Z'),
      deletedAt: new Date('2026-03-02T10:00:00.000Z'),
    },
  ]);
  await master.insert(apiKeyRegistry).values({
    id: 'akr_wak_zapier',
    keyHash: 'hash_zapier',
    keyType: 'workspace',
    workspaceId: 'ws_wak',
    tenantKeyId: 'wak_zapier',
  });
}, 60_000);

function app(perms = permissions('*'), orgId: string | null = ORG) {
  return createTestApp('/api/workspace-api-keys', workspaceApiKeysRoutes, {
    context: { orgId, userId: ADMIN, tenantDb: tenant, masterDb: master, permissions: perms },
  });
}

function send(t: ReturnType<typeof app>, path: string, method: string, body?: unknown) {
  return t.request(`/api/workspace-api-keys${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

interface Key {
  id: string;
  name: string;
  description?: string | null;
  keyPrefix: string;
  scopes: string[] | null;
  key?: string;
  createdBy?: string;
  lastUsedAt?: string;
  createdAt?: string;
}

describe('GET /api/workspace-api-keys', () => {
  it('needs apikeys:read', async () => {
    const res = await app(permissions('apikeys:create')).request('/api/workspace-api-keys');
    expect(res.status).toBe(403);
  });

  it('needs an organization', async () => {
    const res = await app(permissions('*'), null).request('/api/workspace-api-keys');
    expect(res.status).toBe(400);
  });

  it("lists every member's live keys, newest first, with who minted them", async () => {
    const res = await app(ADMIN_KEYS).request('/api/workspace-api-keys');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Key[] }).data).toEqual([
      {
        id: 'wak_erp',
        name: 'ERP sync',
        description: 'Nightly',
        keyPrefix: 'wsk_10000002',
        scopes: [],
        lastUsedAt: '2026-04-01T00:00:00.000Z',
        createdAt: '2026-02-01T10:00:00.000Z',
        createdBy: 'user_wak_member',
      },
      {
        id: 'wak_zapier',
        name: 'Zapier',
        description: null,
        keyPrefix: 'wsk_10000001',
        scopes: ['crm:read'],
        createdAt: '2026-01-01T10:00:00.000Z',
        createdBy: 'user_wak_owner',
      },
    ]);
  });
});

describe('GET /api/workspace-api-keys/:id', () => {
  it('reads a key minted by someone else', async () => {
    const res = await app(ADMIN_KEYS).request('/api/workspace-api-keys/wak_zapier');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Key }).data.createdBy).toBe('user_wak_owner');
  });

  it('is a 404 for a revoked or unknown key', async () => {
    for (const id of ['wak_revoked', 'wak_missing']) {
      const res = await app().request(`/api/workspace-api-keys/${id}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: 'NOT_FOUND', message: `Workspace API key with ID '${id}' not found` },
      });
    }
  });

  it('needs apikeys:read', async () => {
    const res = await app(permissions('apikeys:delete')).request('/api/workspace-api-keys/wak_zapier');
    expect(res.status).toBe(403);
  });
});

describe('POST /api/workspace-api-keys', () => {
  it('needs apikeys:create, before the body is read', async () => {
    const res = await send(app(permissions('apikeys:read')), '', 'POST', { name: '' });
    expect(res.status).toBe(403);
  });

  it('validates the body', async () => {
    const res = await send(app(), '', 'POST', { name: '', description: 5 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { issues: Array<{ message: string }> } };
    expect(body.error.issues.map((i) => i.message)).toEqual(['Name is required', 'Expected string, received number']);
  });

  it('needs an organization once the body is valid', async () => {
    const res = await send(app(permissions('*'), null), '', 'POST', { name: 'No org' });
    expect(res.status).toBe(400);
  });

  it('mints a key recorded as the caller’s, and registers it as a workspace key', async () => {
    const res = await send(app(ADMIN_KEYS), '', 'POST', {
      name: 'Webhook relay',
      scopes: ['tickets:read'],
      expiresAt: '2031-01-01T00:00:00Z',
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Key & { key: string } };
    expect(data).toEqual({
      id: expect.stringMatching(/^wak_/),
      name: 'Webhook relay',
      keyPrefix: data.key.slice(0, 12),
      scopes: ['tickets:read'],
      key: expect.stringMatching(/^wsk_[0-9a-f]{64}$/),
    });

    const [row] = await tenant
      .select()
      .from(schema.workspaceApiKeys)
      .where(eq(schema.workspaceApiKeys.id, data.id));
    expect(row!.createdBy).toBe(ADMIN);
    expect(row!.keyHash).toBe(createHash('sha256').update(data.key).digest('hex'));

    const registry = await master.select().from(apiKeyRegistry).where(eq(apiKeyRegistry.tenantKeyId, data.id));
    expect(registry[0]).toMatchObject({ keyHash: row!.keyHash, keyType: 'workspace', workspaceId: 'ws_wak' });

    const read = await app().request(`/api/workspace-api-keys/${data.id}`);
    expect(((await read.json()) as { data: Key & { expiresAt: string } }).data).toMatchObject({
      createdBy: ADMIN,
      expiresAt: '2031-01-01T00:00:00.000Z',
    });
  });
});

describe('PUT /api/workspace-api-keys/:id', () => {
  it('needs apikeys:update, which only a wildcard holds (not in the catalog)', async () => {
    const res = await send(app(ADMIN_KEYS), '/wak_zapier', 'PUT', { name: 'Renamed' });
    expect(res.status).toBe(403);
  });

  it('validates the body', async () => {
    const res = await send(app(), '/wak_zapier', 'PUT', { name: 'x'.repeat(101) });
    expect(res.status).toBe(400);
  });

  it('is a 404 for a revoked key', async () => {
    const res = await send(app(), '/wak_revoked', 'PUT', { name: 'Back' });
    expect(res.status).toBe(404);
  });

  it('needs an organization', async () => {
    const res = await send(app(permissions('*'), null), '/wak_zapier', 'PUT', { name: 'x' });
    expect(res.status).toBe(400);
  });

  it('renames and re-scopes a key minted by someone else', async () => {
    const res = await send(app(permissions('apikeys:update')), '/wak_zapier', 'PUT', {
      name: 'Zapier (prod)',
      description: 'Main account',
      scopes: [],
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Key }).data).toEqual({
      id: 'wak_zapier',
      name: 'Zapier (prod)',
      description: 'Main account',
      keyPrefix: 'wsk_10000001',
      scopes: [],
      createdAt: '2026-01-01T10:00:00.000Z',
      createdBy: 'user_wak_owner',
    });
  });
});

describe('DELETE /api/workspace-api-keys/:id', () => {
  it('needs apikeys:delete', async () => {
    const res = await app(permissions('apikeys:read')).request('/api/workspace-api-keys/wak_zapier', {
      method: 'DELETE',
    });
    expect(res.status).toBe(403);
  });

  it('is a 404 for an unknown key', async () => {
    const res = await app().request('/api/workspace-api-keys/wak_missing', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('needs an organization', async () => {
    const res = await app(permissions('*'), null).request('/api/workspace-api-keys/wak_zapier', {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
  });

  it('revokes the key and drops its registry row', async () => {
    const res = await app(ADMIN_KEYS).request('/api/workspace-api-keys/wak_zapier', { method: 'DELETE' });
    expect(res.status).toBe(204);
    const [row] = await tenant
      .select()
      .from(schema.workspaceApiKeys)
      .where(eq(schema.workspaceApiKeys.id, 'wak_zapier'));
    expect(row!.deletedAt).not.toBeNull();
    const registry = await master
      .select()
      .from(apiKeyRegistry)
      .where(eq(apiKeyRegistry.tenantKeyId, 'wak_zapier'));
    expect(registry).toHaveLength(0);

    const list = await app().request('/api/workspace-api-keys');
    const ids = ((await list.json()) as { data: Key[] }).data.map((k) => k.id);
    expect(ids).not.toContain('wak_zapier');
  });
});
