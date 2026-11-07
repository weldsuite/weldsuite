/**
 * GET /public/merge/github/setup: the GitHub App's setup redirect, with the
 * tenant and the master database on pglite and GitHub's REST API stubbed by URL
 * and method. What must not regress:
 *   1. A missing parameter, a state that does not verify (wrong secret,
 *      garbage), an unknown workspace, a worker without the App's keys or KV
 *      and GitHub refusing each send the browser to the providers tab with an
 *      `error=` code, and write nothing.
 *   2. A state is good for one redirect: a replay, or a state whose nonce was
 *      never issued, is `state_expired`.
 *   3. The installation is recorded only when a GitHub user token proves the
 *      installer can reach it: GitHub's `code` (exchanged), else the member's
 *      linked GitHub account, must list it in `GET /user/installations`. A
 *      spoofed `installation_id` is `installation_unverified` and writes nothing.
 *   4. A valid state records the installation: the merge_connections row (account
 *      and App slug from GitHub, a sealed webhook secret, the installing member),
 *      the master installation index row, a merge_connection:created event, and a
 *      redirect to `returnTo` (default the providers tab) inside the workspace.
 *   5. Recording again refreshes the same row (id and secret kept, revoked or
 *      suspended revived) and publishes `updated`.
 *   6. An index row that names another workspace is never re-pointed:
 *      `installation_taken`, nothing written.
 *   7. `setup_action=delete` revokes the workspace's connection and drops the
 *      index row only when it names this workspace.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, conformanceTenantDb } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { installStateNonce, rememberInstallNonce, signInstallStateJwt } from '@weldsuite/connect-domain/github/install-state';

const holder = vi.hoisted(() => ({ tenant: null as unknown, master: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => conformanceMasterDb(holder.master),
    getWorkspaceContextForOrg: async (_env: unknown, ref: string) => {
      if (ref !== 'ws_alpha' && ref !== 'org_alpha') throw new Error(`Workspace not found: ${ref}`);
      return {
        id: 'ws_alpha',
        clerkOrgId: 'org_alpha',
        db: conformanceTenantDb(holder.tenant),
        suspended: false,
        licensedApps: null,
        readOnly: false,
        readOnlyReason: null,
      };
    },
  };
});

import setupRoutes from './github-setup';
import {
  clearEvents,
  eventTypes,
  events,
  makeApp,
  newId,
  openDb,
  perRun,
  resetTables,
  stubGithub,
  type GithubAnswer,
} from '../../test/helpers';
import { fakeKv } from '../../test/fake-http';
import { linkAccount } from '../../test/fake-review';

const SECRET = 'sk_test_setup_state';
const KEY = 'ab'.repeat(32);
const PROVIDERS = 'https://app.weldsuite.org/w/org_alpha/weldmerge/settings?tab=providers';

let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
let kv: ReturnType<typeof fakeKv>;
let env: Record<string, unknown>;

beforeAll(async () => {
  db = await openDb();
  master = (await createMasterPgliteDb()).db;
  holder.tenant = db;
  holder.master = master;
}, 120_000);

beforeEach(async () => {
  await resetTables(db);
  await master.delete(masterSchema.mergeProviderIndex);
  kv = fakeKv();
  env = {
    CLERK_SECRET_KEY: SECRET,
    DATABASE_ENCRYPTION_KEY: KEY,
    GITHUB_APP_CLIENT_ID: 'gh-client',
    GITHUB_APP_CLIENT_SECRET: 'gh-secret',
    WORKSPACE_CACHE: kv,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A state as the install URL issues it: signed, its nonce remembered in KV. */
async function state(over: Record<string, unknown> = {}, secret = SECRET) {
  const nonce = installStateNonce();
  await rememberInstallNonce(kv, nonce, 'ws_alpha');
  return signInstallStateJwt({ workspaceId: 'ws_alpha', userId: 'user_installer', nonce, ...over } as never, secret);
}

const setup = (query: string, overrides: Record<string, unknown> = {}) =>
  makeApp(db, '/public/merge/github', setupRoutes, { env: { ...env, ...overrides }, masterDb: master }).request(
    `/public/merge/github/setup${query}`,
  );

