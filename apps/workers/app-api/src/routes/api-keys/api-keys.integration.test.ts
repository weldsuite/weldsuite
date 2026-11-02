/**
 * Every /api/api-keys route against real pglite tenant and master databases,
 * refusals included: a member lists, reads, mints, renames and revokes only
 * their own keys, and each mint and revoke is paired with the master
 * `api_key_registry` that external-api authenticates against.
 *
 * Nothing is mocked but `getMasterDb`, which hands out the test's master
 * database through `conformanceMasterDb`, so the conformance suite runs these
 * against the Rust backend too.
 */

import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const state = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  const { conformanceMasterDb } = await import('@weldsuite/worker-kit/testing/conformance');
  return { ...actual, getMasterDb: () => conformanceMasterDb(state.master) };
});

import { apiKeysRoutes } from './index';

const { apiKeyRegistry, workspaces } = masterSchema;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
let tenant: Database;

const ORG = 'org_ak';
const ME = 'user_ak_me';
const OTHER = 'user_ak_other';

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db;
  state.master = master;
  tenant = (await createPgliteDb()).db;

  await master.insert(workspaces).values({ id: 'ws_ak', clerkOrgId: ORG, name: 'Key Workspace', slug: 'ak-ws' });
  await tenant.insert(schema.apiKeys).values([
    {
      id: 'ak_old',
      userId: ME,
      name: 'Old key',
      keyHash: 'hash_old',
      keyPrefix: 'wsk_00000001',
      scopes: ['crm:read'],
      createdAt: new Date('2026-01-01T10:00:00.000Z'),
      updatedAt: new Date('2026-01-01T10:00:00.000Z'),
    },
    {
      id: 'ak_new',
      userId: ME,
      name: 'New key',
      description: 'For CI',
      keyHash: 'hash_new',
      keyPrefix: 'wsk_00000002',
      scopes: [],
      lastUsedAt: new Date('2026-03-04T05:06:07.890Z'),
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      createdAt: new Date('2026-02-01T10:00:00.000Z'),
      updatedAt: new Date('2026-02-01T10:00:00.000Z'),
    },
    {
      id: 'ak_revoked',
      userId: ME,
      name: 'Revoked key',
      keyHash: 'hash_revoked',
      keyPrefix: 'wsk_00000003',
      createdAt: new Date('2026-02-02T10:00:00.000Z'),
      updatedAt: new Date('2026-02-02T10:00:00.000Z'),
      deletedAt: new Date('2026-02-03T10:00:00.000Z'),
    },
    {
      id: 'ak_theirs',
      userId: OTHER,
      name: 'Their key',
      keyHash: 'hash_theirs',
      keyPrefix: 'wsk_00000004',
      createdAt: new Date('2026-02-04T10:00:00.000Z'),
      updatedAt: new Date('2026-02-04T10:00:00.000Z'),
    },
    {
      id: 'ak_to_revoke',
      userId: ME,
      name: 'Doomed key',
      keyHash: 'hash_doomed',
      keyPrefix: 'wsk_00000005',
      createdAt: new Date('2025-12-01T10:00:00.000Z'),
      updatedAt: new Date('2025-12-01T10:00:00.000Z'),
    },
  ]);
  await master.insert(apiKeyRegistry).values({
    id: 'akr_doomed',
    keyHash: 'hash_doomed',
    keyType: 'personal',
    workspaceId: 'ws_ak',
    tenantKeyId: 'ak_to_revoke',
  });
}, 60_000);

function app(orgId: string | null = ORG, userId = ME) {
  return createTestApp('/api/api-keys', apiKeysRoutes, {
    context: { orgId, userId, tenantDb: tenant, masterDb: master },
  });
}

