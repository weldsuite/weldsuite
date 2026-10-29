/**
 * /api/cli-auth (`weld login`'s device-code flow) against real master and
 * tenant databases (pglite), a KV namespace and Clerk as a fetch stub: the
 * pending session, polling, and the developer portal's approval that mints a
 * personal `wsk_` key. Conformance-ready (rust/conformance/suites.json): the
 * KV is shared with the Rust backend and Clerk's calls are compared.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import * as tenantSchema from '@weldsuite/db/schema';
import { conformanceMasterDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { JSON_HEADERS, sharedKv, type FakeKv } from '../../test/user-apps-fixtures';
import { clerkCalls, clerkError, stubClerk } from '../../test/fake-clerk';

vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getMasterDb: () => conformanceMasterDb(holder.master),
}));
// The session and workspace come from the test context; the router's own checks are skipped.
vi.mock('@weldsuite/worker-kit/middleware/clerk', () => ({
  clerkMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('@weldsuite/worker-kit/middleware/workspace-db', () => ({
  workspaceDbMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
// The SDK's requests, through the stubbed fetch (the SDK binds fetch at load).
vi.mock('@clerk/backend', async () => {
  const { clerkShim } = await import('../../test/fake-clerk');
  return { createClerkClient: () => clerkShim() };
});

import { cliAuthRoutes } from './index';

const { apiKeyRegistry, workspaces } = masterSchema;
const { apiKeys } = tenantSchema;

const USER = 'user_cli';
const ORG = 'org_cli';
const DEVICE = 'd'.repeat(64);

let tenantDb: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for postgres-js
let master: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for postgres-js
let tenant: any;
let kv: FakeKv;

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  tenant = tenantDb;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
}, 180_000);

beforeEach(async () => {
  await master.delete(apiKeyRegistry);
  await master.delete(workspaces);
  await tenant.delete(apiKeys);
  await master.insert(workspaces).values({ id: 'ws_cli', clerkOrgId: ORG, name: 'CLI Co', slug: 'cli-co' });
  kv = sharedKv();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function api({ orgId = ORG as string | null, env = {} as Record<string, unknown> } = {}) {
  return createTestApp('/api/cli-auth', cliAuthRoutes, {
    context: { userId: USER, orgId, workspaceId: 'ws_cli', tenantDb, masterDb: master },
    env: { WORKSPACE_CACHE: kv as unknown as KVNamespace, ENVIRONMENT: 'test', ...env } as never,
  }).request;
}

const post = (path: string, body: unknown, options?: Parameters<typeof api>[0]) =>
  api(options)(`/api/cli-auth${path}`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });

const pending = (userCode = 'ABCD2345', createdAt = Date.now()) => {
  kv.store.set(`cli-auth:device:${DEVICE}`, JSON.stringify({ status: 'pending', deviceCode: DEVICE, userCode, createdAt }));
  kv.store.set(`cli-auth:user:${userCode}`, DEVICE);
};

/** Clerk's user and organization, as the approval reads them for labels. */
const clerkProfile = () =>
  stubClerk((method, path) => {
    if (method === 'GET' && path === `/users/${USER}`) {
      return {
        status: 200,
        body: {
          id: USER,
          email_addresses: [
            { id: 'idn_1', email_address: 'old@example.com' },
            { id: 'idn_2', email_address: 'cli@example.com' },
          ],
          primary_email_address_id: 'idn_2',
        },
      };
    }
    if (method === 'GET' && path === `/organizations/${ORG}`) return { status: 200, body: { id: ORG, name: 'CLI Co' } };
    return undefined;
  });