const INSTALLATION_4242 = {
  id: 4242,
  app_slug: 'weldsuite-merge',
  account: { login: 'acme', type: 'Organization' },
  repository_selection: 'all',
};

/** GitHub's answers: the code's user token, the installations it reaches, and installation 4242. */
const github = (reachable: number[] = [4242], extra: Record<string, GithubAnswer> = {}) =>
  stubGithub({
    'POST /login/oauth/access_token': { access_token: 'ghu_installer', token_type: 'bearer', scope: '' },
    'GET /user/installations': { total_count: reachable.length, installations: reachable.map((id) => ({ id })) },
    'GET /app/installations/4242': INSTALLATION_4242,
    ...extra,
  });

const EXCHANGE = { method: 'POST', url: '/login/oauth/access_token' };
const USER_INSTALLATIONS = { method: 'GET', url: '/user/installations?per_page=100&page=1' };
const INSTALLATION = { method: 'GET', url: '/app/installations/4242' };
/** The calls of a proven install: the code's exchange, its user's installations, the installation. */
const PROVEN = [EXCHANGE, USER_INSTALLATIONS, INSTALLATION];

const connectionRows = () => db.select().from(schema.mergeConnections);
const indexRows = () => master.select().from(masterSchema.mergeProviderIndex);
const locationOf = (res: Response) => res.headers.get('location');