function send(t: ReturnType<typeof app>, path: string, method: string, body?: unknown) {
  return t.request(`/api/api-keys${path}`, {
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
  lastUsedAt?: string;
  expiresAt?: string;
  createdAt?: string;
}

async function errorCode(res: Response) {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe('GET /api/api-keys', () => {
  it('needs an organization', async () => {
    const res = await app(null).request('/api/api-keys');
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('ORG_REQUIRED');
  });

  it("lists only the caller's live keys, newest first, without their hashes", async () => {
    const res = await app().request('/api/api-keys');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Key[] };
    expect(data.map((k) => k.id)).toEqual(['ak_new', 'ak_old', 'ak_to_revoke']);
    expect(data[0]).toEqual({
      id: 'ak_new',
      name: 'New key',
      description: 'For CI',
      keyPrefix: 'wsk_00000002',
      scopes: [],
      lastUsedAt: '2026-03-04T05:06:07.890Z',
      expiresAt: '2027-01-01T00:00:00.000Z',
      createdAt: '2026-02-01T10:00:00.000Z',
    });
    // Never used, no expiry: left out, not null.
    expect(data[1]).toEqual({
      id: 'ak_old',
      name: 'Old key',
      description: null,
      keyPrefix: 'wsk_00000001',
      scopes: ['crm:read'],
      createdAt: '2026-01-01T10:00:00.000Z',
    });
  });

  it('lists nothing for a member without keys', async () => {
    const res = await app(ORG, 'user_ak_nobody').request('/api/api-keys');
    expect(await res.json()).toEqual({ data: [] });
  });
});

describe('GET /api/api-keys/:id', () => {
  it('reads one of the caller’s keys', async () => {
    const res = await app().request('/api/api-keys/ak_old');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Key }).data.name).toBe('Old key');
  });

  it("is a 404 for another member's key, a revoked key and an unknown id", async () => {
    for (const id of ['ak_theirs', 'ak_revoked', 'ak_missing']) {
      const res = await app().request(`/api/api-keys/${id}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: 'NOT_FOUND', message: `API key with ID '${id}' not found` },
      });
    }
  });

  it('needs an organization', async () => {
    const res = await app(null).request('/api/api-keys/ak_old');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/api-keys', () => {
  it('validates the body before anything else', async () => {
    const res = await send(app(null), '', 'POST', { name: '', scopes: ['crm:read', 1], expiresAt: 'soon' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { issues: Array<{ path: unknown[]; message: string }> } };
    expect(body.error.issues.map((i) => [i.path, i.message])).toEqual([
      [['name'], 'Name is required'],
      [['scopes', 1], 'Expected string, received number'],
      [['expiresAt'], 'Invalid datetime'],
    ]);
  });

  it('refuses an offset datetime and a name over 100 characters', async () => {
    const res = await send(app(), '', 'POST', { name: 'x'.repeat(101), expiresAt: '2030-01-01T00:00:00+02:00' });
    expect(res.status).toBe(400);
  });

  it('needs an organization once the body is valid', async () => {
    const res = await send(app(null), '', 'POST', { name: 'No org' });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('ORG_REQUIRED');
  });

  it('mints a key, stores only its hash and registers it in the master registry', async () => {
    const res = await send(app(), '', 'POST', {
      name: 'Deploy key',
      description: 'From the pipeline',
      scopes: ['crm:read', 'crm:write'],
      expiresAt: '2030-06-01T12:00:00.123456Z',
      keyHash: 'chosen-by-the-caller',
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Key & { key: string } };
    expect(data).toEqual({
      id: expect.stringMatching(/^ak_/),
      name: 'Deploy key',
      description: 'From the pipeline',
      keyPrefix: data.key.slice(0, 12),
      scopes: ['crm:read', 'crm:write'],
      key: expect.stringMatching(/^wsk_[0-9a-f]{64}$/),
    });

    const [row] = await tenant.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, data.id));
    expect(row!.keyHash).toBe(createHash('sha256').update(data.key).digest('hex'));
    expect(row!.userId).toBe(ME);
    expect(row!.expiresAt!.toISOString()).toBe('2030-06-01T12:00:00.123Z');

    const registry = await master.select().from(apiKeyRegistry).where(eq(apiKeyRegistry.tenantKeyId, data.id));
    expect(registry).toHaveLength(1);
    expect(registry[0]).toMatchObject({ keyHash: row!.keyHash, keyType: 'personal', workspaceId: 'ws_ak' });

    const read = await app().request(`/api/api-keys/${data.id}`);
    const { data: stored } = (await read.json()) as { data: Key };
    expect(stored.expiresAt).toBe('2030-06-01T12:00:00.123Z');
    expect(stored).not.toHaveProperty('key');
  });

  it('defaults the scopes to none and leaves out a missing description', async () => {
    const res = await send(app(), '', 'POST', { name: 'Bare key' });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Key };
    expect(data.scopes).toEqual([]);
    expect(data).not.toHaveProperty('description');
  });

  it('still mints a key when the org has no master workspace, without a registry row', async () => {
    const res = await send(app('org_ak_unknown'), '', 'POST', { name: 'Orphan key' });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Key };
    const registry = await master.select().from(apiKeyRegistry).where(eq(apiKeyRegistry.tenantKeyId, data.id));
    expect(registry).toHaveLength(0);
  });

  it('finds the workspace by its own id too', async () => {
    const res = await send(app('ws_ak'), '', 'POST', { name: 'By workspace id' });
    const { data } = (await res.json()) as { data: Key };
    const registry = await master.select().from(apiKeyRegistry).where(eq(apiKeyRegistry.tenantKeyId, data.id));
    expect(registry[0]).toMatchObject({ workspaceId: 'ws_ak' });
  });
});

describe('PATCH /api/api-keys/:id', () => {
  it('validates the body', async () => {
    const res = await send(app(), '/ak_old', 'PATCH', { name: '', scopes: 'all' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { issues: Array<{ message: string }> } };
    expect(body.error.issues.map((i) => i.message)).toEqual([
      'String must contain at least 1 character(s)',
      'Expected array, received string',
    ]);
  });

  it("is a 404 for another member's key", async () => {
    const res = await send(app(), '/ak_theirs', 'PATCH', { name: 'Mine now' });
    expect(res.status).toBe(404);
  });

  it('needs an organization', async () => {
    const res = await send(app(null), '/ak_old', 'PATCH', { name: 'x' });
    expect(res.status).toBe(400);
  });

  it('renames and re-scopes, leaving the other fields alone', async () => {
    const res = await send(app(), '/ak_old', 'PATCH', { name: 'Renamed key', scopes: ['tasks:read'] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Key }).data).toEqual({
      id: 'ak_old',
      name: 'Renamed key',
      description: null,
      keyPrefix: 'wsk_00000001',
      scopes: ['tasks:read'],
      createdAt: '2026-01-01T10:00:00.000Z',
    });

    const described = await send(app(), '/ak_old', 'PATCH', { description: 'Now described' });
    expect(((await described.json()) as { data: Key }).data).toMatchObject({
      name: 'Renamed key',
      description: 'Now described',
      scopes: ['tasks:read'],
    });
  });
});

describe('DELETE /api/api-keys/:id', () => {
  it("is a 404 for another member's key and leaves it alone", async () => {
    const res = await app().request('/api/api-keys/ak_theirs', { method: 'DELETE' });
    expect(res.status).toBe(404);
    const [row] = await tenant.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, 'ak_theirs'));
    expect(row!.deletedAt).toBeNull();
  });

  it('needs an organization', async () => {
    const res = await app(null).request('/api/api-keys/ak_to_revoke', { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('revokes the key and drops its registry row', async () => {
    const res = await app().request('/api/api-keys/ak_to_revoke', { method: 'DELETE' });
    expect(res.status).toBe(204);
    const [row] = await tenant.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, 'ak_to_revoke'));
    expect(row!.deletedAt).not.toBeNull();
    const registry = await master.select().from(apiKeyRegistry).where(eq(apiKeyRegistry.tenantKeyId, 'ak_to_revoke'));
    expect(registry).toHaveLength(0);

    expect((await app().request('/api/api-keys/ak_to_revoke')).status).toBe(404);
    expect((await app().request('/api/api-keys/ak_to_revoke', { method: 'DELETE' })).status).toBe(404);
  });
});
