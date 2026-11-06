/**
 * `GET /api/weldconnect/github/callback`, GitHub's post-install redirect,
 * through the test app with the tenant on pglite (so the conformance
 * harness runs it against both backends): the state check (a state is good
 * once), the proof that the installer can reach the installation (GitHub's
 * `code`, else the member's linked GitHub account, must list it in
 * `GET /user/installations`), the uninstall action (this workspace's index row
 * only), the connection it stores (a WeldMerge connection in
 * `merge_connections`, and the installation in the master index, never taken
 * from another workspace), and where it sends the browser.
 */

import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { encryptField } from '@weldsuite/db/lib/crypto';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { installStateNonce, rememberInstallNonce } from '@weldsuite/connect-domain/github/install-state';

const holder = vi.hoisted(() => ({ tenant: null as unknown, master: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant),
    getMasterDb: () => conformanceMasterDb(holder.master),
    getWorkspaceForOrg: async (_env: unknown, ref: string) => ({ id: 'ws_test_default', clerkOrgId: ref }),
  };
});

import { githubCallbackRoutes } from './public-github-callback';
import { signInstallStateJwt } from '../services/github/auth';

const { privateKey: GITHUB_APP_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const BASE = '/api/weldconnect/github';
const ORG = 'org_test_default';
const SECRET = 'sk_test_github_state';
const SETTINGS = 'https://app.weldsuite.org/settings/integrations/github';
const WORKSPACE_SETTINGS = `https://app.weldsuite.org/w/${ORG}/settings/integrations/github`;
const KEY = 'ab'.repeat(32);

const kv = createMemoryKv();
const ENV = {
  CLERK_SECRET_KEY: SECRET,
  GITHUB_APP_ID: '123456',
  GITHUB_APP_PRIVATE_KEY,
  GITHUB_APP_CLIENT_ID: 'gh-client',
  GITHUB_APP_CLIENT_SECRET: 'gh-secret',
  DATABASE_ENCRYPTION_KEY: KEY,
  WORKSPACE_CACHE: kv,
};

const realFetch = globalThis.fetch;
const isLoopback = (url: string) => url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Each GitHub call is made once per backend: twice in conformance mode (TypeScript, then Rust). */
const perRun = (expected: string[]) => Array.from({ length: conformanceTarget() ? 2 : 1 }, () => expected).flat();

/** Every GitHub call made since the stub was set, `METHOD url`. */
let calls: string[] = [];

/**
 * GitHub by URL: `good-code` is exchanged for a user token, `GET /user/installations`
 * lists `reachable` (for that token and for a member's linked one), and any
 * installation id but 404 has an account.
 */
function stubGithub(reachable: number[] = []) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (isLoopback(url)) return realFetch(input, init);
      calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${url}`);
      if (url === 'https://github.com/login/oauth/access_token') {
        const { code } = JSON.parse(String(init?.body ?? '{}')) as { code?: string };
        return json(code === 'good-code' ? { access_token: 'ghu_installer', token_type: 'bearer' } : { error: 'bad_verification_code' });
      }
      if (url.startsWith('https://api.github.com/user/installations?')) {
        return json({ total_count: reachable.length, installations: reachable.map((id) => ({ id })) });
      }
      const match = /^https:\/\/api\.github\.com\/app\/installations\/(\d+)$/.exec(url);
      if (match && match[1] !== '404') {
        return json({
          id: Number(match[1]),
          app_slug: 'weldsuite-test',
          account: { login: 'acme-corp', type: 'Organization' },
          repository_selection: 'all',
        });
      }
      return json({ message: 'Not Found' }, 404);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.tenant = db;
  holder.master = master;
}, 60_000);

function callback(query: string, env: Record<string, unknown> = ENV) {
  const { request } = createTestApp(BASE, githubCallbackRoutes, {
    // The master database is shared with the Rust server in conformance mode (the installation index).
    context: { tenantDb: db, orgId: null, masterDb: master },
    env: env as never,
  });
  return request(`${BASE}/callback${query}`);
}

/** A state as the install URL issues it: signed, its nonce remembered in KV. */
async function state(over: Record<string, unknown> = {}, secret = SECRET) {
  const nonce = installStateNonce();
  await rememberInstallNonce(kv, nonce, ORG);
  return signInstallStateJwt({ workspaceId: ORG, userId: 'user_installer', nonce, ...over } as never, secret);
}

const EXCHANGE = 'POST https://github.com/login/oauth/access_token';
const USER_INSTALLATIONS = 'GET https://api.github.com/user/installations?per_page=100&page=1';
const installationCall = (id: number) => `GET https://api.github.com/app/installations/${id}`;
const indexRows = () => master.select().from(masterSchema.mergeProviderIndex);

async function clearAll() {
  await db.delete(schema.mergeConnections);
  await db.delete(schema.mergeProviderAccounts);
  await master.delete(masterSchema.mergeProviderIndex);
}

describe('GET /callback', () => {
  it('sends the browser back with an error without the parameters or a valid state', async () => {
    let res = await callback('');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${SETTINGS}?error=missing_params`);

    res = await callback(`?installation_id=abc&state=${await state()}`);
    expect(res.headers.get('location')).toBe(`${SETTINGS}?error=missing_params`);

    res = await callback(`?installation_id=12&state=${await state({}, 'another-secret')}`);
    expect(res.headers.get('location')).toBe(`${SETTINGS}?error=invalid_state`);

    res = await callback('?installation_id=12&state=not.a.jwt');
    expect(res.headers.get('location')).toBe(`${SETTINGS}?error=invalid_state`);
  });

  it('stores the installation and lands on the workspace’s GitHub settings', async () => {
    await clearAll();
    stubGithub([8101]);
    const res = await callback(`?installation_id=8101&setup_action=install&code=good-code&state=${await state()}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${WORKSPACE_SETTINGS}?installed=1`);
    expect(calls).toEqual(perRun([EXCHANGE, USER_INSTALLATIONS, installationCall(8101)]));
    const [row] = await db.select().from(schema.mergeConnections).where(eq(schema.mergeConnections.externalAccountId, '8101'));
    expect(row).toMatchObject({
      provider: 'github',
      appSlug: 'weldsuite-test',
      accountType: 'organization',
      accountLogin: 'acme-corp',
      status: 'active',
      createdByUserId: 'user_installer',
    });
    expect(row.id).toMatch(/^mcn_/);
    expect(row.webhookSecret).toBeTruthy();
    expect(await indexRows()).toMatchObject([
      { provider: 'github', kind: 'installation', externalKey: '8101', workspaceId: 'ws_test_default' },
    ]);
  });

  it('goes to returnTo when the state carries one', async () => {
    stubGithub([8102]);
    const res = await callback(`?installation_id=8102&code=good-code&state=${await state({ returnTo: 'https://app.example/weldflow/settings' })}`);
    expect(res.headers.get('location')).toBe('https://app.example/weldflow/settings');
  });

  it('takes a state once', async () => {
    stubGithub([8106]);
    const token = await state();
    let res = await callback(`?installation_id=8106&code=good-code&state=${token}`);
    expect(res.headers.get('location')).toBe(`${WORKSPACE_SETTINGS}?installed=1`);

    stubGithub([8106]);
    res = await callback(`?installation_id=8106&code=good-code&state=${token}`);
    expect(res.headers.get('location')).toBe(`${WORKSPACE_SETTINGS}?error=state_expired`);
    const unissued = await signInstallStateJwt({ workspaceId: ORG, userId: 'user_installer', nonce: 'ab'.repeat(16) }, SECRET);
    res = await callback(`?installation_id=8106&code=good-code&state=${unissued}`);
    expect(res.headers.get('location')).toBe(`${WORKSPACE_SETTINGS}?error=state_expired`);
    expect(calls).toEqual([]);
  });

  it('refuses an installation the installer cannot reach, and stores nothing', async () => {
    await clearAll();
    stubGithub([999]);
    let res = await callback(`?installation_id=8107&code=good-code&state=${await state()}`);
    expect(res.headers.get('location')).toBe(`${WORKSPACE_SETTINGS}?error=installation_unverified`);
    expect(calls).toEqual(perRun([EXCHANGE, USER_INSTALLATIONS]));

    // A code GitHub does not take, and no linked GitHub account to ask instead.
    stubGithub([8107]);
    res = await callback(`?installation_id=8107&code=used-code&state=${await state()}`);
    expect(res.headers.get('location')).toBe(`${WORKSPACE_SETTINGS}?error=installation_unverified`);
    expect(calls).toEqual(perRun([EXCHANGE]));

    stubGithub([8107]);
    res = await callback(`?installation_id=8107&state=${await state()}`);
    expect(res.headers.get('location')).toBe(`${WORKSPACE_SETTINGS}?error=installation_unverified`);
    expect(calls).toEqual([]);

    expect(await db.select().from(schema.mergeConnections)).toEqual([]);
    expect(await indexRows()).toEqual([]);
  });

  it('accepts the installer’s linked GitHub account when GitHub sent no code', async () => {
    await clearAll();
    await db.insert(schema.mergeProviderAccounts).values({
      id: 'mpa_cb_installer',
      userId: 'user_installer',
      provider: 'github',
      login: 'installer',
      credentials: await encryptField(JSON.stringify({ accessToken: 'ghu_member' }), { v1: KEY }),
      verifiedAt: new Date('2026-10-01T00:00:00Z'),
    });
    stubGithub([8108]);
    const res = await callback(`?installation_id=8108&state=${await state()}`);
    expect(res.headers.get('location')).toBe(`${WORKSPACE_SETTINGS}?installed=1`);
    expect(calls).toEqual(perRun([USER_INSTALLATIONS, installationCall(8108)]));
    await db.delete(schema.mergeProviderAccounts);
  });

  it('never takes an installation another workspace holds', async () => {
    await clearAll();
    await master.insert(masterSchema.mergeProviderIndex).values({
      id: 'mpi_cb_taken',
      provider: 'github',
      kind: 'installation',
      externalKey: '8109',
      workspaceId: 'ws_somewhere_else',
    });
    stubGithub([8109]);
    const res = await callback(`?installation_id=8109&code=good-code&state=${await state()}`);
    expect(res.headers.get('location')).toBe(`${WORKSPACE_SETTINGS}?error=installation_taken`);
    expect(await indexRows()).toMatchObject([{ id: 'mpi_cb_taken', workspaceId: 'ws_somewhere_else' }]);
    expect(await db.select().from(schema.mergeConnections)).toEqual([]);
  });

  it('revokes the workspace’s connection on an uninstall', async () => {
    await clearAll();
    await db.insert(schema.mergeConnections).values({
      id: 'ghc_cb_1',
      provider: 'github',
      externalAccountId: '8103',
      appSlug: 'weldsuite-test',
      accountType: 'organization',
      accountLogin: 'acme-corp',
      status: 'active',
      createdByUserId: 'user_installer',
    });
    await master.insert(masterSchema.mergeProviderIndex).values({
      id: 'mpi_cb_1',
      provider: 'github',
      kind: 'installation',
      externalKey: '8103',
      workspaceId: 'ws_test_default',
    });
    const res = await callback(`?installation_id=8103&setup_action=delete&state=${await state()}`);
    expect(res.headers.get('location')).toBe(`${WORKSPACE_SETTINGS}?disconnected=1`);
    const [row] = await db.select().from(schema.mergeConnections).where(eq(schema.mergeConnections.id, 'ghc_cb_1'));
    expect(row.status).toBe('revoked');
    expect(row.revokedAt).not.toBeNull();
    expect(await indexRows()).toEqual([]);
  });

  it('leaves another workspace’s index row alone on an uninstall', async () => {
    await clearAll();
    await master.insert(masterSchema.mergeProviderIndex).values({
      id: 'mpi_cb_other',
      provider: 'github',
      kind: 'installation',
      externalKey: '8105',
      workspaceId: 'ws_somewhere_else',
    });
    const res = await callback(`?installation_id=8105&setup_action=delete&state=${await state()}`);
    expect(res.headers.get('location')).toBe(`${WORKSPACE_SETTINGS}?disconnected=1`);
    expect(await indexRows()).toMatchObject([{ id: 'mpi_cb_other', workspaceId: 'ws_somewhere_else' }]);
  });

  it('reports a configuration error without the keys, and an internal one when GitHub refuses', async () => {
    let res = await callback(`?installation_id=8104&state=${await state()}`, { ...ENV, DATABASE_ENCRYPTION_KEY: undefined });
    expect(res.headers.get('location')).toBe(`${WORKSPACE_SETTINGS}?error=configuration_error`);

    res = await callback(`?installation_id=8104&state=${await state()}`, { ...ENV, GITHUB_APP_ID: undefined });
    expect(res.headers.get('location')).toBe(`${WORKSPACE_SETTINGS}?error=configuration_error`);

    res = await callback(`?installation_id=8104&state=${await state()}`, { ...ENV, WORKSPACE_CACHE: undefined });
    expect(res.headers.get('location')).toBe(`${WORKSPACE_SETTINGS}?error=configuration_error`);

    stubGithub([404]);
    res = await callback(`?installation_id=404&code=good-code&state=${await state()}`);
    expect(res.headers.get('location')).toBe(`${WORKSPACE_SETTINGS}?error=internal_error`);
  });
});
