/**
 * `GET /api/weldconnect/github/callback`, GitHub's post-install redirect,
 * through the test app with the tenant on pglite (so the conformance
 * harness runs it against both backends): the state check, the uninstall
 * action, the connection it stores, and where it sends the browser.
 */

import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const holder = vi.hoisted(() => ({ tenant: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant) };
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

const ENV = {
  CLERK_SECRET_KEY: SECRET,
  GITHUB_APP_ID: '123456',
  GITHUB_APP_PRIVATE_KEY,
  DATABASE_ENCRYPTION_KEY: 'ab'.repeat(32),
};

const realFetch = globalThis.fetch;
const isLoopback = (url: string) => url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost');

function stubGithub() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (isLoopback(url)) return realFetch(input, init);
      const match = /^https:\/\/api\.github\.com\/app\/installations\/(\d+)$/.exec(url);
      if (match && match[1] !== '404') {
        return new Response(
          JSON.stringify({
            id: Number(match[1]),
            app_slug: 'weldsuite-test',
            account: { login: 'acme-corp', type: 'Organization' },
            repository_selection: 'all',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  holder.tenant = db;
}, 60_000);

function callback(query: string, env: Record<string, unknown> = ENV) {
  const { request } = createTestApp(BASE, githubCallbackRoutes, {
    context: { tenantDb: db, orgId: null },
    env: env as never,
  });
  return request(`${BASE}/callback${query}`);
}

const state = (over: Record<string, unknown> = {}, secret = SECRET) =>
  signInstallStateJwt({ workspaceId: ORG, userId: 'user_installer', nonce: 'ab'.repeat(16), ...over } as never, secret);

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
    stubGithub();
    await db.delete(schema.githubConnections);
    const res = await callback(`?installation_id=8101&setup_action=install&state=${await state()}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${WORKSPACE_SETTINGS}?installed=1`);
    const [row] = await db.select().from(schema.githubConnections).where(eq(schema.githubConnections.installationId, 8101));
    expect(row).toMatchObject({ workspaceId: ORG, ownerType: 'org', ownerLogin: 'acme-corp', status: 'active', createdBy: 'user_installer' });
    expect(row.webhookSecret).toBeTruthy();
  });

  it('goes to returnTo when the state carries one', async () => {
    stubGithub();
    const res = await callback(`?installation_id=8102&state=${await state({ returnTo: 'https://app.example/weldflow/settings' })}`);
    expect(res.headers.get('location')).toBe('https://app.example/weldflow/settings');
  });

  it('revokes the workspace’s connection on an uninstall', async () => {
    await db.delete(schema.githubConnections);
    await db.insert(schema.githubConnections).values({
      id: 'ghc_cb_1',
      workspaceId: ORG,
      installationId: 8103,
      appSlug: 'weldsuite-test',
      ownerType: 'org',
      ownerLogin: 'acme-corp',
      status: 'active',
    });
    const res = await callback(`?installation_id=8103&setup_action=delete&state=${await state()}`);
    expect(res.headers.get('location')).toBe(`${WORKSPACE_SETTINGS}?disconnected=1`);
    const [row] = await db.select().from(schema.githubConnections).where(eq(schema.githubConnections.id, 'ghc_cb_1'));
    expect(row.status).toBe('revoked');
  });

  it('reports a configuration error without the keys, and an internal one when GitHub refuses', async () => {
    let res = await callback(`?installation_id=8104&state=${await state()}`, { ...ENV, DATABASE_ENCRYPTION_KEY: undefined });
    expect(res.headers.get('location')).toBe(`${WORKSPACE_SETTINGS}?error=configuration_error`);

    res = await callback(`?installation_id=8104&state=${await state()}`, { ...ENV, GITHUB_APP_ID: undefined });
    expect(res.headers.get('location')).toBe(`${WORKSPACE_SETTINGS}?error=configuration_error`);

    stubGithub();
    res = await callback(`?installation_id=404&state=${await state()}`);
    expect(res.headers.get('location')).toBe(`${WORKSPACE_SETTINGS}?error=internal_error`);
  });
});