describe('POST /api/cli-auth/device', () => {
  it('starts a pending session with the developer portal of the environment', async () => {
    const res = await post('/device', {});
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> & { deviceCode: string; userCode: string } };
    expect(data.deviceCode).toMatch(/^[0-9a-f]{64}$/);
    expect(data.userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(data).toMatchObject({
      verificationUri: 'https://developer-test.weldsuite.org/cli-auth',
      verificationUriComplete: `https://developer-test.weldsuite.org/cli-auth?code=${data.userCode}`,
      expiresIn: 600,
      interval: 2,
    });
    const normalized = data.userCode.replace('-', '');
    expect(JSON.parse(kv.store.get(`cli-auth:device:${data.deviceCode}`)!)).toMatchObject({
      status: 'pending',
      deviceCode: data.deviceCode,
      userCode: normalized,
    });
    expect(kv.store.get(`cli-auth:user:${normalized}`)).toBe(data.deviceCode);
  });

  it('only points at first-party developer portals', async () => {
    const local = await post('/device', { loginUrl: 'http://localhost/anything' });
    expect(((await local.json()) as { data: { verificationUri: string } }).data.verificationUri).toBe(
      'http://localhost:3202/cli-auth',
    );
    const evil = await post('/device', { loginUrl: 'https://evil.example.com' });
    expect(((await evil.json()) as { data: { verificationUri: string } }).data.verificationUri).toBe(
      'https://developer-test.weldsuite.org/cli-auth',
    );
    const production = await post('/device', {}, { env: { ENVIRONMENT: 'production' } });
    expect(((await production.json()) as { data: { verificationUri: string } }).data.verificationUri).toBe(
      'https://developer.weldsuite.org/cli-auth',
    );
  });

  it('validates the login URL', async () => {
    const res = await post('/device', { loginUrl: 'not a url' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/cli-auth/token', () => {
  it('says pending until the session is approved', async () => {
    pending();
    const res = await post('/token', { deviceCode: DEVICE });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { status: 'pending', interval: 2 } });
  });

  it('hands the key over once', async () => {
    const complete = {
      status: 'complete',
      deviceCode: DEVICE,
      userCode: 'ABCD2345',
      createdAt: Date.now(),
      apiKey: `wsk_${'a'.repeat(64)}`,
      keyId: 'ak_cli',
      keyPrefix: 'wsk_aaaaaaaa',
      orgId: ORG,
      orgName: 'CLI Co',
      userId: USER,
      email: 'cli@example.com',
      apiUrl: 'https://api-test.weldsuite.org',
    };
    kv.store.set(`cli-auth:device:${DEVICE}`, JSON.stringify(complete));
    kv.store.set('cli-auth:user:ABCD2345', DEVICE);

    const res = await post('/token', { deviceCode: DEVICE });
    expect(res.status).toBe(200);
    const { deviceCode: _d, userCode: _u, createdAt: _c, ...handedOver } = complete;
    expect(await res.json()).toEqual({ data: handedOver });
    expect(kv.store.size).toBe(0);

    const again = await post('/token', { deviceCode: DEVICE });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({
      error: { code: 'BAD_REQUEST', message: 'Device code expired or unknown. Run weld login again.' },
    });
  });

  it('validates the device code', async () => {
    expect((await post('/token', { deviceCode: 'short' })).status).toBe(400);
    expect((await post('/token', {})).status).toBe(400);
  });
});

describe('POST /api/cli-auth/approve', () => {
  it('mints a personal key, revoking earlier CLI keys, and completes the session', async () => {
    pending();
    await tenant.insert(apiKeys).values([
      { id: 'ak_old_cli', userId: USER, name: 'Weld CLI', keyHash: 'h_old', keyPrefix: 'wsk_old00000' },
      { id: 'ak_mine', userId: USER, name: 'Deploy', keyHash: 'h_mine', keyPrefix: 'wsk_mine0000' },
      { id: 'ak_theirs', userId: 'user_other', name: 'Weld CLI', keyHash: 'h_theirs', keyPrefix: 'wsk_their000' },
    ]);
    await master.insert(apiKeyRegistry).values([
      { id: 'akr_old', keyHash: 'h_old', keyType: 'personal', workspaceId: 'ws_cli', tenantKeyId: 'ak_old_cli' },
      { id: 'akr_mine', keyHash: 'h_mine', keyType: 'personal', workspaceId: 'ws_cli', tenantKeyId: 'ak_mine' },
    ]);
    const clerk = clerkProfile();

    const res = await post('/approve', { userCode: 'abcd-2345' });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> & { keyPrefix: string } };
    expect(data).toEqual({
      status: 'complete',
      keyPrefix: data.keyPrefix,
      orgId: ORG,
      orgName: 'CLI Co',
      email: 'cli@example.com',
    });
    expect(data.keyPrefix).toMatch(/^wsk_[0-9a-f]{8}$/);
    expect(clerkCalls(clerk).sort()).toEqual([`GET /organizations/${ORG}`, `GET /users/${USER}`]);

    const live = await tenant.select().from(apiKeys).where(isNull(apiKeys.deletedAt));
    const minted = live.find((k: { name: string; userId: string }) => k.name === 'Weld CLI' && k.userId === USER);
    expect(minted).toMatchObject({
      keyPrefix: data.keyPrefix,
      scopes: ['user-apps:manage'],
      description: 'Minted by weld login (device code)',
      expiresAt: null,
    });
    expect(live.map((k: { id: string }) => k.id).sort()).toEqual([minted.id, 'ak_mine', 'ak_theirs'].sort());
    const registry = await master.select().from(apiKeyRegistry);
    expect(registry.map((r: { tenantKeyId: string }) => r.tenantKeyId).sort()).toEqual([minted.id, 'ak_mine'].sort());
    const [entry] = await master.select().from(apiKeyRegistry).where(eq(apiKeyRegistry.tenantKeyId, minted.id));
    expect(entry).toMatchObject({ keyType: 'personal', workspaceId: 'ws_cli', keyHash: minted.keyHash });

    const session = JSON.parse(kv.store.get(`cli-auth:device:${DEVICE}`)!) as Record<string, unknown>;
    expect(session).toMatchObject({
      status: 'complete',
      keyId: minted.id,
      keyPrefix: data.keyPrefix,
      orgId: ORG,
      orgName: 'CLI Co',
      userId: USER,
      email: 'cli@example.com',
      apiUrl: 'https://api-test.weldsuite.org',
    });
    expect(session.apiKey).toMatch(/^wsk_[0-9a-f]{64}$/);

    // The CLI's next poll picks it up.
    const token = await post('/token', { deviceCode: DEVICE });
    expect(((await token.json()) as { data: { apiKey: string } }).data.apiKey).toBe(session.apiKey);
  });

  it('still mints the key when Clerk cannot label it', async () => {
    pending();
    stubClerk((method, path) => (path === `/organizations/${ORG}` ? { status: 200, body: { name: 'CLI Co' } } : clerkError(404, 'resource_not_found')));
    const res = await post('/approve', { userCode: 'ABCD2345' });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ status: 'complete', orgId: ORG, orgName: null, email: null });
    const [key] = await tenant.select().from(apiKeys).where(and(eq(apiKeys.userId, USER), isNull(apiKeys.deletedAt)));
    expect(key.name).toBe('Weld CLI');
  });

  it('answers an approved session as already approved', async () => {
    kv.store.set(
      `cli-auth:device:${DEVICE}`,
      JSON.stringify({ status: 'complete', deviceCode: DEVICE, userCode: 'ABCD2345', createdAt: Date.now(), apiKey: 'wsk_x' }),
    );
    kv.store.set('cli-auth:user:ABCD2345', DEVICE);
    const res = await post('/approve', { userCode: 'ABCD-2345' });
    expect(await res.json()).toEqual({ data: { status: 'complete', alreadyApproved: true } });
    expect(await tenant.select().from(apiKeys)).toEqual([]);
  });

  it('refuses an unknown code, a body without one and a session without a workspace', async () => {
    const unknown = await post('/approve', { userCode: 'ZZZZ-ZZZZ' });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({
      error: { code: 'BAD_REQUEST', message: 'Code expired or unknown. Run weld login again in the terminal.' },
    });
    expect((await post('/approve', { userCode: 'abc' })).status).toBe(400);
    pending();
    const noOrg = await post('/approve', { userCode: 'ABCD2345' }, { orgId: null });
    expect(noOrg.status).toBe(401);
  });
});
