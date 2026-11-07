/**
 * DB-backed tests for GitLab, Bitbucket and Azure DevOps repositories: listing
 * what a connection can see, adding (webhook registered with a fresh key and
 * secret, index row written, pull requests backfilled), refreshing and
 * removing, on a real tenant schema (pglite) and a master schema for the
 * provider index, with every provider API stubbed by method and URL.
 * What must not regress:
 *   1. Adding registers the provider's hook with `${WEBHOOK_BASE_URL}/webhooks/
 *      merge/<provider>/<key>` and a fresh secret, stores key, hook id and the
 *      sealed secret, and writes the master index row (workspaces.id).
 *   2. A hook the provider refuses leaves nothing tracked (no row, no index).
 *   3. Removing the repository (or its connection) deletes the hook and the
 *      index row; a hook already gone is no error.
 *   4. The backfill mirrors pull requests of the provider and moves no issue.
 *   5. A connection whose credentials are gone is a 409, a provider failure 502.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { masterSchema, schema, type Database } from '@weldsuite/worker-kit/db';
import { conformanceMasterDb } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type {
  MergeAvailableRepository,
  MergeRepositoryDto,
  MergeRepositorySyncResult,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import connectionsRoutes from '../connections';
import repositoriesRoutes from './index';
import { decryptField, keyringFromEnv } from '@weldsuite/db/lib/crypto';
import { sealCredentials } from '../../services/credentials';
import { ADMIN, MEMBER, clearEvents, errorCode, eventTypes, jsonInit, makeApp, ok, openDb, perRun, resetTables } from '../../test/helpers';
import { failure, stubHttp } from '../../test/fake-http';
import { azurePr, AZURE_REPO } from '../../test/fake-azure-devops';
import { bitbucketPr, BITBUCKET_REPO } from '../../test/fake-bitbucket';
import { gitlabMr, GITLAB_PROJECT } from '../../test/fake-gitlab';
import { compose, ENCRYPTION_KEY, PROVIDER_ENV, providerEnv } from '../../test/provider-env';
import { seedConnection, seedIssue, seedRepository, seedTeam } from '../../test/seed';
import type { Env } from '../../types';

const holder = vi.hoisted(() => ({ masterDb: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getMasterDb: () => conformanceMasterDb(holder.masterDb),
}));

let db: Database;
let master: Awaited<ReturnType<typeof createMasterPgliteDb>>['db'];
const sealEnv = PROVIDER_ENV as unknown as Env;
const KEYRING = keyringFromEnv({ DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY });

beforeAll(async () => {
  db = await openDb();
  master = (await createMasterPgliteDb()).db;
  holder.masterDb = master;
}, 120_000);

beforeEach(async () => {
  await resetTables(db);
  await master.delete(masterSchema.mergeProviderIndex);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const router = compose([
  ['/connections', connectionsRoutes],
  ['/repositories', repositoriesRoutes],
]);
const app = (grants = ADMIN) => makeApp(db, '/api/merge', router, { grants, env: providerEnv(), masterDb: master });
const get = (path: string) => app().request(`/api/merge${path}`);
const post = (path: string, body: unknown, grants = ADMIN) => app(grants).request(`/api/merge${path}`, jsonInit(body));
const del = (path: string) => app().request(`/api/merge${path}`, { method: 'DELETE' });

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const indexRows = () => master.select().from(masterSchema.mergeProviderIndex);
const secretOf = async (sealed: string | null) => decryptField(sealed!, KEYRING);

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

async function gitlabConnection(overrides: Partial<typeof schema.mergeConnections.$inferInsert> = {}) {
  return seedConnection(db, {
    provider: 'gitlab',
    externalAccountId: '42',
    accountLogin: 'alice-gl',
    credentials: await sealCredentials(sealEnv, { accessToken: 'gl-token', tokenType: 'Bearer' }),
    ...overrides,
  });
}

function gitlabApi(extra: Record<string, unknown> = {}) {
  return stubHttp({
    'GET gitlab.com/api/v4/projects': [GITLAB_PROJECT],
    'GET gitlab.com/api/v4/projects/55': GITLAB_PROJECT,
    'POST gitlab.com/api/v4/projects/55/hooks': { id: 321 },
    'DELETE gitlab.com/api/v4/projects/55/hooks/321': null,
    'GET gitlab.com/api/v4/projects/55/merge_requests': ({ url }: { url: URL }) => {
      switch (url.searchParams.get('state')) {
        case 'opened':
          return [gitlabMr({ iid: 1, title: 'Fix tabs', source: 'plat-1-fix-tabs', author: 'Octo-Dev', reviewers: ['Reviewer-One'], updatedAt: daysAgo(1) })];
        case 'merged':
          return [gitlabMr({ iid: 2, title: 'Ship it', state: 'merged', updatedAt: daysAgo(3) })];
        default:
          return [];
      }
    },
    ...extra,
  });
}

describe('GitLab', () => {
  it('lists the projects the connection can administer, marking the ones already tracked', async () => {
    const connection = await gitlabConnection();
    await seedRepository(db, connection.id, { provider: 'gitlab', externalId: '55', fullName: 'acme/web' });
    const calls = gitlabApi({ 'GET gitlab.com/api/v4/projects': [GITLAB_PROJECT, { ...GITLAB_PROJECT, id: 56, path_with_namespace: 'acme/api', visibility: 'public', default_branch: null, web_url: null }] });

    const rows = await ok<MergeAvailableRepository[]>(await get(`/connections/${connection.id}/available-repositories`));
    expect(rows).toEqual([
      { externalId: '55', fullName: 'acme/web', private: true, defaultBranch: 'main', url: 'https://gitlab.com/acme/web', externalProject: 'acme', added: true },
      { externalId: '56', fullName: 'acme/api', private: false, defaultBranch: null, url: null, externalProject: 'acme', added: false },
    ]);
    expect(calls).toEqual(
      perRun([
        {
          method: 'GET',
          url: 'gitlab.com/api/v4/projects?membership=true&min_access_level=40&order_by=last_activity_at&per_page=100&page=1',
          auth: 'bearer gl-token',
        },
      ]),
    );
  });

  it('adds a project: registers the hook, stores key and sealed secret, indexes the key, mirrors the merge requests, moves no issue', async () => {
    const team = await seedTeam(db, 'PLAT');
    const issue = await seedIssue(db, team.id, 1, { status: 'todo' });
    const connection = await gitlabConnection();
    const calls = gitlabApi();
    clearEvents();

    const result = await ok<{ repository: MergeRepositoryDto; pullRequestsSynced: number; linksCreated: number }>(
      await post('/repositories', { connectionId: connection.id, externalId: '55', externalProject: 'acme', teamId: team.id }),
      201,
    );
    expect(result).toMatchObject({
      repository: { provider: 'gitlab', externalId: '55', fullName: 'acme/web', externalProject: 'acme', private: true, openPullRequestCount: 1 },
      pullRequestsSynced: 2,
      linksCreated: 1,
    });

    const [row] = await db.select().from(schema.mergeRepositories);
    expect(row!.webhookKey).toMatch(/^[A-Za-z0-9]{40}$/);
    expect(row!.webhookId).toBe('321');
    const secret = await secretOf(row!.webhookSecret);
    expect(secret).toMatch(/^[A-Za-z0-9]{48}$/);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(row!.webhookKey!);

    const index = await indexRows();
    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({ provider: 'gitlab', kind: 'webhook', externalKey: row!.webhookKey, workspaceId: 'ws_alpha' });

    // The last registration is the one whose key and secret were stored (conformance mode makes one per backend).
    const hookCall = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/hooks')).at(-1)!;
    expect(hookCall).toEqual({
      method: 'POST',
      url: 'gitlab.com/api/v4/projects/55/hooks',
      auth: 'bearer gl-token',
      body: {
        url: `https://hooks.test/webhooks/merge/gitlab/${row!.webhookKey}`,
        token: secret,
        merge_requests_events: true,
        issues_events: true,
        note_events: true,
        pipeline_events: true,
        push_events: false,
        enable_ssl_verification: true,
      },
    });
    expect(calls.map((c) => `${c.method} ${c.url.split('?')[0]}`)).toEqual(
      perRun([
        'GET gitlab.com/api/v4/projects/55',
        'POST gitlab.com/api/v4/projects/55/hooks',
        'GET gitlab.com/api/v4/projects/55/merge_requests',
        'GET gitlab.com/api/v4/projects/55/merge_requests',
        'GET gitlab.com/api/v4/projects/55/merge_requests',
      ]),
    );
    const states = calls.filter((c) => c.url.includes('/merge_requests')).map((c) => c.url);
    expect(states[0]).toBe('gitlab.com/api/v4/projects/55/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=100&page=1');
    expect(states[1]).toMatch(/state=merged&updated_after=.+&order_by=updated_at&sort=desc&per_page=100&page=1$/);
    expect(states[2]).toMatch(/state=closed&updated_after=/);

    const prs = await db.select().from(schema.mergePullRequests).orderBy(schema.mergePullRequests.number);
    expect(prs.map((p) => [p.provider, p.number, p.state, p.authorLogin, p.headRef])).toEqual([
      ['gitlab', 1, 'open', 'octo-dev', 'plat-1-fix-tabs'],
      ['gitlab', 2, 'merged', 'octo-dev', 'feature/2'],
    ]);
    expect(prs[0]!.requestedReviewers).toEqual([{ kind: 'user', login: 'reviewer-one', avatarUrl: null, userId: null }]);
    // The backfill linked PLAT-1 but must not move the issue.
    const [still] = await db.select().from(schema.mergeIssues).where(eq(schema.mergeIssues.id, issue.id));
    expect(still!.status).toBe('todo');
    expect(eventTypes()).toEqual(['merge_repository:created', 'merge_pull_request:created', 'merge_pull_request:created']);
  });

  it('refuses a hook the provider rejects with 502 and leaves nothing tracked', async () => {
    const connection = await gitlabConnection();
    gitlabApi({ 'POST gitlab.com/api/v4/projects/55/hooks': failure(403, { message: '403 Forbidden' }) });
    const res = await post('/repositories', { connectionId: connection.id, externalId: '55' });
    expect(res.status).toBe(502);
    expect(await errorCode(res)).toBe('provider_error');
    expect(await db.select().from(schema.mergeRepositories)).toEqual([]);
    expect(await indexRows()).toEqual([]);
  });

  it('answers 404 for a project the connection cannot see, 409 for a tracked one, 403 for a member', async () => {
    const connection = await gitlabConnection();
    gitlabApi({ 'GET gitlab.com/api/v4/projects/99': failure(404) });
    expect((await post('/repositories', { connectionId: connection.id, externalId: '99' })).status).toBe(404);
    expect((await post('/repositories', { connectionId: connection.id, externalId: '55' }, MEMBER)).status).toBe(403);
    expect((await post('/repositories', { connectionId: connection.id, externalId: '55' })).status).toBe(201);
    expect((await post('/repositories', { connectionId: connection.id, externalId: '55' })).status).toBe(409);
  });

  it('answers 409 when the connection has no usable credentials', async () => {
    const connection = await gitlabConnection({ credentials: null });
    const calls = gitlabApi();
    const res = await post('/repositories', { connectionId: connection.id, externalId: '55' });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('connection_needs_attention');
    expect(calls).toEqual([]);
  });

  it('refreshes: reads the merge requests again and updates what changed', async () => {
    const connection = await gitlabConnection();
    gitlabApi();
    const added = await ok<{ repository: MergeRepositoryDto }>(await post('/repositories', { connectionId: connection.id, externalId: '55' }), 201);
    clearEvents();
    gitlabApi({
      'GET gitlab.com/api/v4/projects/55/merge_requests': ({ url }: { url: URL }) =>
        url.searchParams.get('state') === 'opened' ? [gitlabMr({ iid: 1, title: 'Fix tabs (renamed)', updatedAt: new Date().toISOString() })] : [],
    });
    const result = await ok<MergeRepositorySyncResult>(await post(`/repositories/${added.repository.id}/sync`, {}));
    expect(result.pullRequestsSynced).toBe(1);
    const [pr] = await db.select().from(schema.mergePullRequests).where(eq(schema.mergePullRequests.number, 1));
    expect(pr!.title).toBe('Fix tabs (renamed)');
    expect(eventTypes()).toEqual(['merge_pull_request:updated']);
  });

  it('removes the repository: deletes the hook and the index row, and tolerates a hook that is already gone', async () => {
    const connection = await gitlabConnection();
    gitlabApi();
    const added = await ok<{ repository: MergeRepositoryDto }>(await post('/repositories', { connectionId: connection.id, externalId: '55' }), 201);
    expect(await indexRows()).toHaveLength(1);
    clearEvents();

    const calls = gitlabApi();
    expect((await del(`/repositories/${added.repository.id}`)).status).toBe(204);
    expect(calls).toEqual(perRun([{ method: 'DELETE', url: 'gitlab.com/api/v4/projects/55/hooks/321', auth: 'bearer gl-token' }]));
    expect(await indexRows()).toEqual([]);
    expect(eventTypes()).toEqual(['merge_repository:deleted']);
    const [row] = await db.select().from(schema.mergeRepositories);
    expect(row!.deletedAt).not.toBeNull();

    // Again on a second repository, the hook is already gone at GitLab.
    const second = await seedRepository(db, connection.id, { provider: 'gitlab', externalId: '56', fullName: 'acme/api', webhookKey: 'k'.repeat(40), webhookId: '999' });
    await master.insert(masterSchema.mergeProviderIndex).values({ id: 'mpi_x', provider: 'gitlab', kind: 'webhook', externalKey: 'k'.repeat(40), workspaceId: 'ws_alpha' });
    stubHttp({ 'DELETE gitlab.com/api/v4/projects/56/hooks/999': failure(404) });
    expect((await del(`/repositories/${second.id}`)).status).toBe(204);
    expect(await indexRows()).toEqual([]);
  });

  it('removes the hooks of a connection\'s repositories when the connection is removed', async () => {
    const connection = await gitlabConnection();
    gitlabApi();
    await ok(await post('/repositories', { connectionId: connection.id, externalId: '55' }), 201);
    const calls = gitlabApi();
    expect((await del(`/connections/${connection.id}`)).status).toBe(204);
    expect(calls).toEqual(perRun([{ method: 'DELETE', url: 'gitlab.com/api/v4/projects/55/hooks/321', auth: 'bearer gl-token' }]));
    expect(await indexRows()).toEqual([]);
  });

  it('works against a self-managed host', async () => {
    const connection = await gitlabConnection({ host: 'https://git.example.com', externalAccountId: 'git.example.com:7' });
    const calls = stubHttp({ 'GET git.example.com/api/v4/projects': [{ ...GITLAB_PROJECT, web_url: 'https://git.example.com/acme/web' }] });
    const rows = await ok<MergeAvailableRepository[]>(await get(`/connections/${connection.id}/available-repositories`));
    expect(rows[0]).toMatchObject({ externalId: '55', url: 'https://git.example.com/acme/web' });
    expect(calls[0]!.url.startsWith('git.example.com/api/v4/projects?')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bitbucket Cloud
// ---------------------------------------------------------------------------

describe('Bitbucket Cloud', () => {
  const connection = async () =>
    seedConnection(db, {
      provider: 'bitbucket',
      externalAccountId: '{user-1}',
      credentials: await sealCredentials(sealEnv, { accessToken: 'bb-token' }),
    });

  const api = (extra: Record<string, unknown> = {}) =>
    stubHttp({
      'GET api.bitbucket.org/2.0/repositories': { values: [BITBUCKET_REPO] },
      'GET api.bitbucket.org/2.0/repositories/acme/%7Brepo-uuid-1%7D': BITBUCKET_REPO,
      'POST api.bitbucket.org/2.0/repositories/acme/web/hooks': { uuid: '{hook-1}' },
      'DELETE api.bitbucket.org/2.0/repositories/acme/web/hooks/%7Bhook-1%7D': null,
      'GET api.bitbucket.org/2.0/repositories/acme/web/pullrequests': ({ url }: { url: URL }) =>
        url.searchParams.get('state') === 'OPEN'
          ? { values: [bitbucketPr({ id: 31, title: 'Restrict tabs', reviewers: ['TJanssen'], updatedOn: daysAgo(1) })] }
          : { values: [bitbucketPr({ id: 30, state: 'MERGED', updatedOn: daysAgo(2) }), bitbucketPr({ id: 20, state: 'MERGED', updatedOn: daysAgo(60) })] },
      ...extra,
    });

  it('lists, adds with a signed-hook registration, and removes', async () => {
    const conn = await connection();
    let calls = api();
    const rows = await ok<MergeAvailableRepository[]>(await get(`/connections/${conn.id}/available-repositories`));
    expect(rows).toEqual([
      { externalId: '{repo-uuid-1}', fullName: 'acme/web', private: true, defaultBranch: 'main', url: 'https://bitbucket.org/acme/web', externalProject: 'acme', added: false },
    ]);
    expect(calls).toEqual(perRun([{ method: 'GET', url: 'api.bitbucket.org/2.0/repositories?role=admin&pagelen=50', auth: 'bearer bb-token' }]));

    calls = api();
    const added = await ok<{ repository: MergeRepositoryDto; pullRequestsSynced: number }>(
      await post('/repositories', { connectionId: conn.id, externalId: '{repo-uuid-1}', externalProject: 'acme' }),
      201,
    );
    // The merge request older than 30 days is outside the backfill window.
    expect(added.pullRequestsSynced).toBe(2);
    expect(added.repository).toMatchObject({ provider: 'bitbucket', fullName: 'acme/web', externalProject: 'acme' });

    const [row] = await db.select().from(schema.mergeRepositories);
    expect(row).toMatchObject({ externalId: '{repo-uuid-1}', webhookId: '{hook-1}' });
    const secret = await secretOf(row!.webhookSecret);
    const hook = calls.filter((c) => c.method === 'POST').at(-1)!;
    expect(hook.body).toEqual({
      description: 'WeldMerge',
      url: `https://hooks.test/webhooks/merge/bitbucket/${row!.webhookKey}`,
      active: true,
      secret,
      events: expect.arrayContaining(['pullrequest:created', 'pullrequest:fulfilled', 'repo:commit_status_updated']),
    });
    expect(await indexRows()).toMatchObject([{ provider: 'bitbucket', kind: 'webhook', externalKey: row!.webhookKey }]);
    const prs = await db.select().from(schema.mergePullRequests).orderBy(schema.mergePullRequests.number);
    expect(prs.map((p) => [p.number, p.state, p.authorLogin])).toEqual([[30, 'merged', 'octo-dev'], [31, 'open', 'octo-dev']]);
    expect(prs[1]!.requestedReviewers).toMatchObject([{ kind: 'user', login: 'tjanssen' }]);

    calls = api();
    expect((await del(`/repositories/${added.repository.id}`)).status).toBe(204);
    expect(calls).toEqual(perRun([{ method: 'DELETE', url: 'api.bitbucket.org/2.0/repositories/acme/web/hooks/%7Bhook-1%7D', auth: 'bearer bb-token' }]));
    expect(await indexRows()).toEqual([]);
  });

  it('refuses issue sync modes other than off (422)', async () => {
    const conn = await connection();
    const repo = await seedRepository(db, conn.id, { provider: 'bitbucket', externalId: '{repo-uuid-1}', fullName: 'acme/web' });
    const res = await app().request(`/api/merge/repositories/${repo.id}`, jsonInit({ issueSync: 'import' }, 'PATCH'));
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Azure DevOps
// ---------------------------------------------------------------------------

describe('Azure DevOps', () => {
  const connection = async (overrides: Partial<typeof schema.mergeConnections.$inferInsert> = {}) =>
    seedConnection(db, {
      provider: 'azure_devops',
      externalAccountId: 'acme',
      host: 'https://dev.azure.com/acme',
      credentials: await sealCredentials(sealEnv, { accessToken: 'az-token' }),
      ...overrides,
    });

  const REPO_PATH = 'dev.azure.com/acme/Platform/_apis/git/repositories/repo-guid-1';

  const api = (extra: Record<string, unknown> = {}) =>
    stubHttp({
      'GET dev.azure.com/acme/_apis/git/repositories': { value: [AZURE_REPO, { ...AZURE_REPO, id: 'disabled', isDisabled: true }] },
      'GET dev.azure.com/acme/_apis/git/repositories/repo-guid-1': AZURE_REPO,
      'POST dev.azure.com/acme/_apis/hooks/subscriptions': ({ body }: { body: unknown }) => ({ id: `sub-${(body as { eventType: string }).eventType.split('.').pop()}` }),
      'DELETE dev.azure.com/acme/_apis/hooks/subscriptions/sub-created': null,
      'DELETE dev.azure.com/acme/_apis/hooks/subscriptions/sub-updated': null,
      'DELETE dev.azure.com/acme/_apis/hooks/subscriptions/sub-merged': null,
      [`GET ${REPO_PATH}/pullrequests`]: ({ url }: { url: URL }) => {
        switch (url.searchParams.get('searchCriteria.status')) {
          case 'active':
            return { value: [azurePr({ id: 77, title: 'Restrict tabs', reviewers: [['TJanssen@acme.com', 0]] })] };
          case 'completed':
            return { value: [azurePr({ id: 70, status: 'completed', closedDate: daysAgo(2) })] };
          default:
            return { value: [] };
        }
      },
      ...extra,
    });

  it('lists the organisation\'s repositories, leaving disabled ones out', async () => {
    const conn = await connection();
    const calls = api();
    const rows = await ok<MergeAvailableRepository[]>(await get(`/connections/${conn.id}/available-repositories`));
    expect(rows).toEqual([
      { externalId: 'repo-guid-1', fullName: 'Platform/web', private: true, defaultBranch: 'main', url: 'https://dev.azure.com/acme/Platform/_git/web', externalProject: 'Platform', added: false },
    ]);
    expect(calls).toEqual(perRun([{ method: 'GET', url: 'dev.azure.com/acme/_apis/git/repositories?api-version=7.1', auth: 'bearer az-token' }]));
  });

  it('adds with three service-hook subscriptions, mirrors the pull requests, and removes all three', async () => {
    const conn = await connection();
    let calls = api();
    const added = await ok<{ repository: MergeRepositoryDto; pullRequestsSynced: number }>(
      await post('/repositories', { connectionId: conn.id, externalId: 'repo-guid-1', externalProject: 'Platform' }),
      201,
    );
    expect(added.pullRequestsSynced).toBe(2);

    const [row] = await db.select().from(schema.mergeRepositories);
    expect(row).toMatchObject({ externalProject: 'Platform', fullName: 'Platform/web', webhookId: 'sub-created,sub-updated,sub-merged' });
    const secret = await secretOf(row!.webhookSecret);
    // The last three registrations are the ones whose key and secret were stored (one set per backend in conformance mode).
    const subscriptions = calls.filter((c) => c.method === 'POST').slice(-3);
    expect(calls.filter((c) => c.method === 'POST').map((c) => (c.body as { eventType: string }).eventType)).toEqual(
      perRun(['git.pullrequest.created', 'git.pullrequest.updated', 'git.pullrequest.merged']),
    );
    expect(subscriptions[0]!.body).toEqual({
      publisherId: 'tfs',
      eventType: 'git.pullrequest.created',
      resourceVersion: '1.0',
      consumerId: 'webHooks',
      consumerActionId: 'httpRequest',
      publisherInputs: { projectId: 'proj-guid-1', repository: 'repo-guid-1' },
      consumerInputs: { url: `https://hooks.test/webhooks/merge/azure_devops/${row!.webhookKey}`, basicAuthUsername: 'weldmerge', basicAuthPassword: secret },
    });
    expect(await indexRows()).toMatchObject([{ provider: 'azure_devops', kind: 'webhook', externalKey: row!.webhookKey }]);

    const prs = await db.select().from(schema.mergePullRequests).orderBy(schema.mergePullRequests.number);
    expect(prs.map((p) => [p.number, p.state, p.authorLogin, p.url])).toEqual([
      [70, 'merged', 'octo-dev@acme.com', 'https://dev.azure.com/acme/Platform/_git/web/pullrequest/70'],
      [77, 'open', 'octo-dev@acme.com', 'https://dev.azure.com/acme/Platform/_git/web/pullrequest/77'],
    ]);

    calls = api();
    expect((await del(`/repositories/${added.repository.id}`)).status).toBe(204);
    expect(calls.map((c) => `${c.method} ${c.url}`).sort()).toEqual(
      perRun([
        'DELETE dev.azure.com/acme/_apis/hooks/subscriptions/sub-created?api-version=7.1',
        'DELETE dev.azure.com/acme/_apis/hooks/subscriptions/sub-merged?api-version=7.1',
        'DELETE dev.azure.com/acme/_apis/hooks/subscriptions/sub-updated?api-version=7.1',
      ]).sort(),
    );
    expect(await indexRows()).toEqual([]);
  });

  it('takes the subscriptions already created down again when one is refused', async () => {
    const conn = await connection();
    // The third subscription (merged) is refused; answered by body, not call order, so both backends see the same.
    const calls = api({
      'POST dev.azure.com/acme/_apis/hooks/subscriptions': ({ body }: { body: unknown }) => {
        const event = (body as { eventType: string }).eventType.split('.').pop();
        return event === 'merged' ? failure(400, { message: 'subscription limit' }) : { id: `sub-${event}` };
      },
    });
    const res = await post('/repositories', { connectionId: conn.id, externalId: 'repo-guid-1', externalProject: 'Platform' });
    expect(res.status).toBe(502);
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('?')[0])).toEqual(
      perRun(['dev.azure.com/acme/_apis/hooks/subscriptions/sub-created', 'dev.azure.com/acme/_apis/hooks/subscriptions/sub-updated']),
    );
    expect(await db.select().from(schema.mergeRepositories)).toEqual([]);
  });

  it('answers 409 for a connection that has not chosen its organisation yet', async () => {
    const conn = await connection({ host: null, externalAccountId: 'pending:profile-1', status: 'active' });
    stubHttp({});
    const res = await get(`/connections/${conn.id}/available-repositories`);
    expect(res.status).toBe(409);
  });
});
