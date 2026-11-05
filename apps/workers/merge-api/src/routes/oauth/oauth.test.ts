/**
 * DB-backed tests for connecting GitLab, Bitbucket and Azure DevOps and for
 * linking members' own accounts (authorize URLs, the OAuth callback, token
 * connections, unlinking), on a real tenant schema (pglite) with every
 * provider host stubbed by method and URL. What must not regress:
 *   1. The authorize URL carries the app's client id, the fixed redirect URI
 *      and a single-use state in KV; an unsafe returnTo is dropped.
 *   2. The callback exchanges the code, stores the credentials sealed (never
 *      returned, never in an event), and refuses a state that is spent,
 *      belongs to someone else, or needs a permission the caller lacks.
 *   3. Azure DevOps with several organisations waits for the member to choose.
 *   4. Self-managed GitLab connects (and links) with a validated https token.
 *   5. Linking an account claims the pull requests that login authored.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type {
  MergeAuthorizeUrlDto,
  MergeOauthCallbackResult,
} from '@weldsuite/app-api-client/schemas/weldmerge-providers';
import type { MergeConnectionDto, MergeProviderAccountsDto } from '@weldsuite/app-api-client/schemas/weldmerge';
import accountsRoutes from '../accounts';
import accountsOauthRoutes from '../accounts/oauth';
import connectionsRoutes from '../connections';
import connectionsOauthRoutes from '../connections/oauth';
import oauthRoutes from './index';
import { openCredentials } from '../../services/credentials';
import { ADMIN, ALICE, BOB, MEMBER, VIEWER, clearEvents, errorCode, eventTypes, events, jsonInit, makeApp, newId, ok, openDb, perRun, resetTables } from '../../test/helpers';
import { failure, fakeKv, stubHttp } from '../../test/fake-http';
import { compose, ENCRYPTION_KEY, providerEnv } from '../../test/provider-env';
import { seedConnection, seedPullRequest, seedRepository } from '../../test/seed';

let db: Database;

beforeAll(async () => {
  db = await openDb();
}, 120_000);

beforeEach(async () => {
  await resetTables(db);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const router = compose([
  ['/connections', connectionsRoutes],
  ['/connections', connectionsOauthRoutes],
  ['/accounts', accountsRoutes],
  ['/accounts', accountsOauthRoutes],
  ['/oauth', oauthRoutes],
]);

const app = (kv: KVNamespace, grants = ADMIN, userId = ALICE, env = {}) =>
  makeApp(db, '/api/merge', router, { grants, userId, env: providerEnv({ WORKSPACE_CACHE: kv, ...env }) });

const get = (a: ReturnType<typeof app>, path: string) => a.request(`/api/merge${path}`);
const post = (a: ReturnType<typeof app>, path: string, body: unknown) => a.request(`/api/merge${path}`, jsonInit(body));

const stateOf = (url: string) => new URL(url).searchParams.get('state')!;

/** Starts a round trip and returns its state id. */
async function start(kv: KVNamespace, path: string, grants = ADMIN, userId = ALICE): Promise<string> {
  const dto = await ok<MergeAuthorizeUrlDto>(await get(app(kv, grants, userId), path));
  return stateOf(dto.url);
}

const GITLAB_TOKEN = { access_token: 'gl-access', refresh_token: 'gl-refresh', expires_in: 7200, token_type: 'Bearer' };