describe('errors redirect to the providers tab and write nothing', () => {
  it('without parameters, with a bad state, an unknown workspace or without the App keys or KV', async () => {
    const calls = github();
    let res = await setup('');
    expect(res.status).toBe(302);
    expect(locationOf(res)).toBe('https://app.weldsuite.org/weldmerge/settings?tab=providers&error=missing_params');

    res = await setup(`?installation_id=abc&state=${await state()}`);
    expect(locationOf(res)).toContain('error=missing_params');

    res = await setup(`?installation_id=4242&state=${await state({}, 'another-secret')}`);
    expect(locationOf(res)).toBe('https://app.weldsuite.org/weldmerge/settings?tab=providers&error=invalid_state');
    res = await setup('?installation_id=4242&state=not.a.jwt');
    expect(locationOf(res)).toContain('error=invalid_state');

    res = await setup(`?installation_id=4242&state=${await state({ workspaceId: 'ws_unknown' })}`);
    expect(locationOf(res)).toBe('https://app.weldsuite.org/weldmerge/settings?tab=providers&error=workspace_unavailable');

    res = await setup(`?installation_id=4242&code=c1&state=${await state()}`, { DATABASE_ENCRYPTION_KEY: undefined });
    expect(locationOf(res)).toBe(`${PROVIDERS}&error=configuration_error`);
    res = await setup(`?installation_id=4242&code=c1&state=${await state()}`, { GITHUB_APP_ID: '' });
    expect(locationOf(res)).toBe(`${PROVIDERS}&error=configuration_error`);
    res = await setup(`?installation_id=4242&code=c1&state=${await state()}`, { WORKSPACE_CACHE: undefined });
    expect(locationOf(res)).toBe(`${PROVIDERS}&error=configuration_error`);

    expect(calls).toEqual([]);
    expect(await connectionRows()).toEqual([]);
    expect(await indexRows()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('when GitHub refuses the installation', async () => {
    const calls = github([4242], { 'GET /app/installations/4242': new Response('{"message":"Not Found"}', { status: 404 }) });
    const res = await setup(`?installation_id=4242&code=c1&state=${await state()}`);
    expect(locationOf(res)).toBe(`${PROVIDERS}&error=internal_error`);
    expect(calls).toEqual(perRun(PROVEN));
    expect(await connectionRows()).toEqual([]);
    expect(await indexRows()).toEqual([]);
  });
});

describe('a state is good once', () => {
  it('refuses a replayed state, and one whose nonce was never issued', async () => {
    github();
    const token = await state();
    expect(locationOf(await setup(`?installation_id=4242&code=c1&state=${token}`))).toBe(`${PROVIDERS}&installed=1`);
    clearEvents();

    const calls = github();
    expect(locationOf(await setup(`?installation_id=4242&code=c2&state=${token}`))).toBe(`${PROVIDERS}&error=state_expired`);
    const unissued = await signInstallStateJwt({ workspaceId: 'ws_alpha', userId: 'user_installer', nonce: 'cd'.repeat(16) }, SECRET);
    expect(locationOf(await setup(`?installation_id=4242&code=c3&state=${unissued}`))).toBe(`${PROVIDERS}&error=state_expired`);
    expect(calls).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe('proving the installer can reach the installation', () => {
  it('refuses an installation_id the code’s user cannot reach, and writes nothing', async () => {
    const calls = github([777]);
    const res = await setup(`?installation_id=4242&code=c1&state=${await state()}`);
    expect(locationOf(res)).toBe(`${PROVIDERS}&error=installation_unverified`);
    expect(calls).toEqual(perRun([EXCHANGE, USER_INSTALLATIONS]));
    expect(await connectionRows()).toEqual([]);
    expect(await indexRows()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('refuses without a code and without a linked GitHub account', async () => {
    const calls = github();
    const res = await setup(`?installation_id=4242&state=${await state()}`);
    expect(locationOf(res)).toBe(`${PROVIDERS}&error=installation_unverified`);
    expect(calls).toEqual([]);
    expect(await connectionRows()).toEqual([]);
  });

  it('refuses when GitHub does not take the code and the member has no linked account', async () => {
    const calls = github([4242], { 'POST /login/oauth/access_token': { error: 'bad_verification_code' } });
    const res = await setup(`?installation_id=4242&code=used&state=${await state()}`);
    expect(locationOf(res)).toBe(`${PROVIDERS}&error=installation_unverified`);
    expect(calls).toEqual(perRun([EXCHANGE]));
  });

  it('accepts the member’s linked GitHub account when GitHub sent no code', async () => {
    await linkAccount(db, 'user_installer', 'github', { token: 'ghu_member' });
    const calls = github();
    const res = await setup(`?installation_id=4242&state=${await state()}`);
    expect(locationOf(res)).toBe(`${PROVIDERS}&installed=1`);
    expect(calls).toEqual(perRun([USER_INSTALLATIONS, INSTALLATION]));
    expect(await indexRows()).toMatchObject([{ externalKey: '4242', workspaceId: 'ws_alpha' }]);
  });

  it('reads the user’s installations page by page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: 10_000 + i }));
    const calls = github([], {
      'GET /user/installations': (url: URL) =>
        url.searchParams.get('page') === '1' ? { total_count: 101, installations: page1 } : { total_count: 101, installations: [{ id: 4242 }] },
    });
    const res = await setup(`?installation_id=4242&code=c1&state=${await state()}`);
    expect(locationOf(res)).toBe(`${PROVIDERS}&installed=1`);
    expect(calls).toEqual(
      perRun([EXCHANGE, USER_INSTALLATIONS, { method: 'GET', url: '/user/installations?per_page=100&page=2' }, INSTALLATION]),
    );
  });
});

describe('recording an installation', () => {
  it('writes the connection and the master index, publishes created and lands on the providers tab', async () => {
    const calls = github();
    const res = await setup(`?installation_id=4242&setup_action=install&code=c1&state=${await state()}`);
    expect(res.status).toBe(302);
    expect(locationOf(res)).toBe(`${PROVIDERS}&installed=1`);
    expect(calls).toEqual(perRun(PROVEN));

    const [row] = await connectionRows();
    expect(row).toMatchObject({
      provider: 'github',
      externalAccountId: '4242',
      accountLogin: 'acme',
      accountType: 'organization',
      appSlug: 'weldsuite-merge',
      status: 'active',
      host: null,
      createdByUserId: 'user_installer',
      credentials: null,
    });
    expect(row!.id).toMatch(/^mcn_/);
    expect(row!.installedAt).not.toBeNull();
    expect(row!.revokedAt).toBeNull();
    // Sealed under the keyring (v1 keys write iv:ciphertext), never the plain 64-hex secret.
    expect(row!.webhookSecret).toMatch(/:/);

    expect(await indexRows()).toMatchObject([{ provider: 'github', kind: 'installation', externalKey: '4242', workspaceId: 'ws_alpha' }]);
    expect(eventTypes()).toEqual(['merge_connection:created']);
    expect(events[0]!.data).toEqual({ id: newId(row!.id), provider: 'github', accountLogin: 'acme', status: 'active' });
    expect(events[0]!.metadata).toMatchObject({ userId: 'user_installer', workspaceId: 'org_alpha' });
  });

  it('goes to a same-app returnTo from the state', async () => {
    github();
    const res = await setup(`?installation_id=4242&code=c1&state=${await state({ returnTo: '/weldmerge/onboarding' })}`);
    expect(locationOf(res)).toBe('https://app.weldsuite.org/w/org_alpha/weldmerge/onboarding');
  });

  it('refreshes the same connection the second time, keeping its id and secret, and reviving it', async () => {
    github();
    await setup(`?installation_id=4242&code=c1&state=${await state()}`);
    const [first] = await connectionRows();
    await db.update(schema.mergeConnections).set({ status: 'revoked', revokedAt: new Date(), accountLogin: 'old-name' });
    clearEvents();

    const res = await setup(`?installation_id=4242&code=c2&state=${await state({ userId: 'user_other' })}`);
    expect(locationOf(res)).toBe(`${PROVIDERS}&installed=1`);
    const rows = await connectionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first!.id, status: 'active', accountLogin: 'acme', revokedAt: null, createdByUserId: 'user_installer' });
    expect(rows[0]!.webhookSecret).toBe(first!.webhookSecret);
    expect(await indexRows()).toHaveLength(1);
    expect(eventTypes()).toEqual(['merge_connection:updated']);
  });

  it('never takes an installation whose index row names another workspace', async () => {
    github();
    await master.insert(masterSchema.mergeProviderIndex).values({
      id: 'mpi_other',
      provider: 'github',
      kind: 'installation',
      externalKey: '4242',
      workspaceId: 'ws_somewhere_else',
    });
    const res = await setup(`?installation_id=4242&code=c1&state=${await state()}`);
    expect(locationOf(res)).toBe(`${PROVIDERS}&error=installation_taken`);
    expect(await indexRows()).toMatchObject([{ id: 'mpi_other', workspaceId: 'ws_somewhere_else' }]);
    expect(await connectionRows()).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe('setup_action=delete', () => {
  it('revokes the connection, drops the index row and publishes updated', async () => {
    github();
    await setup(`?installation_id=4242&code=c1&state=${await state()}`);
    clearEvents();

    const calls = stubGithub({});
    const res = await setup(`?installation_id=4242&setup_action=delete&state=${await state()}`);
    expect(res.status).toBe(302);
    expect(locationOf(res)).toBe(`${PROVIDERS}&disconnected=1`);
    expect(calls).toEqual([]);
    const [row] = await db
      .select()
      .from(schema.mergeConnections)
      .where(and(eq(schema.mergeConnections.provider, 'github'), eq(schema.mergeConnections.externalAccountId, '4242')));
    expect(row).toMatchObject({ status: 'revoked' });
    expect(row!.revokedAt).not.toBeNull();
    expect(await indexRows()).toEqual([]);
    expect(eventTypes()).toEqual(['merge_connection:updated']);
  });

  it('leaves another workspace’s index row alone', async () => {
    await master.insert(masterSchema.mergeProviderIndex).values({
      id: 'mpi_other',
      provider: 'github',
      kind: 'installation',
      externalKey: '4242',
      workspaceId: 'ws_somewhere_else',
    });
    const calls = stubGithub({});
    const res = await setup(`?installation_id=4242&setup_action=delete&state=${await state()}`);
    expect(locationOf(res)).toBe(`${PROVIDERS}&disconnected=1`);
    expect(calls).toEqual([]);
    expect(await indexRows()).toMatchObject([{ id: 'mpi_other', workspaceId: 'ws_somewhere_else' }]);
    expect(events).toEqual([]);
  });
});
