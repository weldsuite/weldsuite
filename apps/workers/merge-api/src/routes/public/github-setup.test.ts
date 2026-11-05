/**
 * GET /public/merge/github/setup: the GitHub App's setup redirect, with the
 * tenant and the master database on pglite and GitHub's REST API stubbed by URL
 * and method. What must not regress:
 *   1. A missing parameter, a state that does not verify (wrong secret,
 *      garbage), an unknown workspace, a worker without the App's keys and
 *      GitHub refusing each send the browser to the providers tab with an
 *      `error=` code, and write nothing.
 *   2. A valid state records the installation: the merge_connections row (account
 *      and App slug from GitHub, a sealed webhook secret, the installing member),
 *      the master installation index row, a merge_connection:created event, and a
 *      redirect to `returnTo` (default the providers tab) inside the workspace.
 *   3. Recording again refreshes the same row (id and secret kept, revoked or
 *      suspended revived) and publishes `updated`.
 *   4. `setup_action=delete` revokes the connection, drops the index row and
 *      publishes `updated`.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, conformanceTenantDb } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { signInstallStateJwt } from '@weldsuite/connect-domain/github/install-state';

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
} from '../../test/helpers';

const SECRET = 'sk_test_setup_state';
const KEY = 'ab'.repeat(32);
const ENV = { CLERK_SECRET_KEY: SECRET, DATABASE_ENCRYPTION_KEY: KEY };
const PROVIDERS = 'https://app.weldsuite.org/w/org_alpha/weldmerge/settings?tab=providers';

let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;

beforeAll(async () => {
  db = await openDb();
  master = (await createMasterPgliteDb()).db;
  holder.tenant = db;
  holder.master = master;
}, 120_000);

beforeEach(async () => {
  await resetTables(db);
  await master.delete(masterSchema.mergeProviderIndex);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const state = (over: Record<string, unknown> = {}, secret = SECRET) =>
  signInstallStateJwt({ workspaceId: 'ws_alpha', userId: 'user_installer', nonce: 'cd'.repeat(16), ...over } as never, secret);

const setup = (query: string, env: Record<string, unknown> = ENV) =>
  makeApp(db, '/public/merge/github', setupRoutes, { env, masterDb: master }).request(`/public/merge/github/setup${query}`);

const INSTALLATION_4242 = {
  id: 4242,
  app_slug: 'weldsuite-merge',
  account: { login: 'acme', type: 'Organization' },
  repository_selection: 'all',
};

const stubInstallation = () => stubGithub({ 'GET /app/installations/4242': INSTALLATION_4242 });
const connectionRows = () => db.select().from(schema.mergeConnections);
const indexRows = () => master.select().from(masterSchema.mergeProviderIndex);
const locationOf = (res: Response) => res.headers.get('location');

describe('errors redirect to the providers tab and write nothing', () => {
  it('without parameters, with a bad state, an unknown workspace or without the App keys', async () => {
    const calls = stubInstallation();
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

    res = await setup(`?installation_id=4242&state=${await state()}`, { ...ENV, DATABASE_ENCRYPTION_KEY: undefined });
    expect(locationOf(res)).toBe(`${PROVIDERS}&error=configuration_error`);
    res = await setup(`?installation_id=4242&state=${await state()}`, { ...ENV, GITHUB_APP_ID: '' });
    expect(locationOf(res)).toBe(`${PROVIDERS}&error=configuration_error`);

    expect(calls).toEqual([]);
    expect(await connectionRows()).toEqual([]);
    expect(await indexRows()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('when GitHub refuses the installation', async () => {
    const calls = stubGithub({});
    const res = await setup(`?installation_id=4242&state=${await state()}`);
    expect(locationOf(res)).toBe(`${PROVIDERS}&error=internal_error`);
    expect(calls).toEqual(perRun([{ method: 'GET', url: '/app/installations/4242' }]));
    expect(await connectionRows()).toEqual([]);
    expect(await indexRows()).toEqual([]);
  });
});

describe('recording an installation', () => {
  it('writes the connection and the master index, publishes created and lands on the providers tab', async () => {
    const calls = stubInstallation();
    const res = await setup(`?installation_id=4242&setup_action=install&state=${await state()}`);
    expect(res.status).toBe(302);
    expect(locationOf(res)).toBe(`${PROVIDERS}&installed=1`);
    expect(calls).toEqual(perRun([{ method: 'GET', url: '/app/installations/4242' }]));

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
    stubInstallation();
    const res = await setup(`?installation_id=4242&state=${await state({ returnTo: '/weldmerge/onboarding' })}`);
    expect(locationOf(res)).toBe('https://app.weldsuite.org/w/org_alpha/weldmerge/onboarding');
  });

  it('refreshes the same connection the second time, keeping its id and secret, and reviving it', async () => {
    stubInstallation();
    await setup(`?installation_id=4242&state=${await state()}`);
    const [first] = await connectionRows();
    await db.update(schema.mergeConnections).set({ status: 'revoked', revokedAt: new Date(), accountLogin: 'old-name' });
    clearEvents();

    const res = await setup(`?installation_id=4242&state=${await state({ userId: 'user_other' })}`);
    expect(locationOf(res)).toBe(`${PROVIDERS}&installed=1`);
    const rows = await connectionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first!.id, status: 'active', accountLogin: 'acme', revokedAt: null, createdByUserId: 'user_installer' });
    expect(rows[0]!.webhookSecret).toBe(first!.webhookSecret);
    expect(await indexRows()).toHaveLength(1);
    expect(eventTypes()).toEqual(['merge_connection:updated']);
  });

  it('moves the index row to the workspace that records the installation last', async () => {
    stubInstallation();
    await master.insert(masterSchema.mergeProviderIndex).values({
      id: 'mpi_old',
      provider: 'github',
      kind: 'installation',
      externalKey: '4242',
      workspaceId: 'ws_somewhere_else',
    });
    await setup(`?installation_id=4242&state=${await state()}`);
    expect(await indexRows()).toMatchObject([{ id: 'mpi_old', workspaceId: 'ws_alpha' }]);
  });
});

describe('setup_action=delete', () => {
  it('revokes the connection, drops the index row and publishes updated', async () => {
    stubInstallation();
    await setup(`?installation_id=4242&state=${await state()}`);
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
});