describe('authorize URLs', () => {
  it('builds the GitLab, Bitbucket and Azure DevOps consent URLs for a workspace connection', async () => {
    const kv = fakeKv();
    const redirect = 'https://app.test/weldmerge/oauth/callback';

    const gitlab = new URL((await ok<MergeAuthorizeUrlDto>(await get(app(kv), '/connections/gitlab/authorize-url?returnTo=/weldmerge/settings'))).url);
    expect(`${gitlab.origin}${gitlab.pathname}`).toBe('https://gitlab.com/oauth/authorize');
    expect(Object.fromEntries(gitlab.searchParams)).toMatchObject({
      client_id: 'gl-client',
      redirect_uri: redirect,
      response_type: 'code',
      scope: 'api',
    });

    const bitbucket = new URL((await ok<MergeAuthorizeUrlDto>(await get(app(kv), '/connections/bitbucket/authorize-url'))).url);
    expect(`${bitbucket.origin}${bitbucket.pathname}`).toBe('https://bitbucket.org/site/oauth2/authorize');
    expect(Object.fromEntries(bitbucket.searchParams)).toMatchObject({ client_id: 'bb-client', redirect_uri: redirect, response_type: 'code' });

    const azure = new URL((await ok<MergeAuthorizeUrlDto>(await get(app(kv), '/connections/azure_devops/authorize-url'))).url);
    expect(`${azure.origin}${azure.pathname}`).toBe('https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize');
    expect(Object.fromEntries(azure.searchParams)).toMatchObject({
      client_id: 'az-client',
      redirect_uri: redirect,
      scope: '499b84ac-1321-427f-aa17-267ca6975798/.default offline_access',
    });

    expect(kv.entries.size).toBe(3);
    const state = JSON.parse(kv.entries.get(`merge_oauth_state:${stateOf(gitlab.href)}`)!);
    expect(state).toEqual({
      workspaceId: 'ws_alpha',
      userId: ALICE,
      provider: 'gitlab',
      purpose: 'connection',
      host: null,
      returnTo: '/weldmerge/settings',
    });
  });

  it('drops a returnTo that is not a same-app path', async () => {
    const kv = fakeKv();
    for (const returnTo of ['https://evil.example/x', '//evil.example', 'weldmerge/settings']) {
      const id = await start(kv, `/connections/gitlab/authorize-url?returnTo=${encodeURIComponent(returnTo)}`);
      expect(JSON.parse(kv.entries.get(`merge_oauth_state:${id}`)!).returnTo).toBeNull();
    }
  });

  it('builds the member link URLs, GitHub included', async () => {
    const kv = fakeKv();
    const github = new URL((await ok<MergeAuthorizeUrlDto>(await get(app(kv, MEMBER, BOB), '/accounts/github/authorize-url'))).url);
    expect(`${github.origin}${github.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(Object.fromEntries(github.searchParams)).toMatchObject({
      client_id: 'gh-client',
      redirect_uri: 'https://app.test/weldmerge/oauth/callback',
    });
    expect(JSON.parse(kv.entries.get(`merge_oauth_state:${stateOf(github.href)}`)!)).toMatchObject({ provider: 'github', purpose: 'account', userId: BOB });
    expect((await get(app(kv, VIEWER, BOB), '/accounts/bitbucket/authorize-url')).status).toBe(200);
  });

  it('answers 404 for an unknown provider (and GitHub, which installs the App), 403 without permission, 503 without the OAuth app', async () => {
    const kv = fakeKv();
    expect((await get(app(kv), '/connections/github/authorize-url')).status).toBe(404);
    expect((await get(app(kv), '/connections/svn/authorize-url')).status).toBe(404);
    expect((await get(app(kv), '/accounts/svn/authorize-url')).status).toBe(404);
    expect((await get(app(kv, MEMBER), '/connections/gitlab/authorize-url')).status).toBe(403);
    expect((await get(app(kv, []), '/accounts/gitlab/authorize-url')).status).toBe(403);
    const unconfigured = await get(app(kv, ADMIN, ALICE, { GITLAB_OAUTH_CLIENT_ID: undefined }), '/connections/gitlab/authorize-url');
    expect(unconfigured.status).toBe(503);
    expect(await errorCode(unconfigured)).toBe('SERVICE_UNAVAILABLE');
  });

  it('refuses an OAuth link for a self-managed GitLab host (it links with a token)', async () => {
    const res = await get(app(fakeKv(), MEMBER, BOB), `/accounts/gitlab/authorize-url?host=${encodeURIComponent('https://git.example.com')}`);
    expect(res.status).toBe(422);
  });
});

describe('callback: workspace connections', () => {
  it('connects GitLab: exchanges the code, stores the credentials sealed, publishes the event without them', async () => {
    const kv = fakeKv();
    const calls = stubHttp({
      'POST gitlab.com/oauth/token': GITLAB_TOKEN,
      'GET gitlab.com/api/v4/user': { id: 42, username: 'Alice-GL', name: 'Alice', avatar_url: 'https://gl/a.png' },
    });
    const state = await start(kv, '/connections/gitlab/authorize-url?returnTo=/weldmerge/settings');
    clearEvents();

    const result = await ok<MergeOauthCallbackResult>(await post(app(kv), '/oauth/callback', { code: 'code-1', state }));
    expect(result).toEqual({
      purpose: 'connection',
      provider: 'gitlab',
      returnTo: '/weldmerge/settings',
      connectionId: expect.stringMatching(/^mcn_/),
      accountId: null,
    });

    expect(calls).toEqual(
      perRun([
        {
          method: 'POST',
          url: 'gitlab.com/oauth/token',
          body: {
            client_id: 'gl-client',
            client_secret: 'gl-secret',
            code: 'code-1',
            grant_type: 'authorization_code',
            redirect_uri: 'https://app.test/weldmerge/oauth/callback',
          },
          auth: undefined,
        },
        { method: 'GET', url: 'gitlab.com/api/v4/user', auth: 'bearer gl-access' },
      ]),
    );

    const [row] = await db.select().from(schema.mergeConnections);
    expect(row).toMatchObject({
      provider: 'gitlab',
      externalAccountId: '42',
      accountLogin: 'alice-gl',
      host: null,
      status: 'active',
      oauthUserLogin: 'alice-gl',
      createdByUserId: ALICE,
    });
    expect(row!.credentials).not.toContain('gl-access');
    expect(await openCredentials({ DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY }, row!.credentials)).toMatchObject({
      accessToken: 'gl-access',
      refreshToken: 'gl-refresh',
    });
    expect(row!.credentialsExpireAt!.getTime()).toBeGreaterThan(Date.now() + 7000 * 1000);

    expect(eventTypes()).toEqual(['merge_connection:created']);
    expect(events[0]!.data).toEqual({ id: newId(row!.id), provider: 'gitlab', accountLogin: 'alice-gl', status: 'active' });
  });

  it('renews the same account instead of adding a connection', async () => {
    const kv = fakeKv();
    stubHttp({ 'POST gitlab.com/oauth/token': GITLAB_TOKEN, 'GET gitlab.com/api/v4/user': { id: 42, username: 'alice-gl' } });
    for (let i = 0; i < 2; i++) {
      const state = await start(kv, '/connections/gitlab/authorize-url');
      clearEvents();
      await ok<MergeOauthCallbackResult>(await post(app(kv), '/oauth/callback', { code: `c${i}`, state }));
    }
    expect(await db.select().from(schema.mergeConnections)).toHaveLength(1);
    expect(eventTypes()).toEqual(['merge_connection:updated']);
  });

  it('connects Bitbucket with basic-auth token calls', async () => {
    const kv = fakeKv();
    const calls = stubHttp({
      'POST bitbucket.org/site/oauth2/access_token': { access_token: 'bb-access', refresh_token: 'bb-refresh', expires_in: 7200, token_type: 'bearer' },
      'GET api.bitbucket.org/2.0/user': { uuid: '{user-1}', nickname: 'Alice-BB', display_name: 'Alice' },
    });
    const state = await start(kv, '/connections/bitbucket/authorize-url');
    const result = await ok<MergeOauthCallbackResult>(await post(app(kv), '/oauth/callback', { code: 'code-b', state }));
    expect(result).toMatchObject({ provider: 'bitbucket', purpose: 'connection', returnTo: null });
    expect(calls[0]).toEqual({
      method: 'POST',
      url: 'bitbucket.org/site/oauth2/access_token',
      body: { grant_type: 'authorization_code', code: 'code-b', redirect_uri: 'https://app.test/weldmerge/oauth/callback' },
      auth: 'basic bb-client:bb-secret',
    });
    const [row] = await db.select().from(schema.mergeConnections);
    expect(row).toMatchObject({ provider: 'bitbucket', externalAccountId: '{user-1}', accountLogin: 'alice-bb' });
  });

  it('connects Azure DevOps with one organisation straight away', async () => {
    const kv = fakeKv();
    const calls = stubHttp({
      'POST login.microsoftonline.com/organizations/oauth2/v2.0/token': { access_token: 'az-access', refresh_token: 'az-refresh', expires_in: 3600, token_type: 'Bearer' },
      'GET app.vssps.visualstudio.com/_apis/profile/profiles/me': { id: 'profile-1', emailAddress: 'Alice@Acme.com', displayName: 'Alice' },
      'GET app.vssps.visualstudio.com/_apis/accounts': { value: [{ accountName: 'acme' }] },
    });
    const state = await start(kv, '/connections/azure_devops/authorize-url');
    const result = await ok<MergeOauthCallbackResult>(await post(app(kv), '/oauth/callback', { code: 'code-a', state }));
    expect(result.organizations).toBeUndefined();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(
      perRun([
        'POST login.microsoftonline.com/organizations/oauth2/v2.0/token',
        'GET app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1',
        'GET app.vssps.visualstudio.com/_apis/accounts?memberId=profile-1&api-version=7.1',
      ]),
    );
    const [row] = await db.select().from(schema.mergeConnections);
    expect(row).toMatchObject({
      provider: 'azure_devops',
      externalAccountId: 'acme',
      host: 'https://dev.azure.com/acme',
      status: 'active',
      oauthUserLogin: 'alice@acme.com',
    });
  });

  it('waits for the member to choose when Azure DevOps has several organisations', async () => {
    const kv = fakeKv();
    stubHttp({
      'POST login.microsoftonline.com/organizations/oauth2/v2.0/token': { access_token: 'az-access', refresh_token: 'az-refresh', expires_in: 3600 },
      'GET app.vssps.visualstudio.com/_apis/profile/profiles/me': { id: 'profile-1', emailAddress: 'alice@acme.com' },
      'GET app.vssps.visualstudio.com/_apis/accounts': { value: [{ accountName: 'acme' }, { accountName: 'beta' }] },
    });
    const state = await start(kv, '/connections/azure_devops/authorize-url');
    const result = await ok<MergeOauthCallbackResult>(await post(app(kv), '/oauth/callback', { code: 'code-a', state }));
    expect(result.organizations).toEqual([
      { name: 'acme', url: 'https://dev.azure.com/acme' },
      { name: 'beta', url: 'https://dev.azure.com/beta' },
    ]);
    const [row] = await db.select().from(schema.mergeConnections);
    expect(row).toMatchObject({ status: 'needs_attention', host: null });

    // The member picks one; their token has to reach it.
    stubHttp({ 'GET dev.azure.com/beta/_apis/projects': { count: 1, value: [{ name: 'Platform' }] } });
    clearEvents();
    const chosen = await ok<MergeConnectionDto>(
      await post(app(kv), '/connections/azure_devops/organization', { connectionId: row!.id, organization: 'beta' }),
    );
    expect(chosen).toMatchObject({ status: 'active', host: 'https://dev.azure.com/beta', externalAccountId: 'beta' });
    expect(chosen).not.toHaveProperty('credentials');
    expect(eventTypes()).toEqual(['merge_connection:updated']);

    // An organisation the token cannot reach is refused.
    stubHttp({ 'GET dev.azure.com/gamma/_apis/projects': failure(401, { message: 'no access' }) });
    const refused = await post(app(kv), '/connections/azure_devops/organization', { connectionId: row!.id, organization: 'gamma' });
    expect(refused.status).toBe(422);
    expect((await db.select().from(schema.mergeConnections))[0]!.host).toBe('https://dev.azure.com/beta');
  });

  it('refuses a state that is spent, unknown, someone else\'s, or needs a permission the caller lacks', async () => {
    const kv = fakeKv();
    stubHttp({ 'POST gitlab.com/oauth/token': GITLAB_TOKEN, 'GET gitlab.com/api/v4/user': { id: 42, username: 'alice-gl' } });

    const used = await start(kv, '/connections/gitlab/authorize-url');
    expect((await post(app(kv), '/oauth/callback', { code: 'c', state: used })).status).toBe(200);
    const second = await post(app(kv), '/oauth/callback', { code: 'c', state: used });
    expect(second.status).toBe(400);
    expect(await errorCode(second)).toBe('invalid_state');
    expect((await post(app(kv), '/oauth/callback', { code: 'c', state: 'nope' })).status).toBe(400);

    const mine = await start(kv, '/connections/gitlab/authorize-url');
    expect((await post(app(kv, MEMBER, BOB), '/oauth/callback', { code: 'c', state: mine })).status).toBe(403);
    // The state was spent by the refused attempt: it cannot be replayed by its owner either.
    expect((await post(app(kv), '/oauth/callback', { code: 'c', state: mine })).status).toBe(400);

    // A member who lost merge_connections:manage in between cannot finish a connection.
    const lost = await start(kv, '/connections/gitlab/authorize-url');
    expect((await post(app(kv, MEMBER), '/oauth/callback', { code: 'c', state: lost })).status).toBe(403);
    expect((await post(app(kv), '/oauth/callback', { code: '', state: lost })).status).toBe(400);
  });

  it('answers a provider failure with 502 and the provider\'s own message', async () => {
    const kv = fakeKv();
    stubHttp({ 'POST gitlab.com/oauth/token': failure(400, { error: 'invalid_grant', error_description: 'The code expired' }) });
    const state = await start(kv, '/connections/gitlab/authorize-url');
    const res = await post(app(kv), '/oauth/callback', { code: 'old', state });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error).toEqual({ code: 'provider_error', message: 'The code expired' });
    expect(await db.select().from(schema.mergeConnections)).toEqual([]);
  });
});

describe('callback: member accounts', () => {
  it('links the member\'s GitLab account, claims the pull requests the login authored, and publishes nothing', async () => {
    const kv = fakeKv();
    const connection = await seedConnection(db, { provider: 'gitlab', externalAccountId: '1' });
    const repo = await seedRepository(db, connection.id, { provider: 'gitlab', externalId: '55' });
    const mine = await seedPullRequest(db, repo.id, 1, { provider: 'gitlab', authorLogin: 'bob-gl' });
    const other = await seedPullRequest(db, repo.id, 2, { provider: 'gitlab', authorLogin: 'someone' });
    stubHttp({
      'POST gitlab.com/oauth/token': GITLAB_TOKEN,
      'GET gitlab.com/api/v4/user': { id: 9, username: 'Bob-GL', name: 'Bob', avatar_url: 'https://gl/b.png' },
    });
    const state = await start(kv, '/accounts/gitlab/authorize-url?returnTo=/weldmerge', MEMBER, BOB);
    clearEvents();

    const result = await ok<MergeOauthCallbackResult>(await post(app(kv, MEMBER, BOB), '/oauth/callback', { code: 'c', state }));
    expect(result).toMatchObject({ purpose: 'account', provider: 'gitlab', returnTo: '/weldmerge', connectionId: null });
    expect(result.accountId).toMatch(/^mpa_/);
    expect(events).toEqual([]);

    const accounts = await ok<MergeProviderAccountsDto>(await get(app(kv, MEMBER, BOB), '/accounts/me'));
    expect(accounts.accounts).toEqual([
      { id: result.accountId, provider: 'gitlab', host: null, login: 'bob-gl', verified: true, avatarUrl: 'https://gl/b.png', displayName: 'Bob' },
    ]);
    expect(JSON.stringify(accounts)).not.toContain('gl-access');

    const [row] = await db.select().from(schema.mergeProviderAccounts);
    expect(await openCredentials({ DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY }, row!.credentials)).toMatchObject({ accessToken: 'gl-access' });
    expect(row!.verifiedAt).not.toBeNull();
    const [claimed] = await db.select().from(schema.mergePullRequests).where(eq(schema.mergePullRequests.id, mine.id));
    expect(claimed!.authorUserId).toBe(BOB);
    const [untouched] = await db.select().from(schema.mergePullRequests).where(eq(schema.mergePullRequests.id, other.id));
    expect(untouched!.authorUserId).toBeNull();
  });

  it('links GitHub through the App\'s user authorization', async () => {
    const kv = fakeKv();
    const calls = stubHttp({
      'POST github.com/login/oauth/access_token': { access_token: 'ghu_token', token_type: 'bearer', expires_in: 28800, refresh_token: 'ghr_token' },
      'GET api.github.com/user': { id: 77, login: 'Octo-Dev', name: 'Octo', avatar_url: 'https://gh/o.png' },
    });
    const state = await start(kv, '/accounts/github/authorize-url', MEMBER, BOB);
    await ok<MergeOauthCallbackResult>(await post(app(kv, MEMBER, BOB), '/oauth/callback', { code: 'gh-code', state }));
    expect(calls[0]).toEqual({
      method: 'POST',
      url: 'github.com/login/oauth/access_token',
      body: { client_id: 'gh-client', client_secret: 'gh-secret', code: 'gh-code', redirect_uri: 'https://app.test/weldmerge/oauth/callback' },
      auth: undefined,
    });
    expect(calls[1]).toMatchObject({ method: 'GET', url: 'api.github.com/user', auth: 'bearer ghu_token' });
    const [row] = await db.select().from(schema.mergeProviderAccounts);
    expect(row).toMatchObject({ provider: 'github', login: 'octo-dev', externalUserId: '77', host: null });
    expect(row!.verifiedAt).not.toBeNull();
  });

  it('turns a typed GitHub login into a verified one when the same login links', async () => {
    const kv = fakeKv();
    await db.insert(schema.mergeProviderAccounts).values({ id: 'mpa_typed', userId: BOB, provider: 'github', login: 'octo-dev' });
    stubHttp({
      'POST github.com/login/oauth/access_token': { access_token: 'ghu_token' },
      'GET api.github.com/user': { id: 77, login: 'Octo-Dev' },
    });
    const state = await start(kv, '/accounts/github/authorize-url', MEMBER, BOB);
    await ok<MergeOauthCallbackResult>(await post(app(kv, MEMBER, BOB), '/oauth/callback', { code: 'c', state }));
    const rows = await db.select().from(schema.mergeProviderAccounts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'mpa_typed', verifiedAt: expect.any(Date) });
  });

  it('answers 409 when another member already holds the login', async () => {
    const kv = fakeKv();
    await db.insert(schema.mergeProviderAccounts).values({ id: 'mpa_alice', userId: ALICE, provider: 'gitlab', login: 'bob-gl' });
    stubHttp({ 'POST gitlab.com/oauth/token': GITLAB_TOKEN, 'GET gitlab.com/api/v4/user': { id: 9, username: 'Bob-GL' } });
    const state = await start(kv, '/accounts/gitlab/authorize-url', MEMBER, BOB);
    const res = await post(app(kv, MEMBER, BOB), '/oauth/callback', { code: 'c', state });
    expect(res.status).toBe(409);
    expect(await db.select().from(schema.mergeProviderAccounts)).toHaveLength(1);
  });
});

describe('self-managed GitLab with a token', () => {
  const HOST = 'https://git.example.com';

  it('connects the workspace: validates the token, stores it sealed on a host connection', async () => {
    const calls = stubHttp({ 'GET git.example.com/api/v4/user': { id: 7, username: 'Deploy-Bot' } });
    clearEvents();
    const res = await post(app(fakeKv()), '/connections/gitlab', { host: `${HOST}/`, token: 'glpat-secret' });
    const dto = await ok<MergeConnectionDto>(res, 201);
    expect(dto).toMatchObject({
      provider: 'gitlab',
      host: HOST,
      externalAccountId: 'git.example.com:7',
      accountLogin: 'deploy-bot',
      status: 'active',
      oauthUserLogin: 'deploy-bot',
    });
    expect(JSON.stringify(dto)).not.toContain('glpat-secret');
    expect(calls).toEqual(perRun([{ method: 'GET', url: 'git.example.com/api/v4/user', auth: 'bearer glpat-secret' }]));
    const [row] = await db.select().from(schema.mergeConnections);
    expect(row!.credentials).not.toContain('glpat-secret');
    expect(await openCredentials({ DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY }, row!.credentials)).toEqual({ accessToken: 'glpat-secret', tokenType: 'Bearer' });
    expect(row!.credentialsExpireAt).toBeNull();
    expect(eventTypes()).toEqual(['merge_connection:created']);

    stubHttp({ 'GET git.example.com/api/v4/user': { id: 7, username: 'Deploy-Bot' } });
    clearEvents();
    await ok<MergeConnectionDto>(await post(app(fakeKv()), '/connections/gitlab', { host: HOST, token: 'glpat-new' }), 200);
    expect(await db.select().from(schema.mergeConnections)).toHaveLength(1);
    expect(eventTypes()).toEqual(['merge_connection:updated']);
  });

  it('refuses a token GitLab rejects and a host that is not https, 403 without manage, 400 without a token', async () => {
    stubHttp({ 'GET git.example.com/api/v4/user': failure(401, { message: '401 Unauthorized' }) });
    expect((await post(app(fakeKv()), '/connections/gitlab', { host: HOST, token: 'bad' })).status).toBe(422);
    expect((await post(app(fakeKv()), '/connections/gitlab', { host: 'http://git.example.com', token: 'x' })).status).toBe(422);
    expect((await post(app(fakeKv(), MEMBER), '/connections/gitlab', { host: HOST, token: 'x' })).status).toBe(403);
    expect((await post(app(fakeKv()), '/connections/gitlab', { host: HOST })).status).toBe(400);
    expect(await db.select().from(schema.mergeConnections)).toEqual([]);
  });

  it('answers 502 when the host cannot be reached or fails', async () => {
    stubHttp({ 'GET git.example.com/api/v4/user': failure(500, { message: 'boom' }) });
    expect((await post(app(fakeKv()), '/connections/gitlab', { host: HOST, token: 'x' })).status).toBe(502);
  });

  it('links a member\'s personal token, and unlinks it', async () => {
    stubHttp({ 'GET git.example.com/api/v4/user': { id: 8, username: 'Bob-Self', name: 'Bob', avatar_url: null } });
    const linked = await ok<MergeProviderAccountsDto>(await post(app(fakeKv(), MEMBER, BOB), '/accounts/gitlab-token', { host: HOST, token: 'glpat-bob' }), 201);
    expect(linked.accounts).toEqual([
      { id: expect.stringMatching(/^mpa_/), provider: 'gitlab', host: HOST, login: 'bob-self', verified: true, avatarUrl: null, displayName: 'Bob' },
    ]);
    expect(events).toEqual([]);

    const gone = await app(fakeKv(), MEMBER, BOB).request(`/api/merge/accounts/gitlab?host=${encodeURIComponent(HOST)}`, { method: 'DELETE' });
    expect(gone.status).toBe(204);
    expect(await db.select().from(schema.mergeProviderAccounts)).toEqual([]);
    const again = await app(fakeKv(), MEMBER, BOB).request(`/api/merge/accounts/gitlab?host=${encodeURIComponent(HOST)}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
  });

  it('only lets a member unlink their own account', async () => {
    await db.insert(schema.mergeProviderAccounts).values({ id: 'mpa_alice', userId: ALICE, provider: 'bitbucket', login: 'alice-bb' });
    const res = await app(fakeKv(), MEMBER, BOB).request('/api/merge/accounts/bitbucket', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(await db.select().from(schema.mergeProviderAccounts)).toHaveLength(1);
    expect((await app(fakeKv(), MEMBER, ALICE).request('/api/merge/accounts/bitbucket', { method: 'DELETE' })).status).toBe(204);
  });
});
