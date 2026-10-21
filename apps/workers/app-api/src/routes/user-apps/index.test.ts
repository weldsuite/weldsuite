/**
 * /api/user-apps bundle links + preview (dev) sessions against a real pglite
 * master DB: who may mint a bundle link, and who is ever handed a preview URL.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => state.db };
});

import { userAppsRoutes } from './index';
import { splitBundlePath, verifyBundleCapability, type BundleEnv } from '../../services/user-apps-bundle-access';

const { userApps, userAppInstalls, userAppDevSessions } = masterSchema;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for postgres-js
let db: any;

const SECRET = 'internal-secret-for-tests';
const OWNER = 'ws_owner';
const INSTALLER = 'ws_installer';
const STRANGER = 'ws_stranger';

const READ = permissions('weldapps:read');
const DEVELOP = permissions('weldapps:read', 'weldapps:develop');

interface CallerOptions {
  workspaceId?: string;
  userId?: string;
  perms?: ReturnType<typeof permissions>;
  env?: Record<string, unknown>;
}

function caller({ workspaceId = OWNER, userId = 'user_dev', perms = DEVELOP, env = {} }: CallerOptions = {}) {
  const kv = { delete: vi.fn(async () => undefined), get: vi.fn(async () => null), put: vi.fn(async () => undefined) };
  const { request } = createTestApp('/api/user-apps', userAppsRoutes, {
    context: { workspaceId, userId, orgId: null, permissions: perms },
    env: { WORKSPACE_CACHE: kv as unknown as KVNamespace, INTERNAL_API_SECRET: SECRET, ...env } as never,
  });
  return request;
}

const json = { 'content-type': 'application/json' };
const future = () => new Date(Date.now() + 5 * 60 * 1000);

beforeAll(async () => {
  db = (await createMasterPgliteDb()).db;
  state.db = db;

  await db.insert(userApps).values([
    { id: 'uapp_pub', code: 'pubapp', name: 'Public', ownerWorkspaceId: OWNER, createdBy: 'user_dev', visibility: 'public', reviewStatus: 'approved', currentVersionId: 'uav_pub' },
    { id: 'uapp_priv', code: 'privapp', name: 'Private', ownerWorkspaceId: OWNER, createdBy: 'user_dev', visibility: 'private', reviewStatus: 'draft', currentVersionId: 'uav_priv' },
    { id: 'uapp_review', code: 'reviewapp', name: 'In review', ownerWorkspaceId: OWNER, createdBy: 'user_dev', visibility: 'public', reviewStatus: 'submitted', currentVersionId: 'uav_review' },
    { id: 'uapp_nover', code: 'noversion', name: 'No version', ownerWorkspaceId: OWNER, createdBy: 'user_dev', visibility: 'private', reviewStatus: 'draft' },
    { id: 'uapp_off', code: 'offapp', name: 'Inactive', ownerWorkspaceId: OWNER, createdBy: 'user_dev', visibility: 'private', reviewStatus: 'draft', currentVersionId: 'uav_off', isActive: false },
  ]);
  await db.insert(userAppInstalls).values({
    id: 'uai_review_installer',
    appId: 'uapp_review',
    workspaceId: INSTALLER,
    status: 'active',
    installedBy: 'user_installer',
  });
}, 60_000);

beforeEach(async () => {
  await db.delete(userAppDevSessions);
});

describe('POST /code/:code/bundle-url', () => {
  const mintFor = (code: string, options?: CallerOptions) =>
    caller(options)(`/api/user-apps/code/${code}/bundle-url`, { method: 'POST' });

  it('hands a public, approved app its plain URL (no signature)', async () => {
    const res = await mintFor('pubapp', { workspaceId: STRANGER });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { path: string; signed: boolean; expiresAt: string | null } };
    expect(data).toEqual({ path: '/public/user-apps/pubapp/index.html', signed: false, expiresAt: null });
  });

  it('signs a link for the authoring workspace of a private app', async () => {
    const res = await mintFor('privapp');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { path: string; signed: boolean; expiresAt: string } };
    expect(data.signed).toBe(true);

    const rest = data.path.slice('/public/user-apps/privapp/'.length);
    const { token, assetPath } = splitBundlePath(rest);
    expect(assetPath).toBe('index.html');
    expect(token).not.toBeNull();
    const verdict = await verifyBundleCapability({ INTERNAL_API_SECRET: SECRET } as BundleEnv, {
      appId: 'uapp_priv',
      token: token ?? '',
    });
    expect(verdict).toMatchObject({ ok: true, workspaceId: OWNER });
    // ~12 hours.
    const hours = (Date.parse(data.expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(11.9);
    expect(hours).toBeLessThanOrEqual(12);
  });

  it('signs a link, bound to the caller, for a workspace with an active install', async () => {
    const res = await mintFor('reviewapp', { workspaceId: INSTALLER, userId: 'user_member', perms: READ });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { path: string; signed: boolean } };
    expect(data.signed).toBe(true);
    const { token } = splitBundlePath(data.path.slice('/public/user-apps/reviewapp/'.length));
    const verdict = await verifyBundleCapability({ INTERNAL_API_SECRET: SECRET } as BundleEnv, {
      appId: 'uapp_review',
      token: token ?? '',
    });
    expect(verdict).toMatchObject({ ok: true, workspaceId: INSTALLER });
  });

  it('refuses a workspace that neither owns nor has installed the app', async () => {
    expect((await mintFor('privapp', { workspaceId: STRANGER })).status).toBe(404);
    expect((await mintFor('reviewapp', { workspaceId: STRANGER })).status).toBe(404);
  });

  it('stops minting once the install is revoked', async () => {
    await db.update(userAppInstalls).set({ status: 'revoked' }).where(eq(userAppInstalls.id, 'uai_review_installer'));
    try {
      expect((await mintFor('reviewapp', { workspaceId: INSTALLER, perms: READ })).status).toBe(404);
    } finally {
      await db.update(userAppInstalls).set({ status: 'active' }).where(eq(userAppInstalls.id, 'uai_review_installer'));
    }
  });

  it('answers 404 for unknown, inactive and not-yet-published apps', async () => {
    expect((await mintFor('nosuchapp')).status).toBe(404);
    expect((await mintFor('offapp')).status).toBe(404);
    expect((await mintFor('noversion')).status).toBe(404);
  });

  it('fails closed when no signing secret is configured', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await mintFor('privapp', { env: { INTERNAL_API_SECRET: undefined } });
    errors.mockRestore();
    expect(res.status).toBe(500);
  });

  it('needs weldapps:read', async () => {
    expect((await mintFor('privapp', { perms: permissions('crm:read') })).status).toBe(403);
  });
});

describe('preview (dev) sessions', () => {
  const sessionOf = async (options?: CallerOptions) => {
    const res = await caller(options)('/api/user-apps/code/privapp/dev-session');
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { url: string; origin: string; expiresAt: string } | null }).data;
  };

  const seed = (row: { userId: string; workspaceId?: string; url: string; expiresAt?: Date }) =>
    db.insert(userAppDevSessions).values({
      id: `uads_${row.userId}_${row.workspaceId ?? OWNER}`.slice(0, 30),
      appId: 'uapp_priv',
      workspaceId: row.workspaceId ?? OWNER,
      userId: row.userId,
      url: row.url,
      expiresAt: row.expiresAt ?? future(),
    });

  it('returns the developer their own session, with the exact registered origin', async () => {
    await seed({ userId: 'user_dev', url: 'https://abc.trycloudflare.com/app/' });
    const session = await sessionOf();
    expect(session).toMatchObject({ url: 'https://abc.trycloudflare.com/app/', origin: 'https://abc.trycloudflare.com' });
  });

  it("never returns another user's session", async () => {
    await seed({ userId: 'user_dev', url: 'https://abc.trycloudflare.com/' });
    expect(await sessionOf({ userId: 'user_other_dev' })).toBeNull();
  });

  it('never hands a preview to a member who cannot develop, whoever registered it for them', async () => {
    // e.g. a row written for this member through a workspace API key.
    await seed({ userId: 'user_member', url: 'https://attacker.ngrok.app/' });
    expect(await sessionOf({ userId: 'user_member', perms: READ })).toBeNull();
    // With develop it would have been theirs, which is the point of the check.
    expect(await sessionOf({ userId: 'user_member', perms: DEVELOP })).toMatchObject({ origin: 'https://attacker.ngrok.app' });
  });

  it('only returns a session to the authoring workspace of the app', async () => {
    await seed({ userId: 'user_dev', workspaceId: STRANGER, url: 'https://abc.trycloudflare.com/' });
    expect(await sessionOf({ workspaceId: STRANGER })).toBeNull();
  });

  it('ignores expired sessions', async () => {
    await seed({ userId: 'user_dev', url: 'http://localhost:5173/', expiresAt: new Date(Date.now() - 1000) });
    expect(await sessionOf()).toBeNull();
  });

  it('re-checks the stored URL: one that is not an allowed preview URL is not returned', async () => {
    await seed({ userId: 'user_dev', url: 'https://evil.example.com/' });
    expect(await sessionOf()).toBeNull();
    await db.delete(userAppDevSessions);
    await seed({ userId: 'user_dev', url: 'https://user:pass@abc.ngrok.io/' });
    expect(await sessionOf()).toBeNull();
  });

  it('allows loopback previews', async () => {
    await seed({ userId: 'user_dev', url: 'http://localhost:5173/' });
    expect(await sessionOf()).toMatchObject({ origin: 'http://localhost:5173' });
  });

  it('registers the session for the caller, never for a user named in the body', async () => {
    const put = await caller()('/api/user-apps/code/privapp/dev-session', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ url: 'https://mine.trycloudflare.com/', userId: 'user_victim' }),
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as { data: { origin: string } };
    expect(body.data.origin).toBe('https://mine.trycloudflare.com');

    const rows = await db.select().from(userAppDevSessions).where(eq(userAppDevSessions.appId, 'uapp_priv'));
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe('user_dev');
    const victim = await db
      .select()
      .from(userAppDevSessions)
      .where(and(eq(userAppDevSessions.appId, 'uapp_priv'), eq(userAppDevSessions.userId, 'user_victim')));
    expect(victim).toHaveLength(0);
  });

  it('only lets the owning workspace register a session, and only for allowed hosts', async () => {
    const other = await caller({ workspaceId: STRANGER })('/api/user-apps/code/privapp/dev-session', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ url: 'http://localhost:5173/' }),
    });
    expect(other.status).toBe(404);

    const bad = await caller()('/api/user-apps/code/privapp/dev-session', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ url: 'https://evil.example.com/' }),
    });
    expect(bad.status).toBe(400);
  });

  it('needs weldapps:develop to register one', async () => {
    const res = await caller({ perms: READ })('/api/user-apps/code/privapp/dev-session', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ url: 'http://localhost:5173/' }),
    });
    expect(res.status).toBe(403);
  });
});
